import { assert, expect } from "chai";
import {
  ethers,
  expectCustomError,
  expectEvent,
  getFactory,
  getSigners,
  latest,
  warpTo,
} from "./_helpers.js";

describe("AirTicketNFT (Phase 1)", function () {
  async function deploy() {
    const [admin, airline, traveler, market, settlerEOA] = await getSigners();
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

    await registry.connect(admin).approveAirline(airline.address);
    const dep = (await latest()) + 30 * 24 * 3600;
    await inventory.connect(airline).createFlight([
      "NFT-001",
      "JFK",
      "LHR",
      dep,
      5,
      ethers.parseEther("0.1"),
      dep - 7 * 24 * 3600,
      8000,
      500,
    ]);
    // Wire settlement slot to a test-controlled EOA so the Phase 1 mint stub is callable.
    await nft.connect(admin).setSettlement(settlerEOA.address);
    return { registry, inventory, nft, admin, airline, traveler, market, settlerEOA, departure: dep };
  }

  it("mint stub gates settlement + CID + pause", async function () {
    const { registry, nft, admin, traveler, settlerEOA } = await deploy();
    await expectCustomError(
      nft.connect(traveler).mint(traveler.address, 1, "S-1", "cid"),
      nft,
      "UnauthorizedSettlement__caller"
    );
    await expectCustomError(
      nft.connect(settlerEOA).mint(traveler.address, 1, "S-1", ""),
      nft,
      "EmptyCid__"
    );
    const ev = await expectEvent(
      nft.connect(settlerEOA).mint(traveler.address, 1, "S-1", "bafy-test-cid-1"),
      nft,
      "TicketMinted"
    );
    assert.equal(ev.args.tokenId, 1n);
    const t = await nft.getTicket(1);
    expect(t.owner).to.equal(traveler.address);
    expect(t.state).to.equal(0n); // Issued
    await registry.connect(admin).pause();
    await expectCustomError(
      nft.connect(settlerEOA).mint(traveler.address, 1, "S-2", "bafy-test-cid-2"),
      nft,
      "PlatformPaused__"
    );
    await registry.connect(admin).unpause();
  });

  it("direct ERC-721 transfers revert; controlledTransfer needs role + pause-live", async function () {
    const { registry, nft, admin, traveler, market, settlerEOA } = await deploy();
    const signers = await getSigners();
    const buyer = signers[5];
    await nft.connect(settlerEOA).mint(traveler.address, 1, "S-1", "bafy-test-cid-1");
    await expectCustomError(
      nft.connect(traveler).transferFrom(traveler.address, buyer.address, 1),
      nft,
      "DirectTransferBlocked__"
    );
    await expectCustomError(
      nft.connect(market).controlledTransfer(traveler.address, buyer.address, 1),
      nft,
      "AccessControlUnauthorizedAccount"
    );
    const MARKETPLACE_ROLE = await nft.MARKETPLACE_ROLE();
    await nft.connect(admin).grantRole(MARKETPLACE_ROLE, market.address);
    await registry.connect(admin).pause();
    await expectCustomError(
      nft.connect(market).controlledTransfer(traveler.address, buyer.address, 1),
      nft,
      "PlatformPaused__"
    );
    await registry.connect(admin).unpause();
    const ev = await expectEvent(
      nft.connect(market).controlledTransfer(traveler.address, buyer.address, 1),
      nft,
      "TicketTransferred"
    );
    assert.equal(ev.args.tokenId, 1n);
    expect((await nft.getTicket(1)).owner).to.equal(buyer.address);
  });

  it("markUsed locks: airline-only, window-gated, pause-proof", async function () {
    const { registry, nft, admin, airline, traveler, settlerEOA, departure } = await deploy();
    await nft.connect(settlerEOA).mint(traveler.address, 1, "S-1", "bafy-test-cid-1");
    await expectCustomError(nft.connect(traveler).markUsed(1), nft, "NotFlightAirline__caller");
    await expectCustomError(nft.connect(airline).markUsed(1), nft, "CheckinClosed__now");
    await warpTo(departure - 3600);
    await registry.connect(admin).pause();
    await expectEvent(nft.connect(airline).markUsed(1), nft, "TicketMarkedUsed");
    expect((await nft.getTicket(1)).state).to.equal(4n); // Used
    await expectCustomError(nft.connect(airline).markUsed(1), nft, "NotIssued__state");
    await registry.connect(admin).unpause();
  });

  it("invalidateAsCancelled is settlement-only and pause-proof", async function () {
    const { registry, nft, admin, traveler, settlerEOA } = await deploy();
    await nft.connect(settlerEOA).mint(traveler.address, 1, "S-1", "bafy-test-cid-1");
    await expectCustomError(
      nft.connect(traveler).invalidateAsCancelled(1),
      nft,
      "UnauthorizedSettlement__caller"
    );
    await registry.connect(admin).pause();
    await expectEvent(nft.connect(settlerEOA).invalidateAsCancelled(1), nft, "TicketInvalidated");
    expect((await nft.getTicket(1)).state).to.equal(2n); // Cancelled
    await registry.connect(admin).unpause();
  });

  it("royaltyInfo mirrors the flight royaltyBps (display-only)", async function () {
    const { nft, traveler, settlerEOA } = await deploy();
    await nft.connect(settlerEOA).mint(traveler.address, 1, "S-1", "bafy-test-cid-1");
    const salePrice = ethers.parseEther("1");
    const [receiver, amount] = await nft.royaltyInfo(1, salePrice);
    const signers = await getSigners();
    expect(receiver).to.equal(signers[1].address);
    expect(amount).to.equal((salePrice * 500n) / 10000n);
  });
});
