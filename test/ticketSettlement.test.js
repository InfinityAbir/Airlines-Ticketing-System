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

// Phase 1 skeleton: wiring, admin gates, pause shapes. Business logic lands in Phases 2-3.
describe("TicketSettlement skeleton (Phase 1)", function () {
  async function deploy() {
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
    const Settlement = await getFactory("TicketSettlement");
    const settlement = await Settlement.deploy(
      await registry.getAddress(),
      await inventory.getAddress(),
      await nft.getAddress(),
      admin.address
    );
    await settlement.waitForDeployment();
    return { registry, inventory, nft, settlement, admin, other };
  }

  it("wires registry/inventory/nft/admin addresses", async function () {
    const { registry, inventory, nft, settlement, admin } = await deploy();
    expect(await settlement.registry()).to.equal(await registry.getAddress());
    expect(await settlement.inventory()).to.equal(await inventory.getAddress());
    expect(await settlement.ticketNFT()).to.equal(await nft.getAddress());
    expect(await settlement.admin()).to.equal(admin.address);
  });

  it("local pause is admin-only", async function () {
    const { settlement, other } = await deploy();
    await expectCustomError(settlement.connect(other).pause(), settlement, "NotAdmin__caller");
    await settlement.pause();
    expect(await settlement.paused()).to.equal(true);
    await settlement.unpause();
    expect(await settlement.paused()).to.equal(false);
  });
});

