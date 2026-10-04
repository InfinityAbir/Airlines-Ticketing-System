import { assert, expect } from "chai";
import {
  ethers,
  expectCustomError,
  expectEvent,
  getFactory,
  getSigners,
  latest,
} from "./_helpers.js";

function flightArgs(code, departure, capacity = 5) {
  return [
    code,
    "JFK",
    "LHR",
    departure,
    capacity,
    ethers.parseEther("0.1"),
    departure - 7 * 24 * 3600,
    8000,
    500,
  ];
}

describe("FlightInventory (Phase 1)", function () {
  async function deploy() {
    const [admin, airline, other, settler, market] = await getSigners();
    const Registry = await getFactory("AirlineRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();
    const Inventory = await getFactory("FlightInventory");
    const inventory = await Inventory.deploy(await registry.getAddress(), admin.address);
    await inventory.waitForDeployment();
    await registry.connect(admin).approveAirline(airline.address);
    await inventory.connect(admin).setAuthorizedParties(settler.address, market.address);
    return { registry, inventory, admin, airline, other, settler, market };
  }

  it("creates a flight in Draft with full field record + event", async function () {
    const { inventory, airline } = await deploy();
    const dep = (await latest()) + 30 * 24 * 3600;
    const ev = await expectEvent(
      inventory.connect(airline).createFlight(flightArgs("R1-001", dep)),
      inventory,
      "FlightCreated"
    );
    assert.equal(ev.args.flightId, 1n);
    assert.equal(ev.args.airline, airline.address);
    const f = await inventory.getFlight(1);
    expect(f.seatCapacity).to.equal(5n);
    expect(f.seatsAvailable).to.equal(5n);
    expect(f.salesOpen).to.equal(false);
    expect(f.royaltyBps).to.equal(500n);
  });

  it("rejects invalid flight data (FR-08)", async function () {
    const { registry, inventory, admin, airline } = await deploy();
    const now = await latest();
    await expectCustomError(
      inventory.connect(airline).createFlight(flightArgs("P-1", now - 10)),
      inventory,
      "PastDeparture__time"
    );
    await expectCustomError(
      inventory.connect(airline).createFlight(flightArgs("P-2", now + 1000, 0)),
      inventory,
      "ZeroCapacity__"
    );
    const dep = now + 30 * 24 * 3600;
    await expectCustomError(
      inventory.connect(airline).createFlight(["P-3", "JFK", "LHR", dep, 5, 100, dep + 1, 8000, 500]),
      inventory,
      "InvalidRefundDeadline__deadline"
    );
    await expectCustomError(
      inventory.connect(airline).createFlight(["P-4", "JFK", "LHR", dep, 5, 100, dep - 10, 10001, 500]),
      inventory,
      "RefundRateTooHigh__bps"
    );
    await expectCustomError(
      inventory.connect(airline).createFlight(["P-5", "JFK", "LHR", dep, 5, 100, dep - 10, 8000, 1001]),
      inventory,
      "RoyaltyAboveCap__bps"
    );
    await inventory.connect(airline).createFlight(flightArgs("DUP", dep));
    await expectCustomError(
      inventory.connect(airline).createFlight(flightArgs("DUP", dep + 100)),
      inventory,
      "DuplicateFlightCode__code"
    );
    const signers = await getSigners();
    const unapproved = signers[5];
    await expectCustomError(
      inventory.connect(unapproved).createFlight(flightArgs("P-6", dep)),
      inventory,
      "UnauthorizedAirline__caller"
    );
    await registry.connect(admin).setLimits(100, 10000);
    await expectCustomError(
      inventory.connect(airline).createFlight(flightArgs("P-7", dep)),
      inventory,
      "RoyaltyAboveCap__bps"
    );
  });

  it("allows code reuse only after cancellation", async function () {
    const { inventory, airline } = await deploy();
    const dep = (await latest()) + 30 * 24 * 3600;
    await inventory.connect(airline).createFlight(flightArgs("REUSE", dep));
    await inventory.connect(airline).cancelFlight(1);
    const ev = await expectEvent(
      inventory.connect(airline).createFlight(flightArgs("REUSE", dep + 50)),
      inventory,
      "FlightCreated"
    );
    assert.equal(ev.args.flightId, 2n);
  });

  it("publish/pauseSales/cancel/markDeparted lifecycle + access control", async function () {
    const { inventory, airline, other } = await deploy();
    const dep = (await latest()) + 30 * 24 * 3600;
    await inventory.connect(airline).createFlight(flightArgs("L-1", dep));
    await expectCustomError(inventory.connect(other).publishFlight(1), inventory, "NotFlightAirline__caller");
    await expectEvent(inventory.connect(airline).publishFlight(1), inventory, "FlightPublished");
    await inventory.connect(airline).pauseSales(1);
    expect((await inventory.getFlight(1)).salesOpen).to.equal(false);
    await inventory.connect(airline).publishFlight(1);
    await expectEvent(inventory.connect(airline).markDeparted(1), inventory, "FlightDeparted");
    const f = await inventory.getFlight(1);
    expect(f.departed).to.equal(true);
    expect(f.salesOpen).to.equal(false);
  });

  it("reserve/release gates + inventory math", async function () {
    const { inventory, airline, other, settler } = await deploy();
    const dep = (await latest()) + 30 * 24 * 3600;
    await inventory.connect(airline).createFlight(flightArgs("S-1", dep, 1));
    await inventory.connect(airline).publishFlight(1);
    await expectCustomError(
      inventory.connect(other).reserveSeat(1),
      inventory,
      "UnauthorizedCaller__caller"
    );
    const ev = await expectEvent(inventory.connect(settler).reserveSeat(1), inventory, "SeatReserved");
    assert.equal(ev.args.seatsAvailable, 0n);
    await expectCustomError(inventory.connect(settler).reserveSeat(1), inventory, "NoSeatsAvailable__id");
    const ev2 = await expectEvent(inventory.connect(settler).releaseSeat(1), inventory, "SeatReleased");
    assert.equal(ev2.args.seatsAvailable, 1n);
    await expectCustomError(
      inventory.connect(settler).releaseSeat(1),
      inventory,
      "InventoryFull__id"
    );
  });

  it("pause matrix: create/publish blocked; markDeparted + reads remain", async function () {
    const { registry, inventory, admin, airline } = await deploy();
    const dep = (await latest()) + 30 * 24 * 3600;
    await inventory.connect(airline).createFlight(flightArgs("PM-1", dep));
    await inventory.connect(airline).createFlight(flightArgs("PM-2", dep + 100));
    await registry.connect(admin).pause();
    await expectCustomError(
      inventory.connect(airline).createFlight(flightArgs("PM-3", dep)),
      inventory,
      "PlatformPaused__"
    );
    await expectCustomError(inventory.connect(airline).publishFlight(1), inventory, "PlatformPaused__");
    expect((await inventory.getFlight(1)).flightCode).to.equal("PM-1");
    // markDeparted remains available while paused (restrictive action).
    await expectEvent(inventory.connect(airline).markDeparted(2), inventory, "FlightDeparted");
    await registry.connect(admin).unpause();
    // Flight 1 never departed, so it can publish once the platform is live again.
    await expectEvent(inventory.connect(airline).publishFlight(1), inventory, "FlightPublished");
  });
});

// ---------------------------------------------------------------------------
// Phase 6 — coverage close-out. PRD §17 metric 2 demands a passing success and
// failure path for every public state-changing function; these tests add the
// paths the earlier phases did not reach (wiring guards, double actions,
// terminal-state transitions and unknown-id reads on this contract).
// ---------------------------------------------------------------------------

describe("FlightInventory coverage close-out (Phase 6)", function () {
  async function deploy() {
    const [admin, airline, other, settler, market] = await getSigners();
    const Registry = await getFactory("AirlineRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();
    const Inventory = await getFactory("FlightInventory");
    const inventory = await Inventory.deploy(await registry.getAddress(), admin.address);
    await inventory.waitForDeployment();
    await registry.connect(admin).approveAirline(airline.address);
    await inventory.connect(admin).setAuthorizedParties(settler.address, market.address);
    return { registry, inventory, admin, airline, other, settler, market };
  }

  it("constructor rejects a zero registry or admin", async function () {
    const [admin] = await getSigners();
    const Registry = await getFactory("AirlineRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();
    const Inventory = await getFactory("FlightInventory");
    await expectCustomError(
      Inventory.deploy(ethers.ZeroAddress, admin.address),
      Inventory,
      "ZeroAddress__account"
    );
    await expectCustomError(
      Inventory.deploy(await registry.getAddress(), ethers.ZeroAddress),
      Inventory,
      "ZeroAddress__account"
    );
  });

  it("setAuthorizedParties is admin-only, rejects zero addresses and emits its re-wire", async function () {
    const { inventory, admin, other, settler, market } = await deploy();
    await expectCustomError(
      inventory.connect(other).setAuthorizedParties(settler.address, market.address),
      inventory,
      "AccessControlUnauthorizedAccount"
    );
    await expectCustomError(
      inventory.connect(admin).setAuthorizedParties(ethers.ZeroAddress, market.address),
      inventory,
      "ZeroAddress__account"
    );
    await expectCustomError(
      inventory.connect(admin).setAuthorizedParties(settler.address, ethers.ZeroAddress),
      inventory,
      "ZeroAddress__account"
    );
    const ev = await expectEvent(
      inventory.connect(admin).setAuthorizedParties(market.address, settler.address),
      inventory,
      "AuthorizedPartiesUpdated"
    );
    assert.equal(ev.args.settlement, market.address);
    assert.equal(ev.args.marketplace, settler.address);
    expect(await inventory.settlement()).to.equal(market.address);
    expect(await inventory.marketplace()).to.equal(settler.address);
  });

  it("publish, cancel and depart reject unknown flights and every double action", async function () {
    const { inventory, airline } = await deploy();
    const dep = (await latest()) + 30 * 24 * 3600;
    await inventory.connect(airline).createFlight(flightArgs("C6-A", dep));
    await inventory.connect(airline).createFlight(flightArgs("C6-B", dep + 100));
    await inventory.connect(airline).createFlight(flightArgs("C6-C", dep + 200));

    // Unknown ids fall through the `onlyFlightAirline` modifier first: nobody owns a
    // flight that does not exist, so the operator gate is what answers.
    await expectCustomError(inventory.connect(airline).publishFlight(99), inventory, "NotFlightAirline__caller");
    await expectCustomError(inventory.connect(airline).pauseSales(99), inventory, "NotFlightAirline__caller");
    await expectCustomError(inventory.connect(airline).cancelFlight(99), inventory, "NotFlightAirline__caller");
    await expectCustomError(inventory.connect(airline).markDeparted(99), inventory, "NotFlightAirline__caller");

    // Flight 1: publish → depart → both a re-publish and a late cancel are refused.
    await inventory.connect(airline).publishFlight(1);
    await inventory.connect(airline).markDeparted(1);
    expect((await inventory.getFlight(1)).salesOpen).to.equal(false);
    await expectCustomError(inventory.connect(airline).publishFlight(1), inventory, "AlreadyDeparted__id");
    await expectCustomError(inventory.connect(airline).cancelFlight(1), inventory, "AlreadyDeparted__id");
    // A second departure is idempotent: the flight is already gone, nothing changes.
    await expectEvent(inventory.connect(airline).markDeparted(1), inventory, "FlightDeparted");
    expect((await inventory.getFlight(1)).departed).to.equal(true);

    // Flight 2: cancel → a re-cancel, a re-publish and a later departure are refused.
    await inventory.connect(airline).cancelFlight(2);
    await expectCustomError(inventory.connect(airline).cancelFlight(2), inventory, "AlreadyCancelled__id");
    await expectCustomError(inventory.connect(airline).publishFlight(2), inventory, "AlreadyCancelled__id");
    await expectCustomError(inventory.connect(airline).markDeparted(2), inventory, "AlreadyCancelled__id");
    expect((await inventory.getFlight(2)).cancelled).to.equal(true);

    // Flight 3: departure first, then cancelling that departed flight is refused.
    await inventory.connect(airline).markDeparted(3);
    await expectCustomError(inventory.connect(airline).cancelFlight(3), inventory, "AlreadyDeparted__id");
  });

  it("pauseSales and markDeparted reject callers outside the flight's airline", async function () {
    const { inventory, airline, other } = await deploy();
    const dep = (await latest()) + 30 * 24 * 3600;
    await inventory.connect(airline).createFlight(flightArgs("C6-D", dep));
    await expectCustomError(inventory.connect(other).pauseSales(1), inventory, "NotFlightAirline__caller");
    await expectCustomError(inventory.connect(other).markDeparted(1), inventory, "NotFlightAirline__caller");
    expect((await inventory.getFlight(1)).salesOpen).to.equal(false);
    expect((await inventory.getFlight(1)).departed).to.equal(false);
  });

  it("reserve/release reject unknown flights for an authorized party", async function () {
    const { inventory, settler } = await deploy();
    await expectCustomError(inventory.connect(settler).reserveSeat(77), inventory, "UnknownFlight__id");
    await expectCustomError(inventory.connect(settler).releaseSeat(77), inventory, "UnknownFlight__id");
    await expectCustomError(inventory.connect(settler).reserveSeat(0), inventory, "UnknownFlight__id");
  });
});
