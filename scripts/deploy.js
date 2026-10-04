import { network } from "hardhat";
import { deployStack, writeFrontendConfig } from "./lib/stack.js";

// Phase 1 deployment entry point: Registry -> Inventory -> NFT -> Settlement -> Marketplace,
// then wire settlement/marketplace addresses and the NFT marketplace role.
// Writes frontend/assets/js/contracts-config.js (chainId + addresses, no secrets).
// The actual wiring lives in scripts/lib/stack.js so the Phase 6 demo evaluator can reuse it.
async function main() {
  const { ethers } = await network.create();
  const net = await ethers.provider.getNetwork();
  const { addresses, deployer } = await deployStack(ethers);
  const { abiCount } = writeFrontendConfig({ chainId: Number(net.chainId), addresses });

  console.log(JSON.stringify({ chainId: Number(net.chainId), deployer, addresses, abiCount }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
