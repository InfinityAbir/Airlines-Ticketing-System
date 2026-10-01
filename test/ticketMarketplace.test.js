import { expect } from "chai";
import { ethers, expectCustomError, getFactory, getSigners } from "./_helpers.js";

// Phase 1 skeleton: wiring, locked R1 constants, pause shapes. Business logic lands in Phase 4.
describe("TicketMarketplace skeleton (Phase 1)", function () {
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
    const { registry, inventory, nft, marketplace, admin } = await deploy();
    expect(await marketplace.registry()).to.equal(await registry.getAddress());
    expect(await marketplace.inventory()).to.equal(await inventory.getAddress());
    expect(await marketplace.ticketNFT()).to.equal(await nft.getAddress());
    expect(await marketplace.admin()).to.equal(admin.address);
  });

  it("locks R1 constants (120% cap, 24h default duration)", async function () {
    const { marketplace } = await deploy();
    expect(await marketplace.RESALE_CAP_BPS()).to.equal(12000n);
    expect(await marketplace.BPS_DENOMINATOR()).to.equal(10000n);
    expect(await marketplace.DEFAULT_LISTING_DURATION()).to.equal(24n * 3600n);
    expect(await marketplace.nextListingId()).to.equal(1n);
  });

  it("unknown listings revert; local pause is admin-only", async function () {
    const { marketplace, other } = await deploy();
    await expectCustomError(marketplace.getListing(0), marketplace, "UnknownListing__id");
    await expectCustomError(marketplace.connect(other).pause(), marketplace, "NotAdmin__caller");
    await marketplace.pause();
    expect(await marketplace.paused()).to.equal(true);
    await marketplace.unpause();
  });
});
