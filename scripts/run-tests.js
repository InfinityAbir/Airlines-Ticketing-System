// `npm test` orchestrator (Hardhat 3 runs Solidity tests only via `hardhat test`,
// so JS contract tests run here with Mocha against a local `hardhat node`).
import { spawn } from "child_process";
import { createRequire } from "module";
import path from "path";
import { ethers } from "ethers";

const require = createRequire(import.meta.url);
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const HARDHAT_CLI = path.join(path.dirname(require.resolve("hardhat/package.json")), "dist", "src", "cli.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForNode(timeoutMs = 60000) {
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

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const node = spawn(process.execPath, [HARDHAT_CLI, "node", "--port", "8545"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let nodeLog = "";
  node.stdout.on("data", (d) => { nodeLog += d.toString(); });
  node.stderr.on("data", (d) => { nodeLog += d.toString(); });
  let exited = false;
  node.on("exit", (code) => {
    exited = true;
    if (code !== 0 && code !== null) {
      console.error("hardhat node exited early:\n" + nodeLog);
    }
  });
  try {
    await waitForNode();
    const code = await run(process.execPath, [
      path.join(path.dirname(require.resolve("mocha/package.json")), "bin", "mocha.js"),
      "test/*.test.js",
      "--timeout",
      "120000",
      "--exit",
    ]);
    if (exited) {
      console.error("hardhat node exited before tests finished:\n" + nodeLog);
    }
    process.exitCode = code;
  } catch (err) {
    console.error(err);
    console.error(nodeLog);
    process.exitCode = 1;
  } finally {
    node.kill();
    // Windows: ensure the child tree is gone so port 8545 frees for the next run.
    if (process.platform === "win32" && node.pid) {
      spawn("taskkill", ["/pid", String(node.pid), "/t", "/f"], { stdio: "ignore" });
    }
  }
}

main();
