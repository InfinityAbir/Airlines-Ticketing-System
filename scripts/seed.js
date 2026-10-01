import fs from "fs";
import path from "path";
import { network } from "hardhat";

// Phase 1 seed: approve one airline + create/publish one 5-seat demo flight.
// Reads addresses from frontend/assets/js/contracts-config.js (written by deploy.js).
// Run against the same network as deploy, e.g.:
//   npx hardhat node            (terminal 1)
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/seed.js --network localhost
async function main() {
  const { ethers } = await network.create();
  const configPath = path.join(
    import.meta.dirname,
    "..",
    "frontend",
    "assets",
    "js",
    "contracts-config.js"
  );
  const raw = fs.readFileSync(configPath, "utf8");
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  const { addresses } = JSON.parse(json);

  const [admin, airline] = await ethers.getSigners();
  const registry = await ethers.getContractAt("AirlineRegistry", addresses.AirlineRegistry);
  const inventory = await ethers.getContractAt("FlightInventory", addresses.FlightInventory);

  await (await registry.connect(admin).approveAirline(airline.address)).wait();

  const now = Math.floor(Date.now() / 1000);
  const departure = now + 30 * 24 * 3600;
  const refundDeadline = departure - 7 * 24 * 3600;
  const tx = await inventory.connect(airline).createFlight([
    "R1-DEMO-001",
    "JFK",
    "LHR",
    departure,
    5,
    ethers.parseEther("0.1"),
    refundDeadline,
    8000, // 80% refund
    500, // 5% royalty (<= maxRoyaltyBps 1000)
  ]);
  const receipt = await tx.wait();
  const created = receipt.logs
    .map((l) => {
      try {
        return inventory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "FlightCreated");
  const flightId = created.args.flightId.toString();
  await (await inventory.connect(airline).publishFlight(flightId)).wait();

  console.log(JSON.stringify({ airline: airline.address, flightId }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
