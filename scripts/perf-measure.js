// Measurement body for `npm run perf` — spawned by scripts/perf-eval.js as
//   hardhat run scripts/perf-measure.js --network localhost
// against a local HTTP node, so every latency figure includes a real JSON-RPC
// round-trip. Phases run in this order:
//
//   A. Latency under automine:    execution + RPC round-trip per lifecycle write,
//                                 plus contract-read latency (N samples each).
//   C. Throughput under automine: concurrent purchase burst (TPS) and read QPS.
//   B. Under 1 s interval mining: confirmation latency per write, a 100-purchase
//                                 burst (sustained TPS, txs per block), markDeparted.
//
// Timing uses a dedicated raw provider (cacheTimeout -1) with an explicit 25 ms
// receipt-poll: the default provider deduplicates identical calls for 250 ms and
// throttles receipt observation through its 4 s polling loop, which would fake
// both read latency and burst completion. Gas for every measured transaction is
// collected throughout; deployment gas comes from deployStack. Results print as
// tables and are written to PERF_OUT (default doc/perf-eval.json). The optimizer
// A/B comparison runs the whole script a second time with SOLC_OPTIMIZER=1.
import { network } from "hardhat";
import { JsonRpcProvider } from "ethers";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { deployStack } from "./lib/stack.js";

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, "..");
const OUT_PATH = path.join(ROOT, process.env.PERF_OUT ?? "doc/perf-eval.json");
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";

const FARE = 100000000000000000n; // 0.1 ETH
const RESALE_PRICE = (FARE * 11000n) / 10000n; // 0.11 ETH (within the 120% cap)
const CID = "mock9f8e7d6c5b4a3928";

const N_AUTOMINE = 20; // latency samples per write op, automine
const N_INTERVAL = 10; // latency samples per write op, 1 s interval mining
const N_DEPART = 10; // markDeparted samples, automine (one flight each)
const N_DEPART_INTERVAL = 3; // markDeparted samples, interval mining
const BURST = 100; // purchases per throughput burst
const READ_SAMPLES = 100; // per read type, latency
const READ_QPS_SAMPLES = 500; // sequential reads for the QPS figure
const BLOCK_MS = 1000; // simulated block interval
const POLL_MS = 25; // receipt/block observation granularity

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stats(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.max(0, Math.ceil(p * s.length) - 1)];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    n: s.length,
    min: r1(s[0]),
    p50: r1(q(0.5)),
    p95: r1(q(0.95)),
    max: r1(s[s.length - 1]),
    mean: r1(mean),
  };
}

