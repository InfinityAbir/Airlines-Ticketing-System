# Project Context Handoff

## Project

**Project:** Blockchain-based airline ticketing system  
**Workspace:** `E:\Temp\Project\Airlines Ticketing System`  
**Purpose:** Build an educational blockchain prototype and complete an IEEE-style paper about secure and transparent airline ticketing.

## Current Artifacts

- `blockchain_airline_ticketing_ieee.tex` - Current full IEEE LaTeX paper source.
- `AIRLINE_TICKETING_PROTOTYPE_PRD.md` - Full product requirements document for the prototype.
- Original source PDF - `A new approach to improving security & transparency of airlines ticketing system using decentralized blockchain technology(1) (1).pdf`.

## Paper Status

The LaTeX paper was recreated and rewritten from the source PDF in a more natural academic voice. It is generalized for a global airline ecosystem; Bangladesh-specific framing, airlines, and the Bangladesh-specific judicial-system citation were removed.

### Current paper contents

- IEEE conference format using `\documentclass[conference]{IEEEtran}`.
- Title: *A Practical Blockchain Framework for Secure and Transparent Airline Ticketing*.
- Sections: Introduction, Related Work, Architecture and Implementation, Recommended Framework, Conclusion and Future Work.
- Thirteen focused references, all cited in the text. Original references 15--17 were excluded because reference 15 was Bangladesh-specific and references 16--17 were not needed in the revised paper.
- Two tables: conventional-system deficiencies and related-work comparison.
- Four diagrams:
  1. Decentralized purchase and cancellation lifecycle.
  2. High-level architecture.
  3. Proposed workflow.
  4. Cancellation flow.

### Diagram fix already applied

The early TikZ diagrams had arrow labels overlapping the boxes. The labels were removed from arrows in the lifecycle and architecture diagrams, leaving clean boxes, arrows, captions, and explanatory text in the surrounding paper.

### Known compilation limitation

The built-in LaTeX compiler returned `Unable to find standard directories for platform`. This is an environment/compiler availability issue, not a confirmed source error. The document needs one local compilation check before submission.

### Testing section plan

The paper is currently about four pages. After the prototype is built, add a testing/evaluation section that covers:

- Test environment: Hardhat, local test wallets, IPFS sample metadata.
- Booking/payment and NFT minting.
- Cancellation and refund calculation.
- Approved resale and airline royalty split.
- Public ticket verification.
- Unauthorized actions and invalid ticket states.
- Unit-test results, transaction hashes, gas usage, timings, screenshots, and static-analysis results.
- Prototype limitations: local network, test ETH, fictional data, no real airline/payment integration, and simulated identity validation if applicable.

Expected final paper length after testing: approximately 5.5--6 IEEE pages.

## Pension Prototype Audit Reference

The existing reference prototype is located at:

`E:\Temp\Project\Blockchain-Pension-System`

### Reusable strengths

- Vanilla HTML/CSS/JavaScript application with Ethers wallet connection.
- Role-specific routing and dashboards.
- Separate Solidity contracts for registry, documents, fund, and disbursement responsibilities.
- Explicit status-driven workflows, IPFS CID references, transaction feedback, history tables, and local Hardhat deployment.

### Important findings to avoid copying

1. **Exposed IPFS credentials:** The pension frontend's `pension-ui/vanilla-ui/js/config.js` contains provider credentials. They must be rotated. Never place API keys, secrets, seed phrases, or private keys in frontend code.
2. **Static-analysis results:** The pension Slither report includes one high-severity arbitrary-ETH-send finding and medium findings related to reentrancy and an uninitialized local value. The airline prototype must use strict role checks, per-airline accounting, checks-effects-interactions, `ReentrancyGuard`, and payout tests.
3. **Fixed local contract addresses:** Generate environment-specific deployment configuration and display the active chain in the UI.
4. **Testing gap:** No automated JavaScript test files were found in the indexed pension project. Airline smart contracts require success and failure-path tests before demonstration.

## Finalized Prototype Decisions (R1)

1. **PRD filename:** Keep `AIRLINE_TICKETING_PROTOTYPE_PRD.md`; do not create a `doc/PRD.md` alias.
2. **Cancellation state:** `Cancelled` is the single terminal ticket state. Emit a separate refund event with refund amount, retained amount, and transaction details. Do not use a sequential `Cancelled -> Refunded` state transition.
3. **Ticket usage and pause behaviour:** Keep `markUsed` on `AirTicketNFT`.
   - Pause blocks flight creation/publishing, booking, listing, resale, and transfers.
   - Cancellation/refund and `markUsed` remain available to safely resolve active tickets.
4. **Marketplace and royalties:** Marketplace settlement math is authoritative. `royaltyInfo` is display-only and must match the marketplace's stored royalty basis points.
5. **R1 values:**
   - `maxRoyaltyBps = 1000` (10%).
   - Resale price cap = `12000` BPS of original fare (120%).
   - Listing `expiresAt` must be no later than the check-in window; default listing duration is 24 hours.
   - Check-in window = 2 hours before departure.
   - Seat identifiers use `S-<n>`, for example `S-1` and `S-2`.
6. **IPFS:** Use protected real IPFS upload in R1 for fictional, non-sensitive ticket metadata.
   - Keep provider credentials on a server-side component or protected upload endpoint.
   - Never expose upload credentials in browser code.
   - Use mock CIDs only as a fallback if IPFS is unavailable.

## Target Prototype Scope

### Roles

- Traveler
- Airline Operator
- Platform Administrator
- Public Verifier

### Core flows

1. Admin approves an airline operator wallet.
2. Airline operator creates and publishes a sample flight.
3. Traveler connects a wallet, chooses a sample seat, and pays using test ETH.
4. Smart contracts decrement inventory, create metadata, and mint a restricted ticket NFT.
5. Traveler sees the ticket in a ticket wallet and can verify its public status.
6. Traveler can cancel an eligible ticket for a policy-based refund.
7. Traveler can list an eligible ticket; another traveler can buy it through the approved marketplace.
8. The marketplace pays seller proceeds and airline royalty atomically.
9. Airline operator can mark a ticket as used when permitted.

### Contract design proposed in PRD

- `AirlineRegistry` - platform administration and airline authorization.
- `FlightInventory` - flights, capacity, fares, policy, and seat inventory.
- `AirTicketNFT` - restricted ERC-721 ticket ownership and lifecycle state.
- `TicketSettlement` - purchase, cancellation, refund, and airline revenue accounting.
- `TicketMarketplace` - authorized resale and royalty distribution.

Use OpenZeppelin `AccessControl`, `Pausable`, `ReentrancyGuard`, `ERC721`, and `ERC2981` where relevant.

## Recommended Next Steps

1. Build the local Hardhat contracts and test suite according to the PRD and R1 decisions.
2. Implement the vanilla frontend using the pension prototype's dashboard/routing approach.
3. Add protected IPFS upload for fictional sample metadata.
4. Run unit tests and static analysis; fix all high-severity issues before demonstrating.
5. Share the finished prototype, test outputs, screenshots, transaction hashes, and measurements in a new Codex chat.
6. Ask Codex to add the IEEE testing/evaluation section to `blockchain_airline_ticketing_ieee.tex` using those verified results.

## Suggested Continuation Prompt

> Read `E:\Temp\Project\Airlines Ticketing System\CONTEXT.md` first. Continue the blockchain airline-ticketing project from the recorded state. Inspect the prototype implementation and compare it with `AIRLINE_TICKETING_PROTOTYPE_PRD.md`. Do not invent test results; use only observed outputs when adding the paper's testing/evaluation section.
