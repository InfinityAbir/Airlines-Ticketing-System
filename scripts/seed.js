import { network } from "hardhat";
import { readFrontendConfig, seedShowcase } from "./lib/stack.js";

// Seeds the presentation dataset used by `npm run deploy` + `npm run seed` and by the
// tracked E2E suite: the deterministic demo flight (R1-DEMO-001, flightId 1) plus two
// further operator wallets and flights covering every display state.
// Reads addresses from frontend/assets/js/contracts-config.js (written by deploy.js).
// Run against the same network as deploy, e.g.:
//   npx hardhat node            (terminal 1)
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/seed.js --network localhost
//
// scripts/demo-eval.js still uses seedDemo() on its own, so the PRD §15 walkthrough and
// the numbers reported in the paper are unaffected by anything added here.
async function main() {
  const { ethers } = await network.create();
  const { addresses } = readFrontendConfig();
  const { demo, operators, flights, tickets } = await seedShowcase(ethers, addresses);

  const byState = tickets.reduce((acc, t) => {
    acc[t.state] = (acc[t.state] || 0) + 1;
    return acc;
  }, {});

  console.log(
    JSON.stringify(
      {
        demoFlight: {
          flightId: demo.flightId,
          flightCode: demo.flightCode,
          airline: demo.airline,
        },
        operators: operators.map((o) => o.wallet),
        flightCount: flights.length,
        flightsByState: flights.reduce((acc, f) => {
          acc[f.state] = (acc[f.state] || 0) + 1;
          return acc;
        }, {}),
        flights,
        ticketCount: tickets.length,
        ticketsByState: byState,
        tickets,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});