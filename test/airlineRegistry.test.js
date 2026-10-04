import { assert, expect } from "chai";
import {
  ethers,
  expectCustomError,
  expectEvent,
  getFactory,
  getSigners,
  latest,
  provider,
  warpTo,
} from "./_helpers.js";

describe("AirlineRegistry (Phase 1)", function () {
  async function deploy() {
    const [admin, airline, other] = await getSigners();
    const Factory = await getFactory("AirlineRegistry");
    const registry = await Factory.deploy(admin.address);
    await registry.waitForDeployment();
    return { registry, admin, airline, other };
  }

  it("defaults lock R1 caps (maxRoyaltyBps 1000, maxRefundBps 10000)", async function () {
    const { registry } = await deploy();
    expect(await registry.maxRoyaltyBps()).to.equal(1000n);
    expect(await registry.maxRefundBps()).to.equal(10000n);
  });

  it("admin approves an airline (role + flag + event)", async function () {
    const { registry, admin, airline } = await deploy();
    const ev = await expectEvent(
      registry.connect(admin).approveAirline(airline.address),
      registry,
      "AirlineApproved"
    );
    assert.equal(ev.args.wallet, airline.address);
    expect(await registry.isApproved(airline.address)).to.equal(true);
    expect(await registry.hasRole(await registry.AIRLINE_ROLE(), airline.address)).to.equal(true);
  });

  it("non-admin cannot approve, deactivate, limit, pause", async function () {
    const { registry, airline, other } = await deploy();
    await expectCustomError(
      registry.connect(other).approveAirline(airline.address),
      registry,
      "AccessControlUnauthorizedAccount"
    );
    await expectCustomError(
      registry.connect(other).deactivateAirline(airline.address),
      registry,
      "AccessControlUnauthorizedAccount"
    );
    await expectCustomError(
      registry.connect(other).reactivateAirline(airline.address),
      registry,
      "AccessControlUnauthorizedAccount"
    );
    await expectCustomError(registry.connect(other).pause(), registry, "AccessControlUnauthorizedAccount");
    await expectCustomError(registry.connect(other).unpause(), registry, "AccessControlUnauthorizedAccount");
    await expectCustomError(
      registry.connect(other).setLimits(1000, 10000),
      registry,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("rejects double approve, zero address, unknown deactivate", async function () {
    const { registry, admin, airline, other } = await deploy();
    await expectCustomError(
      registry.connect(admin).approveAirline(ethers.ZeroAddress),
      registry,
      "ZeroAddress__wallet"
    );
    await registry.connect(admin).approveAirline(airline.address);
    await expectCustomError(
      registry.connect(admin).approveAirline(airline.address),
      registry,
      "AlreadyApproved__wallet"
    );
    await expectCustomError(
      registry.connect(admin).deactivateAirline(other.address),
      registry,
      "NotApproved__wallet"
    );
  });

  it("deactivate/reactivate cycle preserves role sync", async function () {
    const { registry, admin, airline } = await deploy();
    await registry.connect(admin).approveAirline(airline.address);
    const ev = await expectEvent(
      registry.connect(admin).deactivateAirline(airline.address),
      registry,
      "AirlineDeactivated"
    );
    assert.equal(ev.args.wallet, airline.address);
    expect(await registry.isApproved(airline.address)).to.equal(false);
    await expectEvent(
      registry.connect(admin).reactivateAirline(airline.address),
      registry,
      "AirlineReactivated"
    );
    expect(await registry.isApproved(airline.address)).to.equal(true);
  });

  it("setLimits validates bounds and emits", async function () {
    const { registry, admin } = await deploy();
    await expectCustomError(
      registry.connect(admin).setLimits(10001, 10000),
      registry,
      "RoyaltyCapTooHigh__bps"
    );
    await expectCustomError(
      registry.connect(admin).setLimits(1000, 10001),
      registry,
      "RefundCapTooHigh__bps"
    );
    const ev = await expectEvent(registry.connect(admin).setLimits(500, 9000), registry, "LimitsUpdated");
    assert.equal(ev.args.maxRoyaltyBps, 500);
    assert.equal(ev.args.maxRefundBps, 9000);
    expect(await registry.maxRoyaltyBps()).to.equal(500n);
  });

  it("pause/unpause gates admin only", async function () {
    const { registry, admin, other } = await deploy();
    await registry.connect(admin).pause();
    expect(await registry.paused()).to.equal(true);
    await expectCustomError(
      registry.connect(other).unpause(),
      registry,
      "AccessControlUnauthorizedAccount"
    );
    await registry.connect(admin).unpause();
    expect(await registry.paused()).to.equal(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 — coverage close-out for AirlineRegistry (PRD §17 metric 2): the
// constructor guard and the reactivate/deactivate failure paths.
// ---------------------------------------------------------------------------

describe("AirlineRegistry coverage close-out (Phase 6)", function () {
  async function deploy() {
    const [admin, airline, other] = await getSigners();
    const Factory = await getFactory("AirlineRegistry");
    const registry = await Factory.deploy(admin.address);
    await registry.waitForDeployment();
    return { registry, admin, airline, other };
  }

  it("the constructor rejects a zero administrator", async function () {
    const Factory = await getFactory("AirlineRegistry");
    await expectCustomError(Factory.deploy(ethers.ZeroAddress), Factory, "ZeroAddress__wallet");
  });

  it("reactivate rejects an already-approved wallet and the zero address", async function () {
    const { registry, admin, airline } = await deploy();
    await registry.connect(admin).approveAirline(airline.address);
    await expectCustomError(
      registry.connect(admin).reactivateAirline(airline.address),
      registry,
      "AlreadyApproved__wallet"
    );
    await expectCustomError(
      registry.connect(admin).reactivateAirline(ethers.ZeroAddress),
      registry,
      "ZeroAddress__wallet"
    );
    // Deactivate first: the same wallet then reactivates cleanly, proving both branches.
    await registry.connect(admin).deactivateAirline(airline.address);
    await expectEvent(
      registry.connect(admin).reactivateAirline(airline.address),
      registry,
      "AirlineReactivated"
    );
    expect(await registry.isApproved(airline.address)).to.equal(true);
  });

  it("deactivate rejects the zero address and an already-deactivated wallet", async function () {
    const { registry, admin, airline } = await deploy();
    await expectCustomError(
      registry.connect(admin).deactivateAirline(ethers.ZeroAddress),
      registry,
      "NotApproved__wallet"
    );
    await registry.connect(admin).approveAirline(airline.address);
    await registry.connect(admin).deactivateAirline(airline.address);
    await expectCustomError(
      registry.connect(admin).deactivateAirline(airline.address),
      registry,
      "NotApproved__wallet"
    );
    expect(await registry.hasRole(await registry.AIRLINE_ROLE(), airline.address)).to.equal(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — the registry is the backend of admin.html (approvals, platform
// limits, emergency controls). These tests walk the same calls the console
// makes across all five contracts, plus the FR-34 matrix the UI renders.
// ---------------------------------------------------------------------------

const CID = "bafyairlineticketmetadata000000000000001";
const PRICE = ethers.parseEther("0.1");
const CAP = (PRICE * 12000n) / 10000n; // 120% resale cap (R1)
const HOUR = 3600;

function flightArgs(code, departure, capacity = 6, royaltyBps = 500, refundBps = 8000) {
  return [
    code,
    "JFK",
    "LHR",
    departure,
    capacity,
    PRICE,
    departure - 7 * 24 * 3600,
    refundBps,
    royaltyBps,
  ];
}

/// @notice Full production wiring (same order as scripts/deploy.js) for one test.
async function deployFull() {
  const [admin, airline, traveler, buyer2, other] = await getSigners();
  const Registry = await getFactory("AirlineRegistry");
  const registry = await Registry.deploy(admin.address);
  await registry.waitForDeployment();
  const Inventory = await getFactory("FlightInventory");
  const inventory = await Inventory.deploy(await registry.getAddress(), admin.address);
  await inventory.waitForDeployment();
  const NFT = await getFactory("AirTicketNFT");
  const nft = await NFT.deploy(await registry.getAddress(), await inventory.getAddress(), admin.address);
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
    await inventory.setAuthorizedParties(await settlement.getAddress(), await marketplace.getAddress())
  ).wait();
  await (await nft.setSettlement(await settlement.getAddress())).wait();
  await (await nft.grantRole(await nft.MARKETPLACE_ROLE(), await marketplace.getAddress())).wait();
  await registry.connect(admin).approveAirline(airline.address);
  return { registry, inventory, nft, settlement, marketplace, admin, airline, traveler, buyer2, other };
}

/// @notice Create + publish a flight, returning { flightId, departure }.
async function publishFlight(ctx, code, capacity = 6) {
  const departure = (await latest()) + 30 * 24 * 3600;
  await expectEvent(ctx.inventory.connect(ctx.airline).createFlight(flightArgs(code, departure, capacity)), ctx.inventory, "FlightCreated");
  const flightId = Number((await ctx.inventory.nextFlightId()) - 1n);
  await expectEvent(ctx.inventory.connect(ctx.airline).publishFlight(flightId), ctx.inventory, "FlightPublished");
  return { flightId, departure };
}

/// @notice Buy one seat as `buyer` and return the minted tokenId.
async function buyTicket(ctx, flightId, buyer) {
  await (await ctx.settlement.connect(buyer).purchase(flightId, CID, { value: PRICE })).wait();
  return Number((await ctx.nft.nextTokenId()) - 1n);
}

describe("AirlineRegistry admin console (Phase 5)", function () {
  it("platform pause blocks every write in the matrix; resolutions and reads stay open", async function () {
    const ctx = await deployFull();
    const { flightId, departure } = await publishFlight(ctx, "P5-1");
    const cancelToken = await buyTicket(ctx, flightId, ctx.traveler);
    const usedToken = await buyTicket(ctx, flightId, ctx.traveler);
    const listedToken = await buyTicket(ctx, flightId, ctx.traveler);
    const forSaleToken = await buyTicket(ctx, flightId, ctx.traveler);

    // Draft flight and a live listing created while the platform is still up.
    const draftDeparture = (await latest()) + 40 * 24 * 3600;
    await expectEvent(
      ctx.inventory.connect(ctx.airline).createFlight(flightArgs("P5-2", draftDeparture)),
      ctx.inventory,
      "FlightCreated"
    );
    const draftId = Number((await ctx.inventory.nextFlightId()) - 1n);
    const expiresAt = (await latest()) + 12 * 3600;
    const listEv = await expectEvent(
      ctx.marketplace.connect(ctx.traveler).list(listedToken, CAP, expiresAt),
      ctx.marketplace,
      "ListingCreated"
    );
    const listingId = Number(listEv.args.listingId);

    await (await ctx.registry.connect(ctx.admin).pause()).wait();
    expect(await ctx.registry.paused()).to.equal(true);

    // Blocked side: flights, booking, resale, transfers.
    await expectCustomError(
      ctx.inventory.connect(ctx.airline).createFlight(flightArgs("P5-3", draftDeparture)),
      ctx.inventory,
      "PlatformPaused__"
    );
    await expectCustomError(ctx.inventory.connect(ctx.airline).publishFlight(draftId), ctx.inventory, "PlatformPaused__");
    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).purchase(flightId, CID, { value: PRICE }),
      ctx.settlement,
      "PlatformPaused__"
    );
    await expectCustomError(
      ctx.marketplace.connect(ctx.buyer2).buyListing(listingId, { value: CAP }),
      ctx.marketplace,
      "PlatformPaused__"
    );
    await expectCustomError(
      ctx.marketplace.connect(ctx.traveler).list(forSaleToken, CAP, expiresAt),
      ctx.marketplace,
      "PlatformPaused__"
    );
    // The owner is fully authorized, yet the ticket still cannot leave through the console.
    await (await ctx.nft.connect(ctx.traveler).approve(ctx.admin.address, cancelToken)).wait();
    await expectCustomError(
      ctx.nft.connect(ctx.admin).transferFrom(ctx.traveler.address, ctx.buyer2.address, cancelToken),
      ctx.nft,
      "DirectTransferBlocked__"
    );

    // Open side: refund, listing withdrawal, boarding, departure and every read.
    const preview = await ctx.settlement.calculateRefund(cancelToken);
    expect(preview.refund).to.equal((PRICE * 8000n) / 10000n);
    await expectEvent(ctx.settlement.connect(ctx.traveler).cancel(cancelToken), ctx.settlement, "TicketRefunded");
    expect((await ctx.nft.getTicket(cancelToken)).state).to.equal(2n);
    expect((await ctx.inventory.getFlight(flightId)).seatsAvailable).to.equal(3n);

    await expectEvent(ctx.marketplace.connect(ctx.traveler).cancelListing(listingId), ctx.marketplace, "ListingCancelled");
    expect((await ctx.nft.getTicket(listedToken)).state).to.equal(0n);

    await warpTo(departure - HOUR);
    await expectEvent(ctx.nft.connect(ctx.airline).markUsed(usedToken), ctx.nft, "TicketMarkedUsed");
    await expectEvent(ctx.inventory.connect(ctx.airline).markDeparted(flightId), ctx.inventory, "FlightDeparted");

    expect((await ctx.inventory.getFlight(flightId)).airline).to.equal(ctx.airline.address);
    expect(await ctx.nft.ownerOf(forSaleToken)).to.equal(ctx.traveler.address);
    expect(await ctx.registry.maxRoyaltyBps()).to.equal(1000n);

    // Resume: the blocked writes open again.
    await (await ctx.registry.connect(ctx.admin).unpause()).wait();
    await expectEvent(ctx.inventory.connect(ctx.airline).publishFlight(draftId), ctx.inventory, "FlightPublished");
    const buyEv = await expectEvent(
      ctx.settlement.connect(ctx.buyer2).purchase(draftId, CID, { value: PRICE }),
      ctx.settlement,
      "PurchaseCompleted"
    );
    assert.equal(buyEv.args.buyer, ctx.buyer2.address);
  });

  it("the booking and resale pause switches are independent and admin-gated", async function () {
    const ctx = await deployFull();
    const { flightId } = await publishFlight(ctx, "P5-10");
    const tokenA = await buyTicket(ctx, flightId, ctx.traveler);
    const expiresAt = (await latest()) + 12 * 3600;

    await expectCustomError(ctx.settlement.connect(ctx.other).pause(), ctx.settlement, "NotAdmin__caller");
    await expectCustomError(ctx.marketplace.connect(ctx.other).pause(), ctx.marketplace, "NotAdmin__caller");

    // Booking pause: purchases stop, resale keeps working.
    await (await ctx.settlement.connect(ctx.admin).pause()).wait();
    await expectCustomError(
      ctx.settlement.connect(ctx.buyer2).purchase(flightId, CID, { value: PRICE }),
      ctx.settlement,
      "PlatformPaused__"
    );
    const listEv = await expectEvent(
      ctx.marketplace.connect(ctx.traveler).list(tokenA, CAP, expiresAt),
      ctx.marketplace,
      "ListingCreated"
    );
    await (await ctx.settlement.connect(ctx.admin).unpause()).wait();
    await (
      await ctx.marketplace.connect(ctx.traveler).cancelListing(Number(listEv.args.listingId))
    ).wait();

    // Resale pause: listing stops, booking keeps working.
    await (await ctx.marketplace.connect(ctx.admin).pause()).wait();
    await expectEvent(
      ctx.settlement.connect(ctx.buyer2).purchase(flightId, CID, { value: PRICE }),
      ctx.settlement,
      "PurchaseCompleted"
    );
    await expectCustomError(
      ctx.marketplace.connect(ctx.traveler).list(tokenA, CAP, expiresAt),
      ctx.marketplace,
      "PlatformPaused__"
    );
    await (await ctx.marketplace.connect(ctx.admin).unpause()).wait();
    await expectEvent(
      ctx.marketplace.connect(ctx.traveler).list(tokenA, CAP, expiresAt),
      ctx.marketplace,
      "ListingCreated"
    );
    expect(await ctx.settlement.paused()).to.equal(false);
    expect(await ctx.marketplace.paused()).to.equal(false);
    expect(await ctx.registry.paused()).to.equal(false);
  });

  it("lowering the platform caps tightens flight creation at the exact boundary", async function () {
    const ctx = await deployFull();
    const departure = (await latest()) + 30 * 24 * 3600;

    const ev = await expectEvent(
      ctx.registry.connect(ctx.admin).setLimits(100, 5000),
      ctx.registry,
      "LimitsUpdated"
    );
    assert.equal(ev.args.maxRoyaltyBps, 100);
    assert.equal(ev.args.maxRefundBps, 5000);

    // Above either new cap: rejected even for an approved operator.
    // (createFlight checks the refund cap first, so the royalty case must stay inside it.)
    await expectCustomError(
      ctx.inventory.connect(ctx.airline).createFlight(flightArgs("P5-20", departure, 6, 500, 5000)),
      ctx.inventory,
      "RoyaltyAboveCap__bps"
    );
    await expectCustomError(
      ctx.inventory.connect(ctx.airline).createFlight(flightArgs("P5-21", departure, 6, 100, 6000)),
      ctx.inventory,
      "RefundRateTooHigh__bps"
    );

    // Exactly at both caps is still allowed.
    await expectEvent(
      ctx.inventory.connect(ctx.airline).createFlight(flightArgs("P5-22", departure, 6, 100, 5000)),
      ctx.inventory,
      "FlightCreated"
    );

    // Raising the caps back re-opens the locked R1 policy.
    await (await ctx.registry.connect(ctx.admin).setLimits(1000, 10000)).wait();
    await expectEvent(
      ctx.inventory.connect(ctx.airline).createFlight(flightArgs("P5-23", departure, 6, 1000, 10000)),
      ctx.inventory,
      "FlightCreated"
    );
    expect(await ctx.registry.maxRoyaltyBps()).to.equal(1000n);
    expect(await ctx.registry.maxRefundBps()).to.equal(10000n);
  });

  it("the administrator can never move a ticket, a seat, or an airline's money", async function () {
    const ctx = await deployFull();
    const { flightId } = await publishFlight(ctx, "P5-30");
    const tokenId = await buyTicket(ctx, flightId, ctx.traveler);
    const balanceBefore = await ctx.settlement.airlineBalances(ctx.airline.address);
    const contractBalanceBefore = await provider.getBalance(await ctx.settlement.getAddress());
    const seatBefore = (await ctx.inventory.getFlight(flightId)).seatsAvailable;

    // Issued-ticket checks run before the listing so state never masks the role guard.
    await expectCustomError(
      ctx.nft.connect(ctx.admin).markUsed(tokenId),
      ctx.nft,
      "NotFlightAirline__caller"
    );
    await expectCustomError(
      ctx.nft.connect(ctx.admin).invalidateAsCancelled(tokenId),
      ctx.nft,
      "UnauthorizedSettlement__caller"
    );
    await expectCustomError(ctx.inventory.connect(ctx.admin).cancelFlight(flightId), ctx.inventory, "NotFlightAirline__caller");
    await expectCustomError(ctx.inventory.connect(ctx.admin).reserveSeat(flightId), ctx.inventory, "UnauthorizedCaller__caller");
    await expectCustomError(
      ctx.settlement.connect(ctx.admin).withdrawAirlineBalance(),
      ctx.settlement,
      "NothingToWithdraw__"
    );

    const expiresAt = (await latest()) + 12 * 3600;
    const listEv = await expectEvent(
      ctx.marketplace.connect(ctx.traveler).list(tokenId, CAP, expiresAt),
      ctx.marketplace,
      "ListingCreated"
    );
    const listingId = Number(listEv.args.listingId);
    await expectCustomError(ctx.marketplace.connect(ctx.admin).cancelListing(listingId), ctx.marketplace, "NotSeller__caller");

    // Nothing moved: same owner, same state, same seat, same ETH.
    expect(await ctx.nft.ownerOf(tokenId)).to.equal(ctx.traveler.address);
    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(1n); // still Listed
    expect((await ctx.inventory.getFlight(flightId)).seatsAvailable).to.equal(seatBefore);
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(balanceBefore);
    expect(await provider.getBalance(await ctx.settlement.getAddress())).to.equal(contractBalanceBefore);
  });

  it("deactivating an operator blocks new flights; existing flights and tickets survive (FR-06)", async function () {
    const ctx = await deployFull();
    const { flightId } = await publishFlight(ctx, "P5-40");
    const tokenId = await buyTicket(ctx, flightId, ctx.traveler);

    await expectEvent(
      ctx.registry.connect(ctx.admin).deactivateAirline(ctx.airline.address),
      ctx.registry,
      "AirlineDeactivated"
    );
    expect(await ctx.registry.isApproved(ctx.airline.address)).to.equal(false);

    const departure = (await latest()) + 30 * 24 * 3600;
    await expectCustomError(
      ctx.inventory.connect(ctx.airline).createFlight(flightArgs("P5-41", departure)),
      ctx.inventory,
      "UnauthorizedAirline__caller"
    );

    // Existing records stay intact and the traveler can still exit.
    const flight = await ctx.inventory.getFlight(flightId);
    expect(flight.airline).to.equal(ctx.airline.address);
    expect(flight.salesOpen).to.equal(true);
    expect(await ctx.nft.ownerOf(tokenId)).to.equal(ctx.traveler.address);
    await expectEvent(ctx.settlement.connect(ctx.traveler).cancel(tokenId), ctx.settlement, "TicketRefunded");
    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(2n);

    // Reactivation restores creation.
    await expectEvent(
      ctx.registry.connect(ctx.admin).reactivateAirline(ctx.airline.address),
      ctx.registry,
      "AirlineReactivated"
    );
    expect(await ctx.registry.isApproved(ctx.airline.address)).to.equal(true);
    await expectEvent(
      ctx.inventory.connect(ctx.airline).createFlight(flightArgs("P5-42", departure)),
      ctx.inventory,
      "FlightCreated"
    );
  });
});
