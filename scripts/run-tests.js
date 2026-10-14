// `npm test` orchestrator (Hardhat 3 runs Solidity tests only via `hardhat test`,
// so JS contract tests run here with Mocha against a local `hardhat node`).
import { spawn } from "child_process";
import { createRequire } from "module";
import path from "path";
import { withNode } from "./lib/node.js";

const require = createRequire(import.meta.url);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const code = await withNode(async ({ nodeLog, exited }) => {
    const testCode = await run(process.execPath, [
      path.join(path.dirname(require.resolve("mocha/package.json")), "bin", "mocha.js"),
      "test/*.test.js",
      "--timeout",
      "120000",
      "--exit",
    ]);
    if (exited()) {
      console.error("hardhat node exited before tests finished:\n" + nodeLog());
    }
    return testCode;
  });
  process.exitCode = code;
}

main().catch(() => {
  process.exitCode = 1;
});
