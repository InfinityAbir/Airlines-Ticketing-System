import { assert, expect } from "chai";
import {
  ethers,
  expectCustomError,
  expectEvent,
  forceTicketState,
  getFactory,
  getSigners,
  latest,
  provider,
  warpTo,
} from "./_helpers.js";

const CID = "bafyairlineticketmetadata000000000000001";
const PRICE = ethers.parseEther("0.1"); // original fare
const CAP = (PRICE * 12000n) / 10000n; // 120% of the original fare
const DAY = 24 * 3600;
const HOUR = 3600;

function flightArgs(code, departure, capacity = 5, royaltyBps = 500) {
  return [
    code,
    "JFK",
    "LHR",
    departure,
    capacity,
    PRICE,
    departure - 7 * 24 * 3600,
    8000, // 80% refund
    royaltyBps,
  ];
}

/// @notice Full production wiring (same order as scripts/deploy.js) for one test.
async function deploy() {
  const [admin, airline, traveler, buyer2, other] = await getSigners();
  const Registry = await getFactory("AirlineRegistry");
  const registry = await Registry.deploy(admin.address);
  await registry.waitForDeployment();
  const Inventory = await getFactory("FlightInventory");
  const inventory = await Inventory.deploy(await registry.getAddress(), admin.address);
  await inventory.waitForDeployment();
  const NFT = await getFactory("AirTicketNFT");
  const nft = await NFT.deploy(
    await registry.getAddress(),
    await inventory.getAddress(),
    admin.address
  );
  await nft.waitForDeployment();
  const Settlement = await getFactory("TicketSettlement");
  const settlement = await Settlement.deploy(
    await registry.getAddress(),
    await inventory.getAddress(),
    await nft.getAddress(),
    admin.address
  );
  await settlement.waitForDeployment();
  const Marketplace = await getFactory("TicketMarketplace");
  const marketplace = await Marketplace.deploy(
    await registry.getAddress(),
    await inventory.getAddress(),
    await nft.getAddress(),
    admin.address
  );
  await marketplace.waitForDeployment();

  await (
    await inventory.setAuthorizedParties(
      await settlement.getAddress(),
      await marketplace.getAddress()
    )
  ).wait();
  await (await nft.setSettlement(await settlement.getAddress())).wait();
  const MARKETPLACE_ROLE = await nft.MARKETPLACE_ROLE();
  await (await nft.grantRole(MARKETPLACE_ROLE, await marketplace.getAddress())).wait();

  await registry.connect(admin).approveAirline(airline.address);
  return { registry, inventory, nft, settlement, marketplace, admin, airline, traveler, buyer2, other };
}

/// @notice Create + publish a flight, returning { flightId, departure, refundDeadline }.
async function publishFlight(ctx, code = "MKT-1", capacity = 5, royaltyBps = 500) {
  const departure = (await latest()) + 30 * 24 * 3600;
  await ctx.inventory.connect(ctx.airline).createFlight(
    flightArgs(code, departure, capacity, royaltyBps)
  );
  const flightId = Number((await ctx.inventory.nextFlightId()) - 1n);
  await ctx.inventory.connect(ctx.airline).publishFlight(flightId);
  return { flightId, departure, refundDeadline: departure - 7 * 24 * 3600 };
}

/// @notice Buy one seat as `buyer` and return the minted tokenId.
async function buyTicket(ctx, flightId, buyer) {
  await (
    await ctx.settlement.connect(buyer).purchase(flightId, CID, { value: PRICE })
  ).wait();
  return Number((await ctx.nft.nextTokenId()) - 1n);
}

/// @notice Convenience: a published flight with one issued ticket owned by the traveler.
async function setup(ctx, code = "MKT-1", royaltyBps = 500) {
  const flight = await publishFlight(ctx, code, 5, royaltyBps);
  const tokenId = await buyTicket(ctx, flight.flightId, ctx.traveler);
  return { ...flight, tokenId };
}

