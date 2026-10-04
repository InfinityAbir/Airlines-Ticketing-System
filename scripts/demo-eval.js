// Phase 6 — scripted demo evaluator for PRD §15 (Demo Scenario) and §17 (Success Metrics).
//
// Runs the complete demonstration from a fresh in-process chain:
//   deploy (5 contracts, generated frontend config) -> seed (approve airline + 5-seat
//   flight) -> the seven PRD §15 steps, each asserted against the chain.
//
//   npm run eval                       # self-contained: fresh chain every run
//   npm run eval -- --network localhost  # deploy + evaluate against a running node
//
// Exit code 0 only when every step passes. Output is a printable checklist that can be
// pasted into doc/STATUS.md or the paper's evaluation section.

import { network } from "hardhat";
import { strict as assert } from "node:assert";
import { deployStack, seedDemo, writeFrontendConfig } from "./lib/stack.js";

const TOTAL = 7;
const ETH = (n) => `${n} ETH`;

// Fixed demo dataset (mirrors scripts/lib/stack.js seed + the locked R1 defaults).
const FARE = 100000000000000000n; // 0.1 ETH
const REFUND_BPS = 8000n; // 80% refund
const ROYALTY_BPS = 500n; // 5% royalty
const EXPECTED_REFUND = (FARE * REFUND_BPS) / 10000n; // 0.08 ETH
const EXPECTED_RETAINED = FARE - EXPECTED_REFUND; // 0.02 ETH
const RESALE_PRICE = (FARE * 11000n) / 10000n; // 0.11 ETH (<= 120% cap)
const EXPECTED_ROYALTY = (RESALE_PRICE * ROYALTY_BPS) / 10000n; // 0.0055 ETH
const EXPECTED_PROCEEDS = RESALE_PRICE - EXPECTED_ROYALTY; // 0.1045 ETH
// Deterministic mock CID (D-05 fallback format: `mock` + 64-bit hex of the payload).
const CID = "mock9f8e7d6c5b4a3928";

const TICKET_FIELDS = [
  "flightId",
  "seatReference",
  "owner",
  "metadataCID",
  "issuedAt",
  "state",
  "lastTransferAt",
];
const STATE = { Issued: 0n, Listed: 1n, Cancelled: 2n, Refunded: 3n, Used: 4n, Invalid: 5n };

function revertData(err) {
  const candidates = [err?.data, err?.error?.data, err?.info?.error?.data, err?.value?.data];
  return candidates.find((d) => typeof d === "string" && d.startsWith("0x"));
}

/// @notice Assert a call reverts with the named custom error (decoded from revert data).
async function expectRevert(promise, contracts, name) {
  const list = Array.isArray(contracts) ? contracts : [contracts];
  let data;
  try {
    const tx = await promise;
    if (tx && typeof tx.wait === "function") await tx.wait();
  } catch (err) {
    data = revertData(err);
    if (!data) {
      const msg = err?.shortMessage || err?.message || String(err);
      if (typeof msg === "string" && msg.includes(name)) return;
      throw new Error(`expected revert ${name}, no revert data (message: ${msg})`);
    }
    for (const c of list) {
      const parsed = c.interface.parseError(data);
      if (parsed && parsed.name === name) return;
      if (parsed) throw new Error(`expected revert ${name}, got ${parsed.name}`);
    }
    throw new Error(`expected revert ${name}, data ${data} did not decode`);
  }
  throw new Error(`expected revert ${name}, but the call succeeded`);
}

/// @notice Every event in a receipt that `contract`'s ABI can decode.
function parseEvents(receipt, contract) {
  const out = [];
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed) out.push(parsed);
    } catch {
      // log from another contract — ignored
    }
  }
  return out;
}

/// @notice Send a transaction and return the first matching parsed event.
async function eventOf(promise, contract, name) {
  const tx = await promise;
  const receipt = await tx.wait();
  const parsed = parseEvents(receipt, contract).find((e) => e.name === name);
  if (!parsed) throw new Error(`expected event ${name} in receipt`);
  return parsed;
}

