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