describe("TicketMarketplace skeleton (Phase 1)", function () {
  async function scaffold() {
    const [admin, other] = await getSigners();
    const Registry = await getFactory("AirlineRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();
    const Inventory = await getFactory("FlightInventory");
    const inventory = await Inventory.deploy(await registry.getAddress(), admin.address);
    await inventory.waitForDeployment();
    const NFT = await getFactory("AirTicketNFT");
    const nft = await NFT.deploy(
      await registry.getAddress(),
      await inventory.getAddress(),
      admin.address
    );
    await nft.waitForDeployment();
    const Marketplace = await getFactory("TicketMarketplace");
    const marketplace = await Marketplace.deploy(
      await registry.getAddress(),
      await inventory.getAddress(),
      await nft.getAddress(),
      admin.address
    );
    await marketplace.waitForDeployment();
    return { registry, inventory, nft, marketplace, admin, other };
  }

  it("wires registry/inventory/nft/admin addresses", async function () {
    const { registry, inventory, nft, marketplace, admin } = await scaffold();
    expect(await marketplace.registry()).to.equal(await registry.getAddress());
    expect(await marketplace.inventory()).to.equal(await inventory.getAddress());
    expect(await marketplace.ticketNFT()).to.equal(await nft.getAddress());
    expect(await marketplace.admin()).to.equal(admin.address);
  });

  it("locks R1 constants (120% cap, 24h default duration, 2h check-in)", async function () {
    const { marketplace } = await scaffold();
    expect(await marketplace.RESALE_CAP_BPS()).to.equal(12000n);
    expect(await marketplace.BPS_DENOMINATOR()).to.equal(10000n);
    expect(await marketplace.DEFAULT_LISTING_DURATION()).to.equal(BigInt(DAY));
    expect(await marketplace.CHECKIN_WINDOW()).to.equal(BigInt(2 * HOUR));
    expect(await marketplace.nextListingId()).to.equal(1n);
  });

  it("unknown listings revert; local pause is admin-only", async function () {
    const { marketplace, other } = await scaffold();
    await expectCustomError(marketplace.getListing(0), marketplace, "UnknownListing__id");
    await expectCustomError(marketplace.getListing(99), marketplace, "UnknownListing__id");
    await expectCustomError(marketplace.connect(other).pause(), marketplace, "NotAdmin__caller");
    await marketplace.pause();
    expect(await marketplace.paused()).to.equal(true);
    await marketplace.unpause();
    expect(await marketplace.paused()).to.equal(false);
  });
});

describe("TicketMarketplace list (Phase 4)", function () {
  it("lists an owned Issued ticket: event, record, window and Listed state", async function () {
    const ctx = await deploy();
    const { flightId, departure, tokenId } = await setup(ctx);

    const expiresAt = (await latest()) + DAY;
    const ev = await expectEvent(
      ctx.marketplace.connect(ctx.traveler).list(tokenId, CAP, expiresAt),
      ctx.marketplace,
      "ListingCreated"
    );
    assert.equal(ev.args.listingId, 1n);
    assert.equal(ev.args.tokenId, BigInt(tokenId));
    assert.equal(ev.args.seller, ctx.traveler.address);
    assert.equal(ev.args.priceWei, CAP);
    assert.equal(ev.args.expiresAt, BigInt(expiresAt));

    const listing = await ctx.marketplace.getListing(1);
    expect(listing.tokenId).to.equal(BigInt(tokenId));
    expect(listing.seller).to.equal(ctx.traveler.address);
    expect(listing.priceWei).to.equal(CAP);
    expect(listing.active).to.equal(true);
    expect(await ctx.marketplace.activeListingByToken(tokenId)).to.equal(1n);
    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(1n); // Listed
    assert.equal(Number(flightId) > 0, true);
    assert.equal(Number(departure) > 0, true);
  });

  it("rejects a non-owner, an unknown ticket and a zero price", async function () {
    const ctx = await deploy();
    const { tokenId } = await setup(ctx);
    const expiresAt = (await latest()) + DAY;

    await expectCustomError(
      ctx.marketplace.connect(ctx.buyer2).list(tokenId, PRICE, expiresAt),
      ctx.marketplace,
      "NotTicketOwner__caller"
    );
    await expectCustomError(
      ctx.marketplace.connect(ctx.traveler).list(999, PRICE, expiresAt),
      [ctx.marketplace, ctx.nft],
      "UnknownTicket__id"
    );
    await expectCustomError(
      ctx.marketplace.connect(ctx.traveler).list(tokenId, 0, expiresAt),
      ctx.marketplace,
      "ZeroPrice__"
    );
  });

  it("rejects terminal states and a second listing for the same ticket", async function () {
    const ctx = await deploy();
    const { flightId, departure, tokenId } = await setup(ctx);
    const expiresAt = (await latest()) + DAY;

    // Cancelled(2), Refunded(3), Used(4), Invalid(5) are all non-listable.
    for (const state of [2, 3, 4, 5]) {
      await forceTicketState(
        await ctx.nft.getAddress(),
        tokenId,
        flightId,
        ctx.traveler.address,
        state
      );
      await expectCustomError(
        ctx.marketplace.connect(ctx.traveler).list(tokenId, PRICE, expiresAt),
        ctx.marketplace,
        "InvalidState__state"
      );
      // Restore to Issued for the next pass.
      await forceTicketState(
        await ctx.nft.getAddress(),
        tokenId,
        flightId,
        ctx.traveler.address,
        0
      );
    }

    await (
      await ctx.marketplace.connect(ctx.traveler).list(tokenId, PRICE, expiresAt)
    ).wait();
    await expectCustomError(
      ctx.marketplace.connect(ctx.traveler).list(tokenId, PRICE, expiresAt),
      ctx.marketplace,
      "AlreadyListed__tokenId"
    );
    assert.equal(Number(await ctx.marketplace.nextListingId()), 2);
    assert.equal(Number(departure) > 0, true);
  });

  it("rejects listing after the refund deadline, after departure and on a cancelled flight", async function () {
    const ctx = await deploy();
    const { flightId, refundDeadline, departure, tokenId } = await setup(ctx);
    const expiresAt = (await latest()) + DAY;

    await warpTo(refundDeadline + 1);
    await expectCustomError(
      ctx.marketplace.connect(ctx.traveler).list(tokenId, PRICE, expiresAt),
      ctx.marketplace,
      "RefundDeadlinePassed__deadline"
    );

    const fresh = await publishFlight(ctx, "MKT-2");
    const t2 = await buyTicket(ctx, fresh.flightId, ctx.traveler);
    await ctx.inventory.connect(ctx.airline).markDeparted(fresh.flightId);
    await expectCustomError(
      ctx.marketplace.connect(ctx.traveler).list(t2, PRICE, (await latest()) + DAY),
      ctx.marketplace,
      "FlightDeparted__id"
    );

    const third = await publishFlight(ctx, "MKT-3");
    const t3 = await buyTicket(ctx, third.flightId, ctx.traveler);
    await ctx.inventory.connect(ctx.airline).cancelFlight(third.flightId);
    await expectCustomError(
      ctx.marketplace.connect(ctx.traveler).list(t3, PRICE, (await latest()) + DAY),
      ctx.marketplace,
      "FlightCancelled__id"
    );
    assert.equal(Number(departure) > 0, true);
    assert.equal(Number(flightId) > 0, true);
  });

  it("enforces the 120% resale price cap", async function () {
    const ctx = await deploy();
    const { tokenId } = await setup(ctx);
    const expiresAt = (await latest()) + DAY;

    await expectCustomError(
      ctx.marketplace.connect(ctx.traveler).list(tokenId, CAP + 1n, expiresAt),
      ctx.marketplace,
      "ResaleCapExceeded__price"
    );
    const ev = await expectEvent(
      ctx.marketplace.connect(ctx.traveler).list(tokenId, CAP, expiresAt),
      ctx.marketplace,
      "ListingCreated"
    );
    assert.equal(ev.args.priceWei, CAP);
  });

  it("enforces the expiry window: in the past or beyond departure minus 2h", async function () {
    const ctx = await deploy();
    const { departure, tokenId } = await setup(ctx);
    const now = await latest();

    await expectCustomError(
      ctx.marketplace.connect(ctx.traveler).list(tokenId, PRICE, now - 1),
      ctx.marketplace,
      "ExpiryInPast__expiresAt"
    );
    await expectCustomError(
      ctx.marketplace.connect(ctx.traveler).list(tokenId, PRICE, departure - HOUR),
      ctx.marketplace,
      "ExpiryPastCheckin__expiresAt"
    );
    // Exactly at the check-in bound is allowed (boundary rule: `expiresAt <= departure - 2h`).
    const atBound = departure - 2 * HOUR;
    await expectEvent(
      ctx.marketplace.connect(ctx.traveler).list(tokenId, PRICE, atBound),
      ctx.marketplace,
      "ListingCreated"
    );
    const listing = await ctx.marketplace.getListing(1);
    expect(listing.expiresAt).to.equal(BigInt(atBound));
  });

  it("rejects a royalty above the platform cap at flight level and at listing time", async function () {
    const ctx = await deploy();
    const departure = (await latest()) + 30 * 24 * 3600;

    // Flight-level (FR-08): royaltyBps must be <= maxRoyaltyBps (1000 = 10%).
    await expectCustomError(
      ctx.inventory.connect(ctx.airline).createFlight(
        flightArgs("CAP-1", departure, 5, 1001)
      ),
      ctx.inventory,
      "RoyaltyAboveCap__bps"
    );

    // Marketplace-level: a flight created within the old cap cannot resell once the cap drops.
    const { tokenId } = await setup(ctx, "CAP-2", 500);
    await ctx.registry.connect(ctx.admin).setLimits(100, 10000);
    await expectCustomError(
      ctx.marketplace.connect(ctx.traveler).list(tokenId, PRICE, (await latest()) + DAY),
      ctx.marketplace,
      "RoyaltyAboveCap__bps"
    );
  });

  it("is blocked by the registry pause and by the local marketplace pause", async function () {
    const ctx = await deploy();
    const { tokenId } = await setup(ctx);
    const expiresAt = (await latest()) + DAY;

    await ctx.registry.connect(ctx.admin).pause();
    await expectCustomError(
      ctx.marketplace.connect(ctx.traveler).list(tokenId, PRICE, expiresAt),
      ctx.marketplace,
      "PlatformPaused__"
    );
    // NFT-side defence in depth: `markListed` also refuses while the registry is paused.
    // (admin is granted the role so this asserts the pause guard, not the role guard.)
    await (
      await ctx.nft.grantRole(await ctx.nft.MARKETPLACE_ROLE(), ctx.admin.address)
    ).wait();
    await expectCustomError(
      ctx.nft.connect(ctx.admin).markListed(tokenId),
      ctx.nft,
      "PlatformPaused__"
    );
    await ctx.registry.connect(ctx.admin).unpause();

    await ctx.marketplace.pause();
    await expectCustomError(
      ctx.marketplace.connect(ctx.traveler).list(tokenId, PRICE, expiresAt),
      ctx.marketplace,
      "PlatformPaused__"
    );
    // A seller can always withdraw during a pause.
    await ctx.marketplace.unpause();

    await expectEvent(
      ctx.marketplace.connect(ctx.traveler).list(tokenId, PRICE, expiresAt),
      ctx.marketplace,
      "ListingCreated"
    );
  });

  it("previewResale reports the listing window and the split math", async function () {
    const ctx = await deploy();
    const { departure, tokenId } = await setup(ctx);
    const now = await latest();

    const p = await ctx.marketplace.previewResale(tokenId, PRICE);
    expect(p.airline).to.equal(ctx.airline.address);
    expect(p.royaltyBps).to.equal(500n);
    expect(p.originalPriceWei).to.equal(PRICE);
    expect(p.maxPriceWei).to.equal(CAP);
    expect(p.checkinBound).to.equal(BigInt(departure - 2 * HOUR));
    expect(p.defaultExpiry).to.equal(BigInt(now + DAY)); // 24h window fits well before check-in
    expect(p.royalty).to.equal((PRICE * 500n) / 10000n);
    expect(p.sellerProceeds).to.equal(PRICE - p.royalty);

    await expectCustomError(
      ctx.marketplace.previewResale(999, PRICE),
      [ctx.marketplace, ctx.nft],
      "UnknownTicket__id"
    );
  });
});

describe("TicketMarketplace cancelListing (Phase 4)", function () {
  it("seller withdraws the listing: ticket returns to Issued", async function () {
    const ctx = await deploy();
    const { tokenId } = await setup(ctx);
    const expiresAt = (await latest()) + DAY;
    await (
      await ctx.marketplace.connect(ctx.traveler).list(tokenId, PRICE, expiresAt)
    ).wait();

    const ev = await expectEvent(
      ctx.marketplace.connect(ctx.traveler).cancelListing(1),
      ctx.marketplace,
      "ListingCancelled"
    );
    assert.equal(ev.args.listingId, 1n);

    expect((await ctx.marketplace.getListing(1)).active).to.equal(false);
    expect(await ctx.marketplace.activeListingByToken(tokenId)).to.equal(0n);
    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(0n); // Issued
  });

  it("rejects a non-seller, an unknown id and a repeated cancellation", async function () {
    const ctx = await deploy();
    const { tokenId } = await setup(ctx);
    const expiresAt = (await latest()) + DAY;
    await (
      await ctx.marketplace.connect(ctx.traveler).list(tokenId, PRICE, expiresAt)
    ).wait();

    await expectCustomError(ctx.marketplace.getListing(0), ctx.marketplace, "UnknownListing__id");
    await expectCustomError(
      ctx.marketplace.connect(ctx.buyer2).cancelListing(1),
      ctx.marketplace,
      "NotSeller__caller"
    );
    await (
      await ctx.marketplace.connect(ctx.traveler).cancelListing(1)
    ).wait();
    await expectCustomError(
      ctx.marketplace.connect(ctx.traveler).cancelListing(1),
      ctx.marketplace,
      "ListingNotActive__id"
    );
  });

  it("stays available while the platform is paused, then the ticket can be refunded", async function () {
    const ctx = await deploy();
    const { tokenId } = await setup(ctx);
    const expiresAt = (await latest()) + DAY;
    await (
      await ctx.marketplace.connect(ctx.traveler).list(tokenId, PRICE, expiresAt)
    ).wait();

    await ctx.registry.connect(ctx.admin).pause();
    // Listing/resale are blocked, but withdrawing a listing is a restrictive action.
    await expectCustomError(
      ctx.marketplace.connect(ctx.traveler).list(tokenId, PRICE, expiresAt),
      ctx.marketplace,
      "PlatformPaused__"
    );
    await expectEvent(
      ctx.marketplace.connect(ctx.traveler).cancelListing(1),
      ctx.marketplace,
      "ListingCancelled"
    );
    await ctx.registry.connect(ctx.admin).unpause();

    // Back in `Issued`, so the settlement cancellation path works again.
    await expectEvent(
      ctx.settlement.connect(ctx.traveler).cancel(tokenId),
      ctx.settlement,
      "TicketCancelled"
    );
    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(2n); // Cancelled
  });
});

describe("TicketMarketplace buyListing (Phase 4)", function () {
  async function listed(ctx, priceWei = CAP, code = "BUY-1") {
    const { flightId, departure, refundDeadline, tokenId } = await setup(ctx, code);
    const expiresAt = (await latest()) + DAY;
    await (
      await ctx.marketplace.connect(ctx.traveler).list(tokenId, priceWei, expiresAt)
    ).wait();
    return { flightId, departure, refundDeadline, tokenId, priceWei, expiresAt, listingId: 1 };
  }

  it("splits the payment exactly: royalty to the airline, remainder to the seller", async function () {
    const ctx = await deploy();
    const { tokenId, priceWei } = await listed(ctx);

    const royalty = (priceWei * 500n) / 10000n;
    const proceeds = priceWei - royalty;
    const sellerBefore = await provider.getBalance(ctx.traveler.address);
    const airlineBefore = await provider.getBalance(ctx.airline.address);
    const marketAddr = await ctx.marketplace.getAddress();
    const marketBefore = await provider.getBalance(marketAddr);

    const ev = await expectEvent(
      ctx.marketplace.connect(ctx.buyer2).buyListing(1, { value: priceWei }),
      ctx.marketplace,
      "ListingSold"
    );
    assert.equal(ev.args.listingId, 1n);
    assert.equal(ev.args.tokenId, BigInt(tokenId));
    assert.equal(ev.args.buyer, ctx.buyer2.address);
    assert.equal(ev.args.priceWei, priceWei);
    assert.equal(ev.args.royalty, royalty);
    assert.equal(ev.args.sellerProceeds, proceeds);
    // Rounding rule: the two halves always add back to the full payment.
    expect(ev.args.royalty + ev.args.sellerProceeds).to.equal(priceWei);

    // The seller and the airline only receive funds in this tx, so their deltas are exact.
    expect((await provider.getBalance(ctx.traveler.address)) - sellerBefore).to.equal(proceeds);
    expect((await provider.getBalance(ctx.airline.address)) - airlineBefore).to.equal(royalty);
    // The marketplace is a pass-through: the payment never stays in escrow.
    expect(marketBefore).to.equal(0n);
    expect(await provider.getBalance(marketAddr)).to.equal(0n);

    // Ownership + state move atomically with the payment.
    expect(await ctx.nft.ownerOf(tokenId)).to.equal(ctx.buyer2.address);
    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(0n); // Issued (new owner)
    expect((await ctx.marketplace.getListing(1)).active).to.equal(false);
    expect(await ctx.marketplace.activeListingByToken(tokenId)).to.equal(0n);

    // Sibling rule: settlement accounting is untouched by a resale.
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(PRICE);
  });

  it("rounding rule: royalty floors and the seller takes the remainder (sum == price)", async function () {
    const ctx = await deploy();
    // A price that does not divide evenly by 10000 at 5%.
    const oddPrice = CAP - 1n;
    const { tokenId, priceWei } = await listed(ctx, oddPrice, "ROUND-1");

    const expectedRoyalty = (priceWei * 500n) / 10000n;
    expect(expectedRoyalty * 10000n).to.not.equal(priceWei * 500n); // remainder really exists

    const ev = await expectEvent(
      ctx.marketplace.connect(ctx.buyer2).buyListing(1, { value: priceWei }),
      ctx.marketplace,
      "ListingSold"
    );
    assert.equal(ev.args.royalty, expectedRoyalty);
    assert.equal(ev.args.sellerProceeds, priceWei - expectedRoyalty);
    expect(ev.args.royalty + ev.args.sellerProceeds).to.equal(priceWei);
    assert.equal(Number(tokenId) > 0, true);
  });

  it("routes the royalty to the airline that owns the flight", async function () {
    const ctx = await deploy();
    // Second approved airline with its own flight and ticket.
    await ctx.registry.connect(ctx.admin).approveAirline(ctx.other.address);
    const departure = (await latest()) + 30 * 24 * 3600;
    await ctx.inventory.connect(ctx.other).createFlight(
      flightArgs("AIR-2", departure, 5, 1000)
    );
    const flight2 = Number((await ctx.inventory.nextFlightId()) - 1n);
    await ctx.inventory.connect(ctx.other).publishFlight(flight2);
    const t2 = await buyTicket(ctx, flight2, ctx.traveler);

    const expiresAt = (await latest()) + DAY;
    await (
      await ctx.marketplace.connect(ctx.traveler).list(t2, PRICE, expiresAt)
    ).wait();

    const royalty = (PRICE * 1000n) / 10000n;
    const sellerBefore = await provider.getBalance(ctx.traveler.address);
    const otherBefore = await provider.getBalance(ctx.other.address);
    const ev = await expectEvent(
      ctx.marketplace.connect(ctx.buyer2).buyListing(1, { value: PRICE }),
      ctx.marketplace,
      "ListingSold"
    );
    assert.equal(ev.args.royalty, royalty);
    expect((await provider.getBalance(ctx.other.address)) - otherBefore).to.equal(royalty);
    expect((await provider.getBalance(ctx.traveler.address)) - sellerBefore).to.equal(
      PRICE - royalty
    );
    // The first airline gets nothing from this resale.
    assert.equal(Number(await ctx.settlement.airlineBalances(ctx.airline.address)), 0);
  });

  it("rejects an under/over payment", async function () {
    const ctx = await deploy();
    const { priceWei } = await listed(ctx);
    await expectCustomError(
      ctx.marketplace.connect(ctx.buyer2).buyListing(1, { value: priceWei - 1n }),
      ctx.marketplace,
      "PaymentMismatch__value"
    );
    await expectCustomError(
      ctx.marketplace.connect(ctx.buyer2).buyListing(1, { value: priceWei + 1n }),
      ctx.marketplace,
      "PaymentMismatch__value"
    );
    // Nothing moved.
    expect(await ctx.nft.ownerOf(1)).to.equal(ctx.traveler.address);
    expect((await ctx.marketplace.getListing(1)).active).to.equal(true);
  });

  it("rejects a cancelled listing, an expired listing and a double buy", async function () {
    const ctx = await deploy();
    const { tokenId, priceWei, expiresAt } = await listed(ctx);

    // Cancel first, then buy: the listing is closed.
    await (await ctx.marketplace.connect(ctx.traveler).cancelListing(1)).wait();
    await expectCustomError(
      ctx.marketplace.connect(ctx.buyer2).buyListing(1, { value: priceWei }),
      ctx.marketplace,
      "ListingNotActive__id"
    );
    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(0n);

    // Re-list (listing #2), expire it, then buy the expired listing.
    await (
      await ctx.marketplace.connect(ctx.traveler).list(tokenId, priceWei, expiresAt)
    ).wait();
    await warpTo(expiresAt + 1);
    await expectCustomError(
      ctx.marketplace.connect(ctx.buyer2).buyListing(2, { value: priceWei }),
      ctx.marketplace,
      "ListingExpired__expiresAt"
    );
    assert.equal(Number(await ctx.marketplace.nextListingId()), 3);
  });

  it("rejects unknown listings and a second buy of the same listing", async function () {
    const ctx = await deploy();
    const { priceWei } = await listed(ctx);
    await expectCustomError(
      ctx.marketplace.connect(ctx.buyer2).buyListing(0, { value: priceWei }),
      ctx.marketplace,
      "UnknownListing__id"
    );
    await expectCustomError(
      ctx.marketplace.connect(ctx.buyer2).buyListing(99, { value: priceWei }),
      ctx.marketplace,
      "UnknownListing__id"
    );
    await (
      await ctx.marketplace.connect(ctx.buyer2).buyListing(1, { value: priceWei })
    ).wait();
    await expectCustomError(
      ctx.marketplace.connect(ctx.other).buyListing(1, { value: priceWei }),
      ctx.marketplace,
      "ListingNotActive__id"
    );
    expect(await ctx.nft.ownerOf(1)).to.equal(ctx.buyer2.address);
  });

  it("rejects a buy when the ticket leaves the Listed state", async function () {
    const ctx = await deploy();
    const { flightId, tokenId, priceWei } = await listed(ctx);

    await forceTicketState(
      await ctx.nft.getAddress(),
      tokenId,
      flightId,
      ctx.traveler.address,
      0
    );
    await expectCustomError(
      ctx.marketplace.connect(ctx.buyer2).buyListing(1, { value: priceWei }),
      ctx.marketplace,
      "InvalidState__state"
    );
    expect(await ctx.nft.ownerOf(tokenId)).to.equal(ctx.traveler.address);
  });

  it("rejects a buy once the recorded seller no longer owns the ticket", async function () {
    const ctx = await deploy();
    const { tokenId, priceWei } = await listed(ctx);

    // White-box: grant MARKETPLACE_ROLE to the admin EOA and move the ticket out from
    // under the listing; `buyListing` must refuse rather than pay the wrong seller.
    const MARKETPLACE_ROLE = await ctx.nft.MARKETPLACE_ROLE();
    await ctx.nft.connect(ctx.admin).grantRole(MARKETPLACE_ROLE, ctx.admin.address);
    await (
      await ctx.nft
        .connect(ctx.admin)
        .controlledTransfer(ctx.traveler.address, ctx.other.address, tokenId)
    ).wait();

    await expectCustomError(
      ctx.marketplace.connect(ctx.buyer2).buyListing(1, { value: priceWei }),
      ctx.marketplace,
      "SellerMismatch__seller"
    );
  });

  it("rejects a buy after the flight departs", async function () {
    const ctx = await deploy();
    const { flightId, priceWei } = await listed(ctx);

    await ctx.inventory.connect(ctx.airline).markDeparted(flightId);
    await expectCustomError(
      ctx.marketplace.connect(ctx.buyer2).buyListing(1, { value: priceWei }),
      ctx.marketplace,
      "FlightDeparted__id"
    );
    expect((await ctx.marketplace.getListing(1)).active).to.equal(true);
  });

  it("rejects a buy on a cancelled flight", async function () {
    const ctx = await deploy();
    const { flightId, priceWei } = await listed(ctx);

    await ctx.inventory.connect(ctx.airline).cancelFlight(flightId);
    await expectCustomError(
      ctx.marketplace.connect(ctx.buyer2).buyListing(1, { value: priceWei }),
      ctx.marketplace,
      "FlightCancelled__id"
    );
    expect((await ctx.marketplace.getListing(1)).active).to.equal(true);
  });

  it("rejects a buy after the refund deadline even if the listing has not expired", async function () {
    const ctx = await deploy();
    const now = await latest();
    const departure = now + 30 * 24 * 3600;
    const refundDeadline = now + HOUR; // refund window closes long before departure
    await ctx.inventory.connect(ctx.airline).createFlight([
      "SHORT-1",
      "JFK",
      "LHR",
      departure,
      5,
      PRICE,
      refundDeadline,
      8000,
      500,
    ]);
    const flightId = Number((await ctx.inventory.nextFlightId()) - 1n);
    await ctx.inventory.connect(ctx.airline).publishFlight(flightId);
    const tokenId = await buyTicket(ctx, flightId, ctx.traveler);

    const expiresAt = now + DAY; // outlives the refund deadline, so only the deadline can fire
    await (
      await ctx.marketplace.connect(ctx.traveler).list(tokenId, PRICE, expiresAt)
    ).wait();

    await warpTo(refundDeadline + 1);
    const listing = await ctx.marketplace.getListing(1);
    expect(listing.active).to.equal(true);
    const blockNow = await provider.getBlock("latest");
    expect(Number(blockNow.timestamp)).to.be.lessThan(Number(expiresAt));
    await expectCustomError(
      ctx.marketplace.connect(ctx.buyer2).buyListing(1, { value: PRICE }),
      ctx.marketplace,
      "RefundDeadlinePassed__deadline"
    );
  });

  it("blocks direct ERC-721 transfers before and after a resale (FR-26)", async function () {
    const ctx = await deploy();
    const { tokenId, priceWei } = await listed(ctx);

    await expectCustomError(
      ctx.nft
        .connect(ctx.traveler)
        .transferFrom(ctx.traveler.address, ctx.other.address, tokenId),
      ctx.nft,
      "DirectTransferBlocked__"
    );
    await expectCustomError(
      ctx.nft
        .connect(ctx.traveler)
        .safeTransferFrom(ctx.traveler.address, ctx.other.address, tokenId),
      ctx.nft,
      "DirectTransferBlocked__"
    );

    await (
      await ctx.marketplace.connect(ctx.buyer2).buyListing(1, { value: priceWei })
    ).wait();

    await expectCustomError(
      ctx.nft
        .connect(ctx.buyer2)
        .transferFrom(ctx.buyer2.address, ctx.other.address, tokenId),
      ctx.nft,
      "DirectTransferBlocked__"
    );
    expect(await ctx.nft.ownerOf(tokenId)).to.equal(ctx.buyer2.address);
  });

  it("royaltyInfo mirrors the marketplace split (D-18)", async function () {
    const ctx = await deploy();
    const { tokenId, priceWei } = await listed(ctx);

    const preview = await ctx.marketplace.previewResale(tokenId, priceWei);
    const [receiver, amount] = await ctx.nft.royaltyInfo(tokenId, priceWei);
    expect(receiver).to.equal(preview.airline);
    expect(amount).to.equal(preview.royalty);
    expect(amount).to.equal((priceWei * 500n) / 10000n);

    const ev = await expectEvent(
      ctx.marketplace.connect(ctx.buyer2).buyListing(1, { value: priceWei }),
      ctx.marketplace,
      "ListingSold"
    );
    assert.equal(ev.args.royalty, amount);
  });

  it("buy is blocked by both pauses; cancelListing still works during them", async function () {
    const ctx = await deploy();
    const { tokenId, priceWei, expiresAt } = await listed(ctx);

    await ctx.registry.connect(ctx.admin).pause();
    await expectCustomError(
      ctx.marketplace.connect(ctx.buyer2).buyListing(1, { value: priceWei }),
      ctx.marketplace,
      "PlatformPaused__"
    );
    await expectEvent(
      ctx.marketplace.connect(ctx.traveler).cancelListing(1),
      ctx.marketplace,
      "ListingCancelled"
    );
    await ctx.registry.connect(ctx.admin).unpause();

    // Local admin pause blocks the same entry point.
    await (
      await ctx.marketplace.connect(ctx.traveler).list(tokenId, priceWei, expiresAt)
    ).wait();
    await ctx.marketplace.pause();
    await expectCustomError(
      ctx.marketplace.connect(ctx.buyer2).buyListing(2, { value: priceWei }),
      ctx.marketplace,
      "PlatformPaused__"
    );
    await expectEvent(
      ctx.marketplace.connect(ctx.traveler).cancelListing(2),
      ctx.marketplace,
      "ListingCancelled"
    );
    await ctx.marketplace.unpause();

    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(0n);
  });

  it("the new owner can list the ticket again after a resale", async function () {
    const ctx = await deploy();
    const { tokenId, priceWei } = await listed(ctx);
    await (
      await ctx.marketplace.connect(ctx.buyer2).buyListing(1, { value: priceWei })
    ).wait();

    const ev = await expectEvent(
      ctx.marketplace.connect(ctx.buyer2).list(tokenId, priceWei, (await latest()) + DAY),
      ctx.marketplace,
      "ListingCreated"
    );
    assert.equal(ev.args.listingId, 2n);
    assert.equal(ev.args.seller, ctx.buyer2.address);
    expect(await ctx.marketplace.activeListingByToken(tokenId)).to.equal(2n);
    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(1n);
  });

  it("getActiveListings returns only active, unexpired listings", async function () {
    const ctx = await deploy();
    expect((await ctx.marketplace.getActiveListings()).length).to.equal(0);

    const { tokenId, priceWei, expiresAt } = await listed(ctx);
    let active = await ctx.marketplace.getActiveListings();
    expect(active.length).to.equal(1);
    expect(active[0].tokenId).to.equal(BigInt(tokenId));
    expect(active[0].priceWei).to.equal(priceWei);

    await (await ctx.marketplace.connect(ctx.traveler).cancelListing(1)).wait();
    expect((await ctx.marketplace.getActiveListings()).length).to.equal(0);

    await (
      await ctx.marketplace.connect(ctx.traveler).list(tokenId, priceWei, expiresAt)
    ).wait();
    await warpTo(expiresAt + 1);
    expect((await ctx.marketplace.getActiveListings()).length).to.equal(0);
  });
});
