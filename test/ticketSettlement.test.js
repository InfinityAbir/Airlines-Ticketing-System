import { assert, expect } from "chai";
import {
  ethers,
  expectCustomError,
  expectEvent,
  forceTicketState,
  getFactory,
  getSigners,
  latest,
  pinNextTimestamp,
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
async function publishFlight(ctx, code = "BK-1", capacity = 5) {
  const departure = (await latest()) + 30 * 24 * 3600;
  await ctx.inventory.connect(ctx.airline).createFlight(flightArgs(code, departure, capacity));
  const flightId = (await ctx.inventory.nextFlightId()) - 1n;
  await ctx.inventory.connect(ctx.airline).publishFlight(flightId);
  return { flightId, flightCode: code, departure, refundDeadline: departure - 7 * 24 * 3600 };
}

describe("TicketSettlement purchase + refund preview (Phase 2)", function () {
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

describe("TicketSettlement cancellation + revenue withdrawal (Phase 3)", function () {
  const REFUND = (PRICE * 8000n) / 10000n;
  const RETAINED = PRICE - REFUND;

  async function buy(ctx, flightId, signer = null) {
    const who = signer ?? ctx.traveler;
    await ctx.settlement.connect(who).purchase(flightId, CID, { value: PRICE });
    return (await ctx.nft.nextTokenId()) - 1n;
  }

  /// @notice Cancel and return the receipt plus both Phase 3 events (FR-22/FR-23, D-16).
  async function cancelAndParse(ctx, tokenId, signer = null) {
    const who = signer ?? ctx.traveler;
    const receipt = await (await ctx.settlement.connect(who).cancel(tokenId)).wait();
    const pick = (name) => {
      for (const log of receipt.logs) {
        try {
          const parsed = ctx.settlement.interface.parseLog(log);
          if (parsed && parsed.name === name) return parsed;
        } catch {
          // log from another contract (airline registry / NFT / inventory)
        }
      }
      throw new Error(`expected ${name} in receipt`);
    };
    return { receipt, cancelled: pick("TicketCancelled"), refunded: pick("TicketRefunded") };
  }

  it("cancels before the deadline: terminal state, exact refund, seat returned and re-issued", async function () {
    const ctx = await deploy();
    const { flightId } = await publishFlight(ctx, "CXL-1");
    const tokenId = await buy(ctx, flightId);
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(PRICE);
    expect(await ctx.settlement.refundReserve(ctx.airline.address)).to.equal(REFUND);
    const seatsBefore = (await ctx.inventory.getFlight(flightId)).seatsAvailable;

    const before = await provider.getBalance(ctx.traveler.address);
    const { receipt, cancelled, refunded } = await cancelAndParse(ctx, tokenId);
    const after = await provider.getBalance(ctx.traveler.address);
    const gas = receipt.gasUsed * receipt.gasPrice;

    // FR-22/FR-23 event payloads; receipt hash is what the UI displays (D-16).
    assert.equal(cancelled.args.tokenId, tokenId);
    assert.equal(cancelled.args.owner, ctx.traveler.address);
    assert.equal(refunded.args.tokenId, tokenId);
    expect(refunded.args.refund).to.equal(REFUND);
    expect(refunded.args.retained).to.equal(RETAINED);
    expect(refunded.args.refund + refunded.args.retained).to.equal(PRICE);
    expect(receipt.hash).to.match(/^0x[0-9a-f]{64}$/);

    // Traveler receives the refund, net of gas.
    expect(after - before + gas).to.equal(REFUND);

    // Cancelled is terminal, ownership retained so the verifier can still read it (not burned).
    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(2n);
    expect(await ctx.nft.ownerOf(tokenId)).to.equal(ctx.traveler.address);

    // Airline credit debited by the refund and the escrow released.
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(RETAINED);
    expect(await ctx.settlement.refundReserve(ctx.airline.address)).to.equal(0n);
    expect(await provider.getBalance(await ctx.settlement.getAddress())).to.equal(RETAINED);

    // FR-23: seat returned to inventory, then re-issued as S-1 to the next buyer.
    expect((await ctx.inventory.getFlight(flightId)).seatsAvailable).to.equal(seatsBefore + 1n);
    await buy(ctx, flightId, ctx.buyer2);
    expect((await ctx.nft.getTicket(2n)).seatReference).to.equal("S-1");
    expect((await ctx.inventory.getFlight(flightId)).seatsAvailable).to.equal(seatsBefore);

    // Refund preview parity after cancellation.
    const preview = await ctx.settlement.calculateRefund(tokenId);
    expect(preview.refund).to.equal(0n);
    expect(preview.retained).to.equal(PRICE);
  });

  it("boundary: allowed exactly at the refund deadline, rejected one second later", async function () {
    const ctx = await deploy();
    const { flightId, refundDeadline } = await publishFlight(ctx, "CXL-2");
    const tokenId = await buy(ctx, flightId);

    await pinNextTimestamp(refundDeadline);
    const { receipt } = await cancelAndParse(ctx, tokenId);
    const block = await provider.getBlock(receipt.blockNumber);
    expect(block.timestamp).to.equal(refundDeadline);
    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(2n);

    const { flightId: flight2, refundDeadline: deadline2 } = await publishFlight(ctx, "CXL-3");
    const tokenId2 = await buy(ctx, flight2);
    await pinNextTimestamp(deadline2 + 1);
    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).cancel(tokenId2),
      ctx.settlement,
      "RefundDeadlinePassed__deadline"
    );
    expect((await ctx.nft.getTicket(tokenId2)).state).to.equal(0n);
    expect((await ctx.inventory.getFlight(flight2)).seatsAvailable).to.equal(4n);
    // CXL-2's cancelled fare left its retained share credited; CXL-3's fare is still whole.
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(PRICE + RETAINED);
    expect(await ctx.settlement.refundReserve(ctx.airline.address)).to.equal(REFUND);
  });

  it("rejects cancel after departure time passes (refund deadline is never later than departure)", async function () {
    const ctx = await deploy();
    const { flightId, departure } = await publishFlight(ctx, "CXL-4");
    const tokenId = await buy(ctx, flightId);

    await warpTo(departure + 1);
    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).cancel(tokenId),
      ctx.settlement,
      "RefundDeadlinePassed__deadline"
    );
    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(0n);
    expect((await ctx.inventory.getFlight(flightId)).seatsAvailable).to.equal(4n);
    expect(await ctx.nft.ownerOf(tokenId)).to.equal(ctx.traveler.address);
  });

  it("rejects cancel once the airline marks the ticket used or the flight departed", async function () {
    const ctx = await deploy();
    const { flightId, departure } = await publishFlight(ctx, "CXL-5");
    const tokenId = await buy(ctx, flightId);

    await warpTo(departure - 3600);
    await (await ctx.inventory.connect(ctx.airline).markDeparted(flightId)).wait();

    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).cancel(tokenId),
      ctx.settlement,
      "FlightDeparted__id"
    );
    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(0n);
    expect((await ctx.inventory.getFlight(flightId)).seatsAvailable).to.equal(4n);

    // Still issuable: Used is a terminal non-cancellable state too.
    await (await ctx.nft.connect(ctx.airline).markUsed(tokenId)).wait();
    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).cancel(tokenId),
      ctx.settlement,
      "NotIssued__state"
    );
    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(4n);
  });

  it("rejects cancel from anyone but the current owner", async function () {
    const ctx = await deploy();
    const { flightId } = await publishFlight(ctx, "CXL-6");
    const tokenId = await buy(ctx, flightId);

    await expectCustomError(
      ctx.settlement.connect(ctx.buyer2).cancel(tokenId),
      ctx.settlement,
      "NotTicketOwner__caller"
    );
    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(0n);
    expect((await ctx.inventory.getFlight(flightId)).seatsAvailable).to.equal(4n);
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(PRICE);
    expect(await ctx.settlement.refundReserve(ctx.airline.address)).to.equal(REFUND);
  });

  it("rejects a second cancel of the same ticket", async function () {
    const ctx = await deploy();
    const { flightId } = await publishFlight(ctx, "CXL-7");
    const tokenId = await buy(ctx, flightId);
    await cancelAndParse(ctx, tokenId);

    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).cancel(tokenId),
      ctx.settlement,
      "NotIssued__state"
    );
    // The seat is only released once: inventory stays at full capacity.
    expect((await ctx.inventory.getFlight(flightId)).seatsAvailable).to.equal(5n);
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(RETAINED);
    expect(await ctx.settlement.refundReserve(ctx.airline.address)).to.equal(0n);
    expect(await provider.getBalance(await ctx.settlement.getAddress())).to.equal(RETAINED);
  });

  it("rejects cancel of Listed and Invalid tickets (states only reachable from Phase 4)", async function () {
    const ctx = await deploy();
    const { flightId } = await publishFlight(ctx, "CXL-8");
    const tokenId = await buy(ctx, flightId);

    await forceTicketState(await ctx.nft.getAddress(), tokenId, flightId, ctx.traveler.address, 1);
    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(1n);
    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).cancel(tokenId),
      ctx.settlement,
      "NotIssued__state"
    );

    await forceTicketState(await ctx.nft.getAddress(), tokenId, flightId, ctx.traveler.address, 5);
    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(5n);
    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).cancel(tokenId),
      ctx.settlement,
      "NotIssued__state"
    );

    expect((await ctx.inventory.getFlight(flightId)).seatsAvailable).to.equal(4n);
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(PRICE);
    expect(await ctx.settlement.refundReserve(ctx.airline.address)).to.equal(REFUND);
  });

  it("rejects cancel of an unknown token id", async function () {
    const ctx = await deploy();
    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).cancel(999n),
      [ctx.settlement, ctx.nft],
      "UnknownTicket__id"
    );
  });

  it("pause matrix: cancel and withdrawal stay available while the platform is paused", async function () {
    const ctx = await deploy();
    const { flightId } = await publishFlight(ctx, "CXL-9");
    const tokenId = await buy(ctx, flightId);

    await (await ctx.registry.connect(ctx.admin).pause()).wait();
    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).purchase(flightId, CID, { value: PRICE }),
      ctx.inventory,
      "PlatformPaused__"
    );
    const { refunded } = await cancelAndParse(ctx, tokenId);
    expect(refunded.args.refund).to.equal(REFUND);

    // Settlement-local pause must not block resolution either.
    await (await ctx.settlement.connect(ctx.admin).pause()).wait();
    const receipt = await (
      await ctx.settlement.connect(ctx.airline).withdrawAirlineBalance()
    ).wait();
    assert.equal(receipt.status, 1);
    await (await ctx.settlement.connect(ctx.admin).unpause()).wait();
    await (await ctx.registry.connect(ctx.admin).unpause()).wait();

    await expectCustomError(ctx.settlement.withdrawAirlineBalance(), ctx.settlement, "NothingToWithdraw__");
  });

  it("zero-rate flight: cancel closes the ticket without moving ETH", async function () {
    const ctx = await deploy();
    const departure = (await latest()) + 30 * 24 * 3600;
    await ctx.inventory
      .connect(ctx.airline)
      .createFlight(["ZERO-1", "JFK", "LHR", departure, 5, PRICE, departure - 7 * 24 * 3600, 0, 500]);
    const flightId = (await ctx.inventory.nextFlightId()) - 1n;
    await ctx.inventory.connect(ctx.airline).publishFlight(flightId);
    const tokenId = await buy(ctx, flightId);
    expect(await ctx.settlement.refundReserve(ctx.airline.address)).to.equal(0n);

    const before = await provider.getBalance(ctx.traveler.address);
    const { receipt, refunded } = await cancelAndParse(ctx, tokenId);
    const after = await provider.getBalance(ctx.traveler.address);
    expect(refunded.args.refund).to.equal(0n);
    expect(refunded.args.retained).to.equal(PRICE);
    expect(after + receipt.gasUsed * receipt.gasPrice).to.equal(before);

    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(2n);
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(PRICE);
    expect(await provider.getBalance(await ctx.settlement.getAddress())).to.equal(PRICE);
    expect((await ctx.inventory.getFlight(flightId)).seatsAvailable).to.equal(5n);
  });

  it("withdrawal: pays the retained revenue, keeps the refund escrowed, cancel still pays afterwards", async function () {
    const ctx = await deploy();
    const { flightId } = await publishFlight(ctx, "WD-1");
    const tokenId = await buy(ctx, flightId);

    const before = await provider.getBalance(ctx.airline.address);
    const txPromise = ctx.settlement.connect(ctx.airline).withdrawAirlineBalance();
    const withdrawal = await expectEvent(txPromise, ctx.settlement, "AirlineWithdrawn");
    const receipt = await (await txPromise).wait();
    const gas = receipt.gasUsed * receipt.gasPrice;
    const after = await provider.getBalance(ctx.airline.address);

    expect(withdrawal.args.airline).to.equal(ctx.airline.address);
    expect(withdrawal.args.amount).to.equal(RETAINED);
    expect(after - before + gas).to.equal(RETAINED);

    // Escrow is untouched by withdrawal, so the refund remains fully funded.
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(REFUND);
    expect(await ctx.settlement.refundReserve(ctx.airline.address)).to.equal(REFUND);
    expect(await provider.getBalance(await ctx.settlement.getAddress())).to.equal(REFUND);

    const travelerBefore = await provider.getBalance(ctx.traveler.address);
    const { receipt: cancelReceipt, refunded } = await cancelAndParse(ctx, tokenId);
    const travelerAfter = await provider.getBalance(ctx.traveler.address);
    expect(refunded.args.refund).to.equal(REFUND);
    expect(travelerAfter - travelerBefore + cancelReceipt.gasUsed * cancelReceipt.gasPrice).to.equal(
      REFUND
    );
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(0n);
    expect(await ctx.settlement.refundReserve(ctx.airline.address)).to.equal(0n);
    expect(await provider.getBalance(await ctx.settlement.getAddress())).to.equal(0n);

    await expectCustomError(ctx.settlement.connect(ctx.airline).withdrawAirlineBalance(), ctx.settlement, "NothingToWithdraw__");
  });

  it("withdrawal: only an airline's own credit is paid, never another airline's", async function () {
    const ctx = await deploy();
    const { flightId } = await publishFlight(ctx, "WD-2");
    const tokenId = await buy(ctx, flightId);

    // A second, approved airline has no sales of its own.
    await (await ctx.registry.connect(ctx.admin).approveAirline(ctx.other.address)).wait();
    await expectCustomError(
      ctx.settlement.connect(ctx.other).withdrawAirlineBalance(),
      ctx.settlement,
      "NothingToWithdraw__"
    );
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(PRICE);

    // And it cannot drain the seller's credit either.
    await expectCustomError(ctx.settlement.connect(ctx.other).cancel(tokenId), ctx.settlement, "NotTicketOwner__caller");
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(PRICE);

    await (await ctx.settlement.connect(ctx.airline).withdrawAirlineBalance()).wait();
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(REFUND);

    // Airline with no sales never withdraws anything.
    await expectCustomError(
      ctx.settlement.connect(ctx.other).withdrawAirlineBalance(),
      ctx.settlement,
      "NothingToWithdraw__"
    );
  });

  it("withdrawal with no sales reverts", async function () {
    const ctx = await deploy();
    await expectCustomError(ctx.settlement.connect(ctx.airline).withdrawAirlineBalance(), ctx.settlement, "NothingToWithdraw__");
  });

  it("markUsed enforcement on a purchased ticket: window-gated, airline-only, then cancel refused", async function () {
    const ctx = await deploy();
    const { flightId, departure } = await publishFlight(ctx, "USE-1");
    const tokenId = await buy(ctx, flightId);

    await expectCustomError(
      ctx.nft.connect(ctx.traveler).markUsed(tokenId),
      ctx.nft,
      "NotFlightAirline__caller"
    );
    await expectCustomError(ctx.nft.connect(ctx.airline).markUsed(tokenId), ctx.nft, "CheckinClosed__now");

    await warpTo(departure - 3600);
    await (await ctx.nft.connect(ctx.airline).markUsed(tokenId)).wait();
    expect((await ctx.nft.getTicket(tokenId)).state).to.equal(4n);

    await expectCustomError(
      ctx.settlement.connect(ctx.traveler).cancel(tokenId),
      ctx.settlement,
      "NotIssued__state"
    );
    // A Used ticket never returns its seat to inventory.
    expect((await ctx.inventory.getFlight(flightId)).seatsAvailable).to.equal(4n);
    expect(await ctx.settlement.airlineBalances(ctx.airline.address)).to.equal(PRICE);
    expect(await ctx.settlement.refundReserve(ctx.airline.address)).to.equal(REFUND);

    // No refund is ever previewed for a Used ticket.
    const preview = await ctx.settlement.calculateRefund(tokenId);
    expect(preview.refund).to.equal(0n);
    expect(preview.retained).to.equal(PRICE);
  });

  it("public verifier surface: cancelled ticket stays readable with no PII fields", async function () {
    const ctx = await deploy();
    const { flightId, flightCode } = await publishFlight(ctx, "VERIFY-3");
    const tokenId = await buy(ctx, flightId);
    await cancelAndParse(ctx, tokenId);

    // The read surface the verifier uses exposes exactly these fields - no name/passport/wallet PII.
    const outputs = ctx.nft.interface.getFunction("getTicket").outputs[0].components.map((c) => c.name);
    expect(outputs).to.deep.equal([
      "flightId",
      "seatReference",
      "owner",
      "metadataCID",
      "issuedAt",
      "state",
      "lastTransferAt",
    ]);

    const ticket = await ctx.nft.getTicket(tokenId);
    expect(ticket.state).to.equal(2n);
    expect(ticket.owner).to.equal(ctx.traveler.address);
    expect(ticket.metadataCID).to.equal(CID);
    expect(ticket.flightId).to.equal(flightId);
    expect(ticket.seatReference).to.equal("S-1");
    // Stamped at mint and again on cancellation - never the traveller's personal data.
    expect(ticket.lastTransferAt).to.be.greaterThan(0n);

    const flight = await ctx.inventory.getFlight(ticket.flightId);
    expect(flight.flightCode).to.equal(flightCode);
    expect(flight.departed).to.equal(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 — coverage close-out for TicketSettlement (PRD §17 metric 2): the
// remaining admin gate and the unknown-flight guard of the checkout preview.
// ---------------------------------------------------------------------------

describe("TicketSettlement coverage close-out (Phase 6)", function () {
  it("unpause is admin-only, exactly like pause", async function () {
    const { settlement, other } = await deploy();
    await settlement.pause();
    await expectCustomError(settlement.connect(other).unpause(), settlement, "NotAdmin__caller");
    expect(await settlement.paused()).to.equal(true);
    await settlement.unpause();
    expect(await settlement.paused()).to.equal(false);
  });

  it("previewSeatReference rejects an unknown flight before previewing a seat", async function () {
    const ctx = await deploy();
    const { flightId } = await publishFlight(ctx, "C6-1");
    await expectCustomError(ctx.settlement.previewSeatReference(999), [ctx.settlement, ctx.inventory], "UnknownFlight__id");
    await expectCustomError(ctx.settlement.previewSeatReference(0), [ctx.settlement, ctx.inventory], "UnknownFlight__id");
    expect(await ctx.settlement.previewSeatReference(flightId)).to.equal("S-1");
  });
});