function gasStats(values) {
  if (!values.length) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    n: values.length,
    mean: Math.round(mean),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

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

async function main() {
  const { ethers } = await network.create();
  const provider = ethers.provider;
  // Raw, never-caching view of the same node for every timed observation.
  const raw = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
  const net = await provider.getNetwork();
  const [admin, airline, traveler, buyer, secondPurchaser] = await ethers.getSigners();

  /// @notice Poll a transaction hash on the raw provider until its receipt exists.
  async function rawWait(hash) {
    for (;;) {
      const receipt = await raw.getTransactionReceipt(hash);
      if (receipt) return receipt;
      await sleep(POLL_MS);
    }
  }

  /// @notice End-to-end write latency: send + receipt observed on the raw provider.
  async function measureTx(txPromise) {
    const t0 = performance.now();
    const tx = await txPromise;
    const receipt = await rawWait(tx.hash);
    return { ms: performance.now() - t0, gas: Number(receipt.gasUsed), receipt };
  }

  async function measureRead(fn) {
    const t0 = performance.now();
    await fn();
    return performance.now() - t0;
  }

  /// @notice Direct JSON-RPC eth_call over fetch — the endpoint floor, without the
  ///         ethers client's per-request overhead (~15 ms on this stack).
  async function ethCallMs(to, data) {
    const t0 = performance.now();
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    });
    await res.json();
    return performance.now() - t0;
  }

  function pushSample(buckets, op, { ms, gas }) {
    const b = (buckets[op] ??= { ms: [], gas: [] });
    b.ms.push(Math.round(ms * 10) / 10);
    b.gas.push(gas);
  }

  console.log(`perf measurement - chainId ${net.chainId}, HTTP JSON-RPC (${RPC_URL})`);
  console.log(
    `optimizer ${process.env.SOLC_OPTIMIZER === "1" ? "ENABLED (runs=200)" : "disabled (default)"}, ` +
      `samples: automine=${N_AUTOMINE}, interval=${N_INTERVAL}, burst=${BURST}`
  );
  console.log("");

  // ---- Setup ----------------------------------------------------------------
  const stack = await deployStack(ethers);
  const { addresses, deployGas } = stack;
  if (!(await stack.registry.isApproved(airline.address))) {
    await (await stack.registry.connect(admin).approveAirline(airline.address)).wait();
  }
  const inventory = stack.inventory;
  const settlement = stack.settlement;
  const marketplace = stack.marketplace;
  const nft = stack.nft;
  // Read-only raw-connected instances (no call dedup, no receipt involvement).
  const nftR = nft.connect(raw);
  const inventoryR = inventory.connect(raw);
  const settlementR = settlement.connect(raw);

  const nowSec = () => Math.floor(Date.now() / 1000);
  async function createFlight(code, seats) {
    const departure = nowSec() + 30 * 24 * 3600;
    const refundDeadline = departure - 7 * 24 * 3600;
    const tx = await inventory.connect(airline).createFlight([
      code, "JFK", "LHR", departure, seats, FARE, refundDeadline, 8000, 500,
    ]);
    const receipt = await tx.wait();
    const ev = parseEvents(receipt, inventory).find((e) => e.name === "FlightCreated");
    const id = ev.args.flightId;
    await (await inventory.connect(airline).publishFlight(id)).wait();
    return id;
  }

  async function purchase(signer, flightId) {
    const tx = await settlement.connect(signer).purchase(flightId, CID, { value: FARE });
    const receipt = await tx.wait();
    const ev = parseEvents(receipt, settlement).find((e) => e.name === "PurchaseCompleted");
    return ev.args.tokenId;
  }

  const flightA = await createFlight("PERF-A-001", 3000);

  const latency = { automine: {}, interval1s: {} };
  const gas = {};
  const reads = { getTicket: [], getFlight: [], calculateRefund: [] };
  const readsRaw = { getTicket: [], getFlight: [], calculateRefund: [] };
  const burst = { automine: null, interval1s: null };

  /// @notice Concurrent purchase burst. Three timelines, all wall-clock anchored
  ///         on the raw provider: submit (all send()s returned), observed (all
  ///         receipts polled into view), inclusion (own block-number sampler).
  ///         Block timestamps are not used — Hardhat drifts them ahead of wall
  ///         time when mining faster than one block per second.
  async function runBurst(flightId) {
    const nonce = await traveler.getNonce("pending");
    const t0 = performance.now();
    const startBlock = await raw.getBlockNumber();
    let stopped = false;
    const samples = []; // {ms, bn} — every observed block-number change
    const sampler = (async () => {
      let last = startBlock;
      while (!stopped) {
        const bn = await raw.getBlockNumber();
        if (bn !== last) {
          samples.push({ ms: performance.now() - t0, bn });
          last = bn;
        }
        await sleep(POLL_MS);
      }
    })();
    const sends = await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        settlement.connect(traveler).purchase(flightId, CID, { value: FARE, nonce: nonce + i })
      )
    );
    const submitMs = performance.now() - t0;
    const seen = [];
    const receipts = await Promise.all(
      sends.map(async (tx) => {
        const r = await rawWait(tx.hash);
        seen.push(performance.now() - t0);
        return r;
      })
    );
    const observedMs = Math.max(...seen);
    stopped = true;
    await sampler;
    const inclusionMs = samples.length ? samples[samples.length - 1].ms : observedMs;
    const perBlock = {};
    for (const r of receipts) {
      perBlock[r.blockNumber] = (perBlock[r.blockNumber] ?? 0) + 1;
      (gas.purchase ??= []).push(Number(r.gasUsed));
    }
    const r2 = (v) => Math.round(v * 100) / 100;
    const seenSorted = [...seen].sort((a, b) => a - b);
    return {
      count: BURST,
      submitSeconds: r2(submitMs / 1000),
      observedSeconds: r2(observedMs / 1000),
      observedP50Seconds: r2(seenSorted[Math.floor(seenSorted.length / 2)] / 1000),
      inclusionSeconds: r2(inclusionMs / 1000),
      tpsObserved: r2(BURST / (observedMs / 1000)),
      tpsInclusion: r2(BURST / Math.max(0.001, inclusionMs / 1000)),
      blocks: new Set(receipts.map((r) => Number(r.blockNumber))).size,
      txPerBlock: Object.values(perBlock),
      gasMeanPurchase: gasStats(receipts.map((r) => Number(r.gasUsed))).mean,
    };
  }

  // ---- Phase A: latency under automine --------------------------------------
  console.log("Phase A: latency under automine ...");
  const listed = []; // tokenIds ready to be listed
  const toCancel = []; // tokenIds ready to be cancelled
  const listingIds = [];

  for (let i = 0; i < N_AUTOMINE; i += 1) {
    const m = await measureTx(settlement.connect(traveler).purchase(flightA, CID, { value: FARE }));
    pushSample(latency.automine, "purchase", m);
    const ev = parseEvents(m.receipt, settlement).find((e) => e.name === "PurchaseCompleted");
    listed.push(ev.args.tokenId);
  }

  for (const tokenId of listed) {
    const preview = await marketplace.previewResale(tokenId, RESALE_PRICE);
    const m = await measureTx(
      marketplace.connect(traveler).list(tokenId, RESALE_PRICE, preview.defaultExpiry)
    );
    pushSample(latency.automine, "list", m);
    const ev = parseEvents(m.receipt, marketplace).find((e) => e.name === "ListingCreated");
    listingIds.push(ev.args.listingId);
  }

  for (const listingId of listingIds) {
    const m = await measureTx(
      marketplace.connect(buyer).buyListing(listingId, { value: RESALE_PRICE })
    );
    pushSample(latency.automine, "buyListing", m);
  }

  for (let i = 0; i < N_AUTOMINE; i += 1) {
    toCancel.push(await purchase(secondPurchaser, flightA));
  }
  for (const tokenId of toCancel) {
    const m = await measureTx(settlement.connect(secondPurchaser).cancel(tokenId));
    pushSample(latency.automine, "cancel", m);
  }

  const departFlights = [];
  for (let i = 0; i < N_DEPART; i += 1) {
    departFlights.push(await createFlight(`PERF-D-${String(i + 1).padStart(2, "0")}`, 5));
  }
  for (const flightId of departFlights) {
    const m = await measureTx(inventory.connect(airline).markDeparted(flightId));
    pushSample(latency.automine, "markDeparted", m);
  }

  const liveToken = listed[0]; // now owned by `buyer` after the resale
  const nftAddr = addresses.AirTicketNFT;
  const invAddr = addresses.FlightInventory;
  const stlAddr = addresses.TicketSettlement;
  const callData = {
    getTicket: nft.interface.encodeFunctionData("getTicket", [liveToken]),
    getFlight: inventory.interface.encodeFunctionData("getFlight", [flightA]),
    calculateRefund: settlement.interface.encodeFunctionData("calculateRefund", [liveToken]),
  };
  for (let i = 0; i < READ_SAMPLES; i += 1) {
    reads.getTicket.push(await measureRead(() => nftR.getTicket(liveToken)));
    reads.getFlight.push(await measureRead(() => inventoryR.getFlight(flightA)));
    reads.calculateRefund.push(await measureRead(() => settlementR.calculateRefund(liveToken)));
    readsRaw.getTicket.push(await ethCallMs(nftAddr, callData.getTicket));
    readsRaw.getFlight.push(await ethCallMs(invAddr, callData.getFlight));
    readsRaw.calculateRefund.push(await ethCallMs(stlAddr, callData.calculateRefund));
  }
  console.log("Phase A done.");

  // ---- Phase C: throughput under automine -----------------------------------
  console.log("Phase C: burst throughput + read QPS under automine ...");
  burst.automine = await runBurst(flightA);

  const q0 = performance.now();
  for (let i = 0; i < READ_QPS_SAMPLES; i += 1) {
    await nftR.getTicket(liveToken);
  }
  const qSeconds = (performance.now() - q0) / 1000;
  const readQps = {
    count: READ_QPS_SAMPLES,
    seconds: Math.round(qSeconds * 100) / 100,
    qps: Math.round(READ_QPS_SAMPLES / qSeconds),
  };
  const qr0 = performance.now();
  for (let i = 0; i < READ_QPS_SAMPLES; i += 1) {
    await ethCallMs(nftAddr, callData.getTicket);
  }
  const qrSeconds = (performance.now() - qr0) / 1000;
  const readQpsRaw = {
    count: READ_QPS_SAMPLES,
    seconds: Math.round(qrSeconds * 100) / 100,
    qps: Math.round(READ_QPS_SAMPLES / qrSeconds),
  };
  console.log("Phase C done.");

  // ---- Phase B: 1 s interval mining -----------------------------------------
  // Setup while automine is still on, so only the measured transactions wait
  // for a block tick.
  console.log("Phase B: setup for interval mining ...");
  const flightB = await createFlight("PERF-B-001", 500);
  const departFlightsB = [];
  for (let i = 0; i < N_DEPART_INTERVAL; i += 1) {
    departFlightsB.push(await createFlight(`PERF-B-D-${i + 1}`, 5));
  }
  const bListed = [];
  for (let i = 0; i < N_INTERVAL; i += 1) bListed.push(await purchase(traveler, flightB));
  const bToCancel = [];
  for (let i = 0; i < N_INTERVAL; i += 1) bToCancel.push(await purchase(secondPurchaser, flightB));

  await provider.send("evm_setAutomine", [false]);
  await provider.send("evm_setIntervalMining", [BLOCK_MS]);
  console.log(`Phase B: latency + burst under ${BLOCK_MS} ms interval mining ...`);

  for (let i = 0; i < N_INTERVAL; i += 1) {
    const m = await measureTx(
      settlement.connect(secondPurchaser).purchase(flightB, CID, { value: FARE })
    );
    pushSample(latency.interval1s, "purchase", m);
  }

  const bListingIds = [];
  for (const tokenId of bListed) {
    const preview = await marketplace.previewResale(tokenId, RESALE_PRICE);
    const m = await measureTx(
      marketplace.connect(traveler).list(tokenId, RESALE_PRICE, preview.defaultExpiry)
    );
    pushSample(latency.interval1s, "list", m);
    const ev = parseEvents(m.receipt, marketplace).find((e) => e.name === "ListingCreated");
    bListingIds.push(ev.args.listingId);
  }
  for (const listingId of bListingIds) {
    const m = await measureTx(
      marketplace.connect(buyer).buyListing(listingId, { value: RESALE_PRICE })
    );
    pushSample(latency.interval1s, "buyListing", m);
  }
  for (const tokenId of bToCancel) {
    const m = await measureTx(settlement.connect(secondPurchaser).cancel(tokenId));
    pushSample(latency.interval1s, "cancel", m);
  }
  for (const flightId of departFlightsB) {
    const m = await measureTx(inventory.connect(airline).markDeparted(flightId));
    pushSample(latency.interval1s, "markDeparted", m);
  }

  burst.interval1s = await runBurst(flightB);
  console.log("Phase B done.");

  // ---- Aggregate gas + environment ------------------------------------------
  for (const bucket of [latency.automine, latency.interval1s]) {
    for (const [op, { gas: gs }] of Object.entries(bucket)) {
      (gas[op] ??= []).push(...gs);
    }
  }
  const latest = await raw.getBlock("latest");
  const blockGasLimit = Number(latest.gasLimit);
  const purchaseGasMean = gasStats(gas.purchase ?? []).mean;
  const optimizerOn = process.env.SOLC_OPTIMIZER === "1";
  const hardhatVersion = require("hardhat/package.json").version;

  const result = {
    meta: {
      chainId: Number(net.chainId),
      rpc: `${RPC_URL} (HTTP JSON-RPC)`,
      hardhat: hardhatVersion,
      optimizer: optimizerOn ? "enabled, runs=200" : "disabled (default)",
      compiler: "0.8.28",
      samples: {
        automine: N_AUTOMINE,
        interval1s: N_INTERVAL,
        markDepartedAutomine: N_DEPART,
        markDepartedInterval1s: N_DEPART_INTERVAL,
        burst: BURST,
        readLatency: READ_SAMPLES,
        readQps: READ_QPS_SAMPLES,
      },
      blockIntervalMs: BLOCK_MS,
      receiptPollMs: POLL_MS,
      blockGasLimit,
      maxPurchasesPerBlock: Math.floor(blockGasLimit / purchaseGasMean),
      timestamp: new Date().toISOString(),
      out: path.relative(ROOT, OUT_PATH).replaceAll("\\", "/"),
    },
    deployGas,
    deployGasContractsTotal: Object.entries(deployGas)
      .filter(([name]) => name !== "wiring")
      .reduce((a, [, v]) => a + v, 0),
    latency: {
      automine: Object.fromEntries(
        Object.entries(latency.automine).map(([op, v]) => [op, stats(v.ms)])
      ),
      interval1s: Object.fromEntries(
        Object.entries(latency.interval1s).map(([op, v]) => [op, stats(v.ms)])
      ),
    },
    reads: Object.fromEntries(Object.entries(reads).map(([k, v]) => [k, stats(v)])),
    readsRaw: Object.fromEntries(Object.entries(readsRaw).map(([k, v]) => [k, stats(v)])),
    readQps,
    readQpsRaw,
    burst,
    gas: Object.fromEntries(Object.entries(gas).map(([op, v]) => [op, gasStats(v)])),
  };

  // ---- Print ----------------------------------------------------------------
  const pad = (s, n) => String(s).padEnd(n);
  const num = (v, n = 9) => String(v).padStart(n);
  console.log("");
  console.log("Latency under automine (ms, send + receipt over HTTP JSON-RPC):");
  console.log(`  ${pad("operation", 16)}${num("n", 4)}${num("min", 9)}${num("p50", 9)}${num("p95", 9)}${num("max", 9)}`);
  for (const [op, st] of Object.entries(result.latency.automine)) {
    console.log(`  ${pad(op, 16)}${num(st.n, 4)}${num(st.min)}${num(st.p50)}${num(st.p95)}${num(st.max)}`);
  }
  console.log("");
  console.log(`Latency under ${BLOCK_MS} ms interval mining (ms, send + receipt to inclusion):`);
  console.log(`  ${pad("operation", 16)}${num("n", 4)}${num("min", 9)}${num("p50", 9)}${num("p95", 9)}${num("max", 9)}`);
  for (const [op, st] of Object.entries(result.latency.interval1s)) {
    console.log(`  ${pad(op, 16)}${num(st.n, 4)}${num(st.min)}${num(st.p50)}${num(st.p95)}${num(st.max)}`);
  }
  console.log("");
  console.log("Contract read latency (ms):");
  console.log(`  ${pad("call", 20)}${pad("via", 9)}${num("n", 4)}${num("min", 9)}${num("p50", 9)}${num("p95", 9)}${num("max", 9)}`);
  for (const src of ["reads", "readsRaw"]) {
    const via = src === "reads" ? "ethers" : "raw HTTP";
    for (const [op, st] of Object.entries(result[src])) {
      console.log(`  ${pad(op, 20)}${pad(via, 9)}${num(st.n, 4)}${num(st.min)}${num(st.p50)}${num(st.p95)}${num(st.max)}`);
    }
  }
  console.log("");
  console.log("Throughput (concurrent purchase burst):");
  for (const [label, b] of [
    ["automine        ", burst.automine],
    [`interval ${BLOCK_MS}ms`, burst.interval1s],
  ]) {
    console.log(
      `  ${label}  ${b.count} tx: submit ${b.submitSeconds}s, observed ${b.observedSeconds}s, ` +
        `inclusion ${b.inclusionSeconds}s -> ${b.tpsObserved} tx/s observed, ${b.tpsInclusion} tx/s at inclusion; ` +
        `${b.blocks} block(s) ${JSON.stringify(b.txPerBlock)}`
    );
  }
  console.log(
    `  read QPS:          ethers ${readQps.qps} reads/s (${readQps.count} in ${readQps.seconds}s), raw HTTP ${readQpsRaw.qps} reads/s (${readQpsRaw.seconds}s)`
  );
  console.log("");
  console.log("Gas (mean over all measured samples):");
  for (const [op, g] of Object.entries(result.gas)) {
    console.log(`  ${pad(op, 16)} mean ${num(g.mean, 8)}  min ${num(g.min, 8)}  max ${num(g.max, 8)}  n=${g.n}`);
  }
  console.log(
    `  ${pad("deployment", 16)} contracts ${result.deployGasContractsTotal} + wiring ${deployGas.wiring}`
  );
  console.log(
    `  block gas limit ${blockGasLimit} -> max ${result.meta.maxPurchasesPerBlock} purchases/block at mean gas`
  );

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2) + "\n");
  console.log("");
  console.log(`Wrote ${path.relative(ROOT, OUT_PATH)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
