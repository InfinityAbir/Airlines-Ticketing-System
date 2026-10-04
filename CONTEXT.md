# Project Context Handoff

## Project

**Project:** Blockchain-based airline ticketing system  
**Workspace:** `E:\Temp\Project\Airlines Ticketing System`  
**Purpose:** Build an educational blockchain prototype and complete an IEEE-style paper about secure and transparent airline ticketing.

## Current Artifacts

- `Paper\blockchain_airline_ticketing_ieee.tex` - Current full IEEE LaTeX paper source.
- `AIRLINE_TICKETING_PROTOTYPE_PRD.md` - Full product requirements document for the prototype.
- Original source PDF - `A new approach to improving security & transparency of airlines ticketing system using decentralized blockchain technology(1) (1).pdf`.

## Paper Status

The LaTeX paper was recreated and rewritten from the source PDF in a more natural academic voice. It is generalized for a global airline ecosystem; Bangladesh-specific framing, airlines, and the Bangladesh-specific judicial-system citation were removed.

### Current paper contents

- IEEE conference format using `\documentclass[conference]{IEEEtran}`.
- Title: *A Practical Blockchain Framework for Secure and Transparent Airline Ticketing*.
- Sections: Introduction, Related Work, Architecture and Implementation, Recommended Framework, Testing and Evaluation, Conclusion and Future Work.
- Thirteen focused references, all cited in the text. Original references 15--17 were excluded because reference 15 was Bangladesh-specific and references 16--17 were not needed in the revised paper.
- Four tables: conventional-system deficiencies, related-work comparison, prototype verification results, and lifecycle gas usage.
- Four diagrams:
  1. Decentralized purchase and cancellation lifecycle.
  2. High-level architecture.
  3. Proposed workflow.
  4. Cancellation flow.

### Diagram fix already applied

The early TikZ diagrams had arrow labels overlapping the boxes. The labels were removed from arrows in the lifecycle and architecture diagrams, leaving clean boxes, arrows, captions, and explanatory text in the surrounding paper.

### Compilation check (passed 2026-10-04)

The earlier `Unable to find standard directories for platform` error came from the editor-integrated compiler, not the source. The document now compiles locally with MiKTeX:

```bash
pdflatex -interaction=nonstopmode -halt-on-error Paper\blockchain_airline_ticketing_ieee.tex
```

Result: **6 pages**, zero LaTeX warnings, zero overfull boxes, no undefined references or citations (run twice for cross-references). The built PDF is `Paper\blockchain_airline_ticketing_ieee.pdf` (`Paper/*.pdf` is git-ignored).

### Testing section (added 2026-10-04)

`\section{Testing and Evaluation}` sits before the Conclusion and uses only observed results from the finished prototype:

- Environment: Solidity 0.8.28, OZ 5.6.1, Hardhat 3.18 local chain (31337), ethers v6, protected upload with labeled mock-CID fallback, test ETH only.
- Verification table: 110/110 unit tests (success + failure paths for every public write), Slither 0.11.5 → 0 High / 0 Medium (19 informational documented), Solhint 0 errors, secret scan clean, `npm run eval` 7/7, Playwright 21/21.
- Scenario evaluation: full PRD §15 walkthrough with exact values (0.11 ETH → 0.0055 royalty + 0.1045 proceeds; 0.08/0.02 refund split; 7-field PII-free verifier; `FlightDeparted__id` blocks).
- Gas table (measured by `npm run eval`, local EVM, optimizer disabled): purchase 386,325 · list 310,302 · buy 185,674 · cancel 196,265 · markDeparted 33,049.
- Limitations subsection: single local node, no throughput/cost claims, no real airline or payment integration, simulated identity, mock-CID fallback.
- Evidence added on request (2026-10-04): per-suite distribution (15/11/12/31/33/8 = 110), failure-path paragraph with the real custom errors, runtime-security-posture paragraph, Table IV gas with tx-hash prefixes, Table V seven-step observed outcomes, evaluator-assertion paragraph (wei reconciliation), `Reproducibility and Evidence` subsection (exact commands + archived artifacts), browser/accessibility evidence, Fig. 5 screenshots copied to `Paper/figs/` from `doc/screenshots/phase6/`, validity paragraph, and positioning against Table II.
- Abstract and Conclusion updated to reflect the working prototype (replacing the earlier "design proposal" wording).

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

## Status of the Recommended Next Steps

All six original next steps are done: contracts + 110-test suite, vanilla frontend with admin console, protected upload endpoint, gates green (lint 0 errors, secret scan clean, Slither 0 High/0 Medium), prototype results captured in `doc/STATUS.md` / `doc/screenshots/phase6/`, and the IEEE testing/evaluation section written from observed outputs only.

Remaining before submission, if desired:

1. Fill in the paper's author block (currently `Author Name` placeholder).
2. Re-run `pdflatex` twice after any edit and review the 5-page PDF layout.
3. Optionally add measured end-to-end timings (wall-clock per demo step) — not yet captured.

## Suggested Continuation Prompt

> Read `E:\Temp\Project\Airlines Ticketing System\CONTEXT.md` first. Continue the blockchain airline-ticketing project from the recorded state. Inspect the prototype implementation and compare it with `AIRLINE_TICKETING_PROTOTYPE_PRD.md`. Do not invent test results; use only observed outputs when adding the paper's testing/evaluation section.
