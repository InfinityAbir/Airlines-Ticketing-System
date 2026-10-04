import { network } from "hardhat";
import { readFrontendConfig, seedDemo } from "./lib/stack.js";

// Phase 1 seed: approve one airline + create/publish one 5-seat demo flight.
// Reads addresses from frontend/assets/js/contracts-config.js (written by deploy.js).
// Run against the same network as deploy, e.g.:
//   npx hardhat node            (terminal 1)
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/seed.js --network localhost
// The dataset itself lives in scripts/lib/stack.js (`seedDemo`) so the Phase 6 demo
// evaluator seeds exactly the same flight.
async function main() {
  const { ethers } = await network.create();
  const { addresses } = readFrontendConfig();
  const { airline, flightId } = await seedDemo(ethers, addresses);

  console.log(JSON.stringify({ airline, flightId }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
