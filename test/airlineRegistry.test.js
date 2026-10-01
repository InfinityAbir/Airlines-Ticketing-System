import { assert, expect } from "chai";
import { ethers, expectCustomError, expectEvent, getFactory, getSigners } from "./_helpers.js";

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
    await expectCustomError(registry.connect(other).pause(), registry, "AccessControlUnauthorizedAccount");
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
