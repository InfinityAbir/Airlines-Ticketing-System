// `npm run perf` orchestrator — throughput, latency, and gas measurement for the
// paper's performance evaluation.
//
//   npm run perf                 # full run, unoptimized build -> doc/perf-eval.json
//   SOLC_OPTIMIZER=1 npm run perf  # optimizer (runs=200) run for the A/B gas comparison
//   PERF_OUT=doc/perf-eval-optimized.json SOLC_OPTIMIZER=1 npm run perf
//
// Flow: compile (honours SOLC_OPTIMIZER) -> spawn `hardhat node` on :8545 ->
// `hardhat run scripts/perf-measure.js --network localhost` (HTTP JSON-RPC, so every
// latency figure includes a real RPC round-trip) -> tear the node down.
// Exit code 0 only when every phase completes.
import { spawn } from "child_process";
import { createRequire } from "module";
import path from "path";
import { withNode } from "./lib/node.js";

const require = createRequire(import.meta.url);
const HARDHAT_CLI = path.join(
  path.dirname(require.resolve("hardhat/package.json")),
  "dist",
  "src",
  "cli.js"
);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const compileCode = await run(process.execPath, [HARDHAT_CLI, "compile"]);
  if (compileCode !== 0) {
    console.error("hardhat compile failed");
    process.exitCode = compileCode;
    return;
  }
  const measureCode = await withNode(() =>
    run(process.execPath, [
      HARDHAT_CLI,
      "run",
      "scripts/perf-measure.js",
      "--network",
      "localhost",
    ])
  );
  process.exitCode = measureCode;
}

main().catch(() => {
  process.exitCode = 1;
});
