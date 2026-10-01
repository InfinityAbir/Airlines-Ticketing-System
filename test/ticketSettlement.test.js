import { expect } from "chai";
import { ethers, expectCustomError, getFactory, getSigners } from "./_helpers.js";

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
