// Shared helper for scripts that need a local `hardhat node` on :8545.
// Used by scripts/run-tests.js (mocha contract tests) and scripts/perf-eval.js
// (performance measurement). Spawns the node, waits until it answers
// eth_chainId === 31337, runs `fn`, then tears the process tree down even on
// Windows (taskkill) so port 8545 frees for the next run.
import { spawn } from "child_process";
import { createRequire } from "module";
import path from "path";
import { ethers } from "ethers";

const require = createRequire(import.meta.url);
export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const HARDHAT_CLI = path.join(
  path.dirname(require.resolve("hardhat/package.json")),
  "dist",
  "src",
  "cli.js"
);

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForNode(timeoutMs = 60000) {
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
  const start = Date.now();
  for (;;) {
    try {
      const chainId = (await provider.getNetwork()).chainId;
      if (chainId === 31337n) return;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for hardhat node");
    await sleep(500);
  }
}

/// @notice Start `hardhat node` on :8545, run `fn(node)`, and always tear the tree down.
/// @param fn {Promise<any>} body to run while the node is up; its result is returned.
export async function withNode(fn) {
  const node = spawn(process.execPath, [HARDHAT_CLI, "node", "--port", "8545"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let nodeLog = "";
  node.stdout.on("data", (d) => {
    nodeLog += d.toString();
  });
  node.stderr.on("data", (d) => {
    nodeLog += d.toString();
  });
  let exited = false;
  node.on("exit", (code) => {
    exited = true;
    if (code !== 0 && code !== null) {
      console.error("hardhat node exited early:\n" + nodeLog);
    }
  });
  try {
    await waitForNode();
    // Guard: if our child died (e.g. EADDRINUSE), waitForNode may have latched onto
    // a foreign node on :8545 — never measure or test against a chain we do not own.
    // The 150 ms grace covers the gap between the child's bind failure and exit.
    await sleep(150);
    if (node.exitCode !== null) {
      throw new Error(
        `spawned hardhat node exited with code ${node.exitCode} — is another node already on :8545?`
      );
    }
    const result = await fn({ nodeLog: () => nodeLog, exited: () => exited });
    return result;
  } catch (err) {
    console.error(err);
    console.error(nodeLog);
    throw err;
  } finally {
    node.kill();
    // Windows: ensure the child tree is gone so port 8545 frees for the next run.
    if (process.platform === "win32" && node.pid) {
      spawn("taskkill", ["/pid", String(node.pid), "/t", "/f"], { stdio: "ignore" });
    }
  }
}