describe("TicketSettlement purchase + refund preview (Phase 2)", function () {
  const CID = "bafyairlineticketmetadata000000000000001";
  const PRICE = ethers.parseEther("0.1");

  function flightArgs(code, departure, capacity = 5) {
    return [
      code,
      "JFK",
      "LHR",
      departure,
      capacity,
      PRICE,
      departure - 7 * 24 * 3600,
      8000, // 80% refund
      500, // 5% royalty
    ];
  }

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

    // Production wiring (same as scripts/deploy.js).
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
  async function publishFlight(ctx, code = "BK-1", capacity = 5) {
    const departure = (await latest()) + 30 * 24 * 3600;
    await ctx.inventory
      .connect(ctx.airline)
      .createFlight(flightArgs(code, departure, capacity));
    const flightId = (await ctx.inventory.nextFlightId()) - 1n;
    await ctx.inventory.connect(ctx.airline).publishFlight(flightId);
    return { flightId, departure, refundDeadline: departure - 7 * 24 * 3600 };
  }

  it("happy path: one seat, one NFT, exact payment, S-1 seat, CID + events recorded", async function () {
    const ctx = await deploy();
    const { flightId } = await publishFlight(ctx);
    const before = (await ctx.inventory.getFlight(flightId)).seatsAvailable;

    const ev = await expectEvent(
      ctx.settlement.connect(ctx.traveler).purchase(flightId, CID, { value: PRICE }),
      ctx.settlement,
      "PurchaseCompleted"
    );
    assert.equal(ev.args.flightId, flightId);
    assert.equal(ev.args.tokenId, 1n);
    assert.equal(ev.args.buyer, ctx.traveler.address);
    assert.equal(ev.args.cid, CID);

    // Inventory decremented by exactly one seat.
    expect((await ctx.inventory.getFlight(flightId)).seatsAvailable).to.equal(before - 1n);

    // Exactly one minted ticket, owned by the buyer, with the recorded CID + S-1 seat.
    expect(await ctx.nft.balanceOf(ctx.traveler.address)).to.equal(1n);
    expect(await ctx.nft.ownerOf(1)).to.equal(ctx.traveler.address);
    const t = await ctx.nft.getTicket(1);
    expect(t.flightId).to.equal(flightId);
    expect(t.seatReference).to.equal("S-1");
    expect(t.metadataCID).to.equal(CID);
    expect(t.state).to.equal(0n); // Issued
    expect(await ctx.settlement.seatNumberByToken(1)).to.equal(1n);
    expect(await ctx.settlement.previewSeatReference(flightId)).to.equal("S-2");

    // Revenue credited to the airline; contract holds the funds (no payout in Phase 2).
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(PRICE);
    expect(await provider.getBalance(await ctx.settlement.getAddress())).to.equal(PRICE);
  });

  it("second buyer gets the next seat and its own ticket", async function () {
    const ctx = await deploy();
    const { flightId } = await publishFlight(ctx);
    await ctx.settlement.connect(ctx.traveler).purchase(flightId, CID, { value: PRICE });
    await ctx.settlement.connect(ctx.buyer2).purchase(flightId, CID, { value: PRICE });
    expect(await ctx.nft.balanceOf(ctx.traveler.address)).to.equal(1n);
    expect(await ctx.nft.balanceOf(ctx.buyer2.address)).to.equal(1n);
    expect((await ctx.nft.getTicket(2)).seatReference).to.equal("S-2");
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(PRICE * 2n);
  });

  it("rejects wrong payment value; failed payment mints nothing and changes nothing", async function () {
    const ctx = await deploy();
    const { flightId } = await publishFlight(ctx);
    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).purchase(flightId, CID, { value: PRICE - 1n }),
      ctx.settlement,
      "PaymentMismatch__value"
    );
    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).purchase(flightId, CID, { value: PRICE + 1n }),
      ctx.settlement,
      "PaymentMismatch__value"
    );
    expect(await ctx.nft.nextTokenId()).to.equal(1n);
    expect((await ctx.inventory.getFlight(flightId)).seatsAvailable).to.equal(5n);
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(0n);
  });

  it("orphaned-CID acceptance: upload-then-revert leaves no chain state (FR-13)", async function () {
    const ctx = await deploy();
    const { flightId } = await publishFlight(ctx, "ORPHAN-1");
    // The CID was obtained from the upload service first; the chain transaction then fails.
    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).purchase(flightId, CID, { value: 0n }),
      ctx.settlement,
      "PaymentMismatch__value"
    );
    expect(await ctx.nft.nextTokenId()).to.equal(1n);
    expect((await ctx.inventory.getFlight(flightId)).seatsAvailable).to.equal(5n);
    expect(await ctx.settlement.previewSeatReference(flightId)).to.equal("S-1");
  });

  it("records a client-generated mock-fallback CID verbatim", async function () {
    const ctx = await deploy();
    const { flightId } = await publishFlight(ctx, "MOCK-1");
    const mockCid = `bafy${"a1b2c3d4e5".repeat(4)}`; // deterministic frontend fallback shape
    await ctx.settlement.connect(ctx.traveler).purchase(flightId, mockCid, { value: PRICE });
    expect((await ctx.nft.getTicket(1)).metadataCID).to.equal(mockCid);
  });

  it("rejects empty and malformed CIDs before any state change", async function () {
    const ctx = await deploy();
    const { flightId } = await publishFlight(ctx, "CID-1");
    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).purchase(flightId, "", { value: PRICE }),
      ctx.settlement,
      "EmptyCid__"
    );
    for (const bad of ["abc", "no spaces allowed", "cid-with-dashes", "x".repeat(129)]) {
      await expectCustomError(
        ctx.settlement.connect(ctx.traveler).purchase(flightId, bad, { value: PRICE }),
        ctx.settlement,
        "InvalidCid__"
      );
    }
    expect(await ctx.nft.nextTokenId()).to.equal(1n);
    expect((await ctx.inventory.getFlight(flightId)).seatsAvailable).to.equal(5n);
  });

  it("rejects purchase when no seats remain", async function () {
    const ctx = await deploy();
    const { flightId } = await publishFlight(ctx, "FULL-1", 1);
    await ctx.settlement.connect(ctx.traveler).purchase(flightId, CID, { value: PRICE });
    await expectCustomError(
      ctx.settlement.connect(ctx.buyer2).purchase(flightId, CID, { value: PRICE }),
      ctx.settlement,
      "NoSeatsAvailable__id"
    );
    expect(await ctx.nft.nextTokenId()).to.equal(2n);
  });

  it("rejects purchase for draft, cancelled, departed and unknown flights", async function () {
    const ctx = await deploy();
    const departure = (await latest()) + 30 * 24 * 3600;
    await ctx.inventory.connect(ctx.airline).createFlight(flightArgs("DRAFT-1", departure));
    const draftId = (await ctx.inventory.nextFlightId()) - 1n;
    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).purchase(draftId, CID, { value: PRICE }),
      ctx.settlement,
      "SalesOpen__closed"
    );

    await ctx.inventory.connect(ctx.airline).createFlight(flightArgs("CANCEL-1", departure));
    const cancelledId = (await ctx.inventory.nextFlightId()) - 1n;
    await ctx.inventory.connect(ctx.airline).cancelFlight(cancelledId);
    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).purchase(cancelledId, CID, { value: PRICE }),
      ctx.settlement,
      "FlightCancelled__id"
    );

    await ctx.inventory.connect(ctx.airline).createFlight(flightArgs("GONE-1", departure));
    const goneId = (await ctx.inventory.nextFlightId()) - 1n;
    await ctx.inventory.connect(ctx.airline).markDeparted(goneId);
    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).purchase(goneId, CID, { value: PRICE }),
      ctx.settlement,
      "FlightDeparted__id"
    );

    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).purchase(999, CID, { value: PRICE }),
      [ctx.settlement, ctx.inventory],
      "UnknownFlight__id"
    );
    expect(await ctx.nft.nextTokenId()).to.equal(1n);
  });

  it("pause matrix: registry pause and local settlement pause both block purchase", async function () {
    const ctx = await deploy();
    const { flightId } = await publishFlight(ctx, "PAUSE-1");
    await ctx.registry.connect(ctx.admin).pause();
    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).purchase(flightId, CID, { value: PRICE }),
      ctx.settlement,
      "PlatformPaused__"
    );
    await ctx.registry.connect(ctx.admin).unpause();
    await ctx.settlement.connect(ctx.admin).pause();
    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).purchase(flightId, CID, { value: PRICE }),
      ctx.settlement,
      "PlatformPaused__"
    );
    await ctx.settlement.connect(ctx.admin).unpause();
    // Live again: booking works.
    await expectEvent(
      ctx.settlement.connect(ctx.traveler).purchase(flightId, CID, { value: PRICE }),
      ctx.settlement,
      "PurchaseCompleted"
    );
  });

  it("mint stays settlement-only and unapproved airlines still cannot create", async function () {
    const ctx = await deploy();
    const { flightId } = await publishFlight(ctx, "GATE-1");
    await expectCustomError(
      ctx.nft.connect(ctx.traveler).mint(ctx.traveler.address, flightId, "S-1", CID),
      ctx.nft,
      "UnauthorizedSettlement__caller"
    );
    const signers = await getSigners();
    const unapproved = signers[7];
    await expectCustomError(
      ctx.inventory.connect(unapproved).createFlight(flightArgs("NOPE-1", (await latest()) + 1000)),
      ctx.inventory,
      "UnauthorizedAirline__caller"
    );
  });

  it("calculateRefund mirrors the policy: 80% before deadline, 0 at/after it or after departure", async function () {
    const ctx = await deploy();
    const { flightId, refundDeadline } = await publishFlight(ctx, "REF-1");
    await ctx.settlement.connect(ctx.traveler).purchase(flightId, CID, { value: PRICE });

    // Eligible before the deadline: refund = price * 8000 / 10000.
    let [refund, retained] = await ctx.settlement.calculateRefund(1);
    expect(refund).to.equal((PRICE * 8000n) / 10000n);
    expect(retained).to.equal(PRICE - (PRICE * 8000n) / 10000n);
    expect(refund + retained).to.equal(PRICE);

    // Still eligible exactly at the deadline (inclusive bound).
    await warpTo(refundDeadline);
    [refund, retained] = await ctx.settlement.calculateRefund(1);
    expect(refund).to.equal((PRICE * 8000n) / 10000n);

    // One second after the deadline: no refund, airline keeps the full fare.
    await warpTo(refundDeadline + 1);
    [refund, retained] = await ctx.settlement.calculateRefund(1);
    expect(refund).to.equal(0n);
    expect(retained).to.equal(PRICE);

    // Departed flight: cancellation path is closed even before the deadline.
    const { flightId: f2, refundDeadline: rd2 } = await publishFlight(ctx, "REF-2");
    await ctx.settlement.connect(ctx.traveler).purchase(f2, CID, { value: PRICE });
    await ctx.inventory.connect(ctx.airline).markDeparted(f2);
    [refund, retained] = await ctx.settlement.calculateRefund(2);
    expect(refund).to.equal(0n);
    expect(retained).to.equal(PRICE);
    expect(rd2 > 0n).to.equal(true);
  });

  it("calculateRefund reverts for unknown tickets", async function () {
    const ctx = await deploy();
    await expectCustomError(ctx.settlement.calculateRefund(42), ctx.nft, "UnknownTicket__id");
  });
});