async function main() {
  const { ethers } = await network.create();
  const [admin, airline, traveler, buyer3] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const provider = ethers.provider;

  console.log(`PRD 15 demo evaluation - chainId ${net.chainId}, in-process Hardhat network`);
  console.log(`admin ${admin.address} | airline ${airline.address}`);
  console.log(`traveler ${traveler.address} | buyer (third wallet) ${buyer3.address}`);
  console.log("");

  // ---- Setup: deterministic dataset (PRD §15 steps 1-2 preconditions) ----
  const stack = await deployStack(ethers);
  const { addresses } = stack;
  writeFrontendConfig({ chainId: Number(net.chainId), addresses });
  const seed = await seedDemo(ethers, addresses);

  const registry = await ethers.getContractAt("AirlineRegistry", addresses.AirlineRegistry);
  const inventory = await ethers.getContractAt("FlightInventory", addresses.FlightInventory);
  const nft = await ethers.getContractAt("AirTicketNFT", addresses.AirTicketNFT);
  const settlement = await ethers.getContractAt("TicketSettlement", addresses.TicketSettlement);
  const marketplace = await ethers.getContractAt("TicketMarketplace", addresses.TicketMarketplace);

  const flightId = BigInt(seed.flightId);
  const results = [];

  async function step(n, title, fn) {
    try {
      const detail = (await fn()) || "";
      results.push({ n, title, ok: true, detail });
      console.log(`[${n}/${TOTAL}] PASS  ${title}${detail ? `  ::  ${detail}` : ""}`);
    } catch (err) {
      results.push({ n, title, ok: false, detail: err.message });
      console.log(`[${n}/${TOTAL}] FAIL  ${title}\n           ${err.message}`);
    }
  }

  // ---- PRD §15 -----------------------------------------------------------------
  await step(1, "The administrator approves a sample airline wallet", async () => {
    assert.equal(await registry.isApproved(airline.address), true, "airline not approved");
    assert.equal(
      await registry.hasRole(await registry.AIRLINE_ROLE(), airline.address),
      true,
      "AIRLINE_ROLE missing"
    );
    assert.equal(await registry.isApproved(traveler.address), false, "unexpected extra approval");
    return `approved ${airline.address}`;
  });

  await step(2, "The airline creates and publishes a flight with five seats", async () => {
    const f = await inventory.getFlight(flightId);
    assert.equal(f.flightCode, "R1-DEMO-001", "flight code mismatch");
    assert.equal(f.airline, airline.address, "flight airline mismatch");
    assert.equal(f.seatCapacity, 5n, "capacity must be 5");
    assert.equal(f.seatsAvailable, 5n, "seats must start full");
    assert.equal(f.priceWei, FARE, "fare mismatch");
    assert.equal(f.refundBps, REFUND_BPS, "refund policy mismatch");
    assert.equal(f.royaltyBps, ROYALTY_BPS, "royalty mismatch");
    assert.equal(f.salesOpen, true, "flight must be published");
    assert.equal(f.departed, false, "flight must not be departed");
    assert.ok(f.departureTime > BigInt(Math.floor(Date.now() / 1000)), "departure must be future");
    return `flightId ${flightId} ${f.flightCode} JFK-LHR seats 5 fare ${ETH(0.1)} refund 80% royalty 5%`;
  });

  await step(3, "A traveler buys a seat with test ETH and receives one NFT ticket", async () => {
    const before = await provider.getBalance(await settlement.getAddress());
    const ev = await eventOf(
      settlement.connect(traveler).purchase(flightId, CID, { value: FARE }),
      settlement,
      "PurchaseCompleted"
    );
    assert.equal(ev.args.buyer, traveler.address, "buyer mismatch");
    assert.equal(ev.args.flightId, flightId, "flight mismatch");
    assert.equal(ev.args.cid, CID, "CID mismatch");

    const tokenId = ev.args.tokenId;
    const t = await nft.getTicket(tokenId);
    assert.equal(t.state, STATE.Issued, "ticket must be Issued");
    assert.equal(t.owner, traveler.address, "owner mismatch");
    assert.equal(t.seatReference, "S-1", "first seat must be S-1");
    assert.equal(t.metadataCID, CID, "recorded CID mismatch");
    assert.equal(t.flightId, flightId, "ticket flight mismatch");
    assert.ok(t.issuedAt > 0n, "issuedAt missing");

    const f = await inventory.getFlight(flightId);
    assert.equal(f.seatsAvailable, 4n, "inventory must drop by one");
    assert.equal(await settlement.airlineBalances(airline.address), FARE, "airline credit wrong");
    assert.equal(
      await settlement.refundReserve(airline.address),
      EXPECTED_REFUND,
      "refund escrow wrong"
    );
    const after = await provider.getBalance(await settlement.getAddress());
    assert.equal(after - before, FARE, "contract must hold exactly the fare");
    return `tokenId ${tokenId} seat ${t.seatReference} cid source mock fallback, balance ${ETH(0.1)}`;
  });

  let resoldTokenId = 1n;
  await step(4, "The traveler opens the issued ticket and verifies it on the public page", async () => {
    // PRD §17 metric 5: the verifier surface is exactly seven non-identity fields.
    // `getTicket` returns one struct, so the field list lives in the tuple's components.
    const outputs = nft.interface.getFunction("getTicket").outputs;
    assert.equal(outputs.length, 1, "getTicket must return a single struct");
    assert.equal(outputs[0].type, "tuple", "getTicket must return the Ticket struct");
    const fields = outputs[0].components;
    assert.equal(fields.length, 7, "verifier surface must expose exactly seven fields");
    assert.deepEqual(fields.map((o) => o.name), TICKET_FIELDS, "verifier field set changed");
    const banned = ["name", "email", "passport", "dob", "phone", "document"];
    for (const o of fields) {
      assert.ok(!banned.includes(o.name.toLowerCase()), `PII-like field exposed: ${o.name}`);
    }

    const t = await nft.getTicket(resoldTokenId);
    assert.equal(t.state, STATE.Issued, "issued ticket must verify as Issued");
    assert.equal(t.metadataCID, CID, "CID must be readable for the match check");
    const [refund, retained] = await settlement.calculateRefund(resoldTokenId);
    assert.equal(refund, EXPECTED_REFUND, "refund preview must match policy");
    assert.equal(retained, EXPECTED_RETAINED, "retained preview must match policy");
    return `7 fields, no personal data, state Issued, refund preview ${ETH(0.08)}/${ETH(0.02)}`;
  });

  let listingId = 0n;
  await step(5, "The ticket is listed and a third wallet buys it (royalty split)", async () => {
    const preview = await marketplace.previewResale(resoldTokenId, RESALE_PRICE);
    assert.equal(preview.maxPriceWei, (FARE * 12000n) / 10000n, "120% cap mismatch");
    assert.equal(preview.royalty, EXPECTED_ROYALTY, "preview royalty mismatch");
    assert.equal(preview.sellerProceeds, EXPECTED_PROCEEDS, "preview proceeds mismatch");
    assert.ok(preview.defaultExpiry > BigInt(Math.floor(Date.now() / 1000)), "expiry must be future");

    const listEv = await eventOf(
      marketplace
        .connect(traveler)
        .list(resoldTokenId, RESALE_PRICE, preview.defaultExpiry),
      marketplace,
      "ListingCreated"
    );
    listingId = listEv.args.listingId;
    assert.equal((await nft.getTicket(resoldTokenId)).state, STATE.Listed, "ticket must be Listed");

    const airlineBefore = await provider.getBalance(airline.address);
    const sellerBefore = await provider.getBalance(traveler.address);
    const contractBefore = await provider.getBalance(await marketplace.getAddress());

    const soldEv = await eventOf(
      marketplace.connect(buyer3).buyListing(listingId, { value: RESALE_PRICE }),
      marketplace,
      "ListingSold"
    );

    // PRD §17 metric 6: 100% of the payment is accounted for as royalty + proceeds.
    assert.equal(soldEv.args.priceWei, RESALE_PRICE, "price mismatch");
    assert.equal(soldEv.args.royalty, EXPECTED_ROYALTY, "royalty mismatch");
    assert.equal(soldEv.args.sellerProceeds, EXPECTED_PROCEEDS, "proceeds mismatch");
    assert.equal(
      soldEv.args.royalty + soldEv.args.sellerProceeds,
      soldEv.args.priceWei,
      "royalty + proceeds must equal the payment exactly"
    );
    assert.equal(soldEv.args.buyer, buyer3.address, "buyer mismatch");

    assert.equal(
      await provider.getBalance(airline.address),
      airlineBefore + EXPECTED_ROYALTY,
      "airline must receive exactly the royalty"
    );
    assert.equal(
      await provider.getBalance(traveler.address),
      sellerBefore + EXPECTED_PROCEEDS,
      "seller must receive exactly the remainder"
    );
    assert.equal(
      await provider.getBalance(await marketplace.getAddress()),
      contractBefore,
      "marketplace must never hold ETH (pass-through)"
    );

    const t = await nft.getTicket(resoldTokenId);
    assert.equal(t.owner, buyer3.address, "ownership must move to the third wallet");
    assert.equal(t.state, STATE.Issued, "resold ticket returns to Issued");
    assert.equal((await marketplace.getListing(listingId)).active, false, "listing must close");
    return `price ${ETH(0.11)} = royalty ${ETH(0.0055)} + seller ${ETH(0.1045)} (exact)`;
  });

  let cancelledTokenId = 2n;
  await step(6, "A second ticket is bought and cancelled before the deadline", async () => {
    const buyEv = await eventOf(
      settlement.connect(traveler).purchase(flightId, CID, { value: FARE }),
      settlement,
      "PurchaseCompleted"
    );
    cancelledTokenId = buyEv.args.tokenId;
    assert.notEqual(cancelledTokenId, resoldTokenId, "must be a second, different ticket");
    assert.equal((await nft.getTicket(cancelledTokenId)).seatReference, "S-2", "seat must be S-2");

    const [previewRefund, previewRetained] = await settlement.calculateRefund(cancelledTokenId);
    assert.equal(previewRefund, EXPECTED_REFUND, "preview refund mismatch");
    assert.equal(previewRetained, EXPECTED_RETAINED, "preview retained mismatch");

    const contractBefore = await provider.getBalance(await settlement.getAddress());
    const receipt = await (await settlement.connect(traveler).cancel(cancelledTokenId)).wait();
    const events = parseEvents(receipt, settlement);
    const cancelledEv = events.find((e) => e.name === "TicketCancelled");
    const refundEv = events.find((e) => e.name === "TicketRefunded");

    assert.ok(cancelledEv, "TicketCancelled event missing");
    assert.equal(cancelledEv.args.owner, traveler.address, "cancel owner mismatch");
    // Refund detail travels in its own event (R1 single terminal `Cancelled` state).
    assert.ok(refundEv, "TicketRefunded event missing");
    assert.equal(refundEv.args.tokenId, cancelledTokenId, "refund event ticket mismatch");
    assert.equal(refundEv.args.refund, EXPECTED_REFUND, "TicketRefunded refund mismatch");
    assert.equal(refundEv.args.retained, EXPECTED_RETAINED, "TicketRefunded retained mismatch");
    // The transaction hash comes from the wallet receipt, never from an event (D-16).
    assert.match(receipt.hash, /^0x[0-9a-f]{64}$/, "receipt must carry the transaction hash");
    // A second cancel must be rejected by the terminal state.
    await expectRevert(settlement.connect(traveler).cancel(cancelledTokenId), settlement, "NotIssued__state");

    const t = await nft.getTicket(cancelledTokenId);
    assert.equal(t.state, STATE.Cancelled, "ticket must reach the terminal Cancelled state");

    const contractAfter = await provider.getBalance(await settlement.getAddress());
    assert.equal(contractBefore - contractAfter, EXPECTED_REFUND, "refund transfer amount wrong");
    assert.equal(
      await settlement.airlineBalances(airline.address),
      FARE * 2n - EXPECTED_REFUND,
      "airline balance must be debited by the refund"
    );
    assert.equal(
      await settlement.refundReserve(airline.address),
      EXPECTED_REFUND * 2n - EXPECTED_REFUND,
      "refund escrow must release one ticket's reserve"
    );
    const f = await inventory.getFlight(flightId);
    assert.equal(f.seatsAvailable, 4n, "cancelled seat must return to inventory");
    return `tokenId ${cancelledTokenId} Cancelled, refund ${ETH(0.08)} retained ${ETH(0.02)}`;
  });

  await step(7, "The operator marks the flight departed; cancel and resale are blocked", async () => {
    await eventOf(inventory.connect(airline).markDeparted(flightId), inventory, "FlightDeparted");
    const f = await inventory.getFlight(flightId);
    assert.equal(f.departed, true, "flight must be departed");
    assert.equal(f.salesOpen, false, "sales must close on departure");

    // Already-cancelled ticket stays cancelled and readable.
    assert.equal((await nft.getTicket(cancelledTokenId)).state, STATE.Cancelled, "cancel is terminal");

    // New cancellation of the resold ticket: blocked after departure.
    await expectRevert(
      settlement.connect(buyer3).cancel(resoldTokenId),
      [settlement, inventory],
      "FlightDeparted__id"
    );
    // New resale listing: blocked after departure.
    await expectRevert(
      marketplace.connect(buyer3).list(resoldTokenId, RESALE_PRICE, previewExpiry(await marketplace, resoldTokenId)),
      [marketplace, inventory],
      "FlightDeparted__id"
    );
    // New booking: blocked after departure.
    await expectRevert(
      settlement.connect(traveler).purchase(flightId, CID, { value: FARE }),
      [settlement, inventory],
      "FlightDeparted__id"
    );
    // The ticket that never left the Issued state is still verifiable.
    assert.equal((await nft.getTicket(resoldTokenId)).state, STATE.Issued, "resold ticket stays Issued");
    return "cancel, resale and booking all revert with FlightDeparted__id";
  });

  // ---- Summary ----------------------------------------------------------------
  const passed = results.filter((r) => r.ok).length;
  console.log("");
  console.log(`Demo evaluation: ${passed}/${TOTAL} PRD 15 steps passed.`);
  console.log(
    JSON.stringify(
      {
        chainId: Number(net.chainId),
        contracts: addresses,
        flightId: seed.flightId,
        tickets: { resold: resoldTokenId.toString(), cancelled: cancelledTokenId.toString() },
        split: {
          priceWei: RESALE_PRICE.toString(),
          royalty: EXPECTED_ROYALTY.toString(),
          sellerProceeds: EXPECTED_PROCEEDS.toString(),
        },
        refund: {
          refund: EXPECTED_REFUND.toString(),
          retained: EXPECTED_RETAINED.toString(),
        },
        passed,
        total: TOTAL,
      },
      null,
      2
    )
  );

  if (passed !== TOTAL) process.exitCode = 1;
}

/// @notice Expiry the UI would pick (previewResale.defaultExpiry), for the blocked-resale attempt.
async function previewExpiry(marketplace, tokenId) {
  const p = await marketplace.previewResale(tokenId, RESALE_PRICE);
  return p.defaultExpiry;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
