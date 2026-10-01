import { AssertionError, assert, expect } from "chai";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Phase 1 test runtime: Mocha + Chai against a local Hardhat node.
// - `npm test` (scripts/run-tests.js) starts `hardhat node`, runs mocha, stops it.
// - hardhat-chai-matchers@3 is a deprecated stub that aborts under Hardhat 3,
//   so revert/event assertions below decode revert data and receipt logs directly.

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";

// cacheTimeout -1: ethers dedupes identical estimateGas/call requests for 250ms,
// which would replay a pre-warp revert after evm_setNextBlockTimestamp.
export const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });

export { ethers };

/// @notice First N unlocked node accounts as signers (deterministic under `hardhat node`).
export async function getSigners(count = 10) {
  const signers = [];
  for (let i = 0; i < count; i += 1) {
    signers.push(await provider.getSigner(i));
  }
  return signers;
}

function artifactFor(name) {
  const p = path.join(ROOT, "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/// @notice ContractFactory for a compiled contract, bound to `signer` (defaults to account 0).
export async function getFactory(name, signer = null) {
  const { abi, bytecode } = artifactFor(name);
  const from = signer ?? (await provider.getSigner(0));
  return new ethers.ContractFactory(abi, bytecode, from);
}

export async function latest() {
  return (await provider.getBlock("latest")).timestamp;
}

export async function warpTo(ts) {
  await provider.send("evm_setNextBlockTimestamp", [ts]);
  await provider.send("evm_mine", []);
}

function revertData(err) {
  const candidates = [err?.data, err?.error?.data, err?.info?.error?.data, err?.value?.data];
  return candidates.find((d) => typeof d === "string" && d.startsWith("0x"));
}

/// @notice Assert that a transaction reverts with the given custom error name.
/// @param promise Transaction response promise (contract call, not yet awaited).
/// @param contracts Contract instance (or array) whose interface decodes the error.
export async function expectCustomError(promise, contracts, name) {
  const list = Array.isArray(contracts) ? contracts : [contracts];
  let data;
  try {
    const tx = await promise;
    if (tx && typeof tx.wait === "function") {
      await tx.wait();
    }
  } catch (err) {
    data = revertData(err);
    if (!data) {
      const msg = err?.shortMessage || err?.message || String(err);
      if (typeof msg === "string" && msg.includes(name)) return;
      throw new AssertionError({
        message: `expected custom error ${name}; no revert data decoded (message: ${msg})`,
      });
    }
    for (const c of list) {
      try {
        const parsed = c.interface.parseError(data);
        if (parsed && parsed.name === name) return;
        if (parsed) {
          throw new AssertionError({
            message: `expected custom error ${name}, got ${parsed.name}`,
          });
        }
      } catch (e) {
        if (e instanceof AssertionError) throw e;
      }
    }
    throw new AssertionError({
      message: `expected custom error ${name}; data ${data} did not decode`,
    });
  }
  throw new AssertionError({
    message: `expected custom error ${name}, but the transaction succeeded`,
  });
}

/// @notice Send a transaction and return the first matching parsed event.
/// @param promise Transaction response promise.
/// @param contract Contract instance whose interface parses the receipt logs.
export async function expectEvent(promise, contract, name) {
  const tx = await promise;
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    let parsed = null;
    try {
      parsed = contract.interface.parseLog(log);
    } catch {
      parsed = null;
    }
    if (parsed && parsed.name === name) return parsed;
  }
  throw new AssertionError({ message: `expected event ${name} in receipt` });
}
