# Project Context Handoff

## Project

**Project:** Blockchain-based airline ticketing system  
**Workspace:** `E:\Temp\Project\Airlines Ticketing System`  
**Purpose:** Build an educational blockchain prototype and complete an IEEE-style paper about secure and transparent airline ticketing.

## Current Artifacts

- `Paper\main.tex` - Current full IEEE LaTeX paper source.
- `AIRLINE_TICKETING_PROTOTYPE_PRD.md` - Full product requirements document for the prototype.
- Original source PDF - `A new approach to improving security & transparency of airlines ticketing system using decentralized blockchain technology(1) (1).pdf`.

## Paper Status

The LaTeX paper was recreated and rewritten from the source PDF in a more natural academic voice. It is generalized for a global airline ecosystem; Bangladesh-specific framing, airlines, and the Bangladesh-specific judicial-system citation were removed.

### Current paper contents

- IEEE conference format using `\documentclass[conference]{IEEEtran}`. The author block is deliberately empty (`\author{}` with a `% blind review` comment) so the PDF stays anonymous for double-blind review — the `\maketitle` warning is silenced by supplying an empty `\author`, and page 1 goes title → abstract with no identifying text.
- Title: *A Practical Blockchain Framework for Secure and Transparent Airline Ticketing*.
- Sections (2026-10-10 supervisor revision): I. Introduction, II. Related Work (Table II placed before Section III), III. Architecture and Implementation (`A. System Architecture and Ticket Lifecycle`, `B. Recommended Framework` containing `1) Ticket Purchase Framework` and `2) Ticket Cancellation Framework` with the inline refund equation), IV. Testing and Evaluation (A–D), V. Conclusion and Future Work — exactly two paragraphs (conclusion; then limitations + future work), no subsections.
- Thirteen focused references, all cited in the text. Original references 15--17 were excluded because reference 15 was Bangladesh-specific and references 16--17 were not needed in the revised paper.
- Five tables: conventional-system deficiencies, related-work comparison, prototype verification results, lifecycle gas usage (demo / mean / optimizer / ETH cost), and median-p95 latency under both mining modes.
- Four diagrams:
  1. Decentralized purchase and cancellation lifecycle.
  2. High-level architecture.
  3. Proposed workflow.
  4. Cancellation flow.
- The full-width screenshots figure (`Fig. 5`) and the seven-step outcome table were removed in the 2026-10-04 performance pass to keep the paper at 6 pages; the seven-step outcomes remain narrated in the Scenario Evaluation prose.

### Accuracy pass (2026-10-14)

Every claim in the paper was re-checked against the repository by re-running the gates. What changed:

- **Cancellation no longer "burns" the NFT.** `AirTicketNFT.invalidateAsCancelled` marks the ticket `Cancelled` and emits `TicketInvalidated`; the contract deliberately does not burn so the public verifier can still read a cancelled ticket. Paper text and the Fig. 4 node label were corrected.
- **ERC-2981 is a view, not the settlement authority.** `TicketMarketplace.buyListing` computes `priceWei * f.royaltyBps / 10000` itself; `AirTicketNFT.royaltyInfo` is a display-only mirror of the same basis points. The paper no longer claims the contract "applies the ERC-2981 royalty rule".
- **DID/ECC/ZKP are marked as specification, not result.** Nothing on-chain or in the front end verifies a verifiable credential or a zero-knowledge proof; the checkout stand-in is a client-side checkbox. The contribution bullet, abstract, environment paragraph, and conclusion now say so.
- **Fig. 4 and Eq. (1) are now cited in the text** (they were dangling floats).
- **The ETH column is stated to come from the measured mean**, not the demonstration column, which is why purchase shows 0.00955 ETH beside a 386,325-gas cold-start transaction.
- **Reproducibility now names `SOLC_OPTIMIZER=1`, `PERF_OUT`, `doc/perf-eval.json`, and `doc/perf-eval-optimized.json`**, so the optimizer column in Table IV can be reproduced.
- Dead preamble (`graphicx`, `graphicspath`, `url`) removed; there are no `\includegraphics` calls left.
- Browser count 21 → 22: a test now covers the explicit sign-in / logout gate added in `wallet.js`.

### Diagram fixes already applied

The early TikZ diagrams had arrow labels overlapping the boxes. The current figures use a unified style (color-coded actors/processes/tokens/stores, `flow` arrows, `lbl` white-backed labels). In the 2026-10-10 pass the Fig. 2 and Fig. 4 label collisions were fixed: Fig. 2 arrow labels got 2.5 pt clearance from the lines and the two over-wide labels ("signed requests", "state + events") were set on two lines so they fit inside their gaps without touching box borders; Fig. 4's inter-box gap was widened 2.4 mm → 4.8 mm so "passes" no longer overlaps the boxes or the arrow.

### Compilation check (passed 2026-10-04)

The earlier `Unable to find standard directories for platform` error came from the editor-integrated compiler, not the source. The document now compiles locally with MiKTeX (run it with `Paper\` as the working directory, because MiKTeX writes the `.aux`/`.log`/`.pdf` into the current directory):

```bash
# workdir = Paper\
pdflatex -interaction=nonstopmode -halt-on-error main.tex
```

Result: **6 pages**, zero LaTeX errors, zero overfull boxes, no undefined references or citations (run twice for cross-references). Underfull boxes are expected in a two-column layout and are not treated as defects. The built PDF is `Paper\main.pdf` (`Paper/*.pdf` is git-ignored, so rebuild it after editing the source).

### Testing section (added 2026-10-04)

`\section{Testing and Evaluation}` sits before the Conclusion and uses only observed results from the finished prototype:

- Environment: Solidity 0.8.28, OZ 5.6.1, Hardhat 3.18 local chain (31337), ethers v6, protected upload with labeled mock-CID fallback, test ETH only.
- Verification table: 110/110 unit tests (success + failure paths for every public write), Slither 0.11.5 → 0 High / 0 Medium (19 informational documented), Solhint 0 errors, secret scan clean, `npm run eval` 7/7, Playwright 22/22.
- Scenario evaluation: full PRD §15 walkthrough with exact values (0.11 ETH → 0.0055 royalty + 0.1045 proceeds; 0.08/0.02 refund split; 7-field PII-free verifier; `FlightDeparted__id` blocks).
- Gas table (Table IV, local EVM): demo tx / measured mean / optimizer-enabled mean / ETH at 30 gwei — purchase 386,325 → 318,192 mean → 307,178 opt → 0.00955 ETH; list 310,302 → 310,302 → 299,536 → 0.00931; buy 185,674 → 173,784 → 161,422 → 0.00521; cancel 196,265 → 180,305 → 170,074 → 0.00541; markDeparted 33,049 → 33,049 → 32,335 → 0.00099; deploy five contracts 13,149,598 → 8,022,148 → 0.39449 ETH; wiring 170,891 → 169,258 → 0.00513 ETH.
- Limitations content: now the second paragraph of the Conclusion (no `Limitations` subsection since 2026-10-10) — single unloaded local node, no network peers/mempool/gas market (so measurements characterize the implementation, not production), no real airline or payment integration, simulated identity, mock-CID fallback.
- Evidence added on request (2026-10-04): per-suite distribution (15/11/12/31/33/8 = 110), failure-path paragraph with the real custom errors, runtime-security-posture paragraph, evaluator-assertion paragraph (wei reconciliation), `Reproducibility and Evidence` subsection (exact commands + archived artifacts), browser/accessibility evidence, validity paragraph, and positioning against Table II. Table IV's tx-hash-prefix column was replaced by the demo/mean/optimizer/cost columns in the performance pass.
- Abstract and Conclusion updated to reflect the working prototype (replacing the earlier "design proposal" wording), and now also mention the latency/throughput/gas measurements.

### Performance section (added 2026-10-04)

`\subsection{Latency and Throughput}` sits between Scenario Evaluation and Reproducibility. It is backed by `npm run perf` (`scripts/perf-eval.js` → spawns a node → `scripts/perf-measure.js`), with artifacts `doc/perf-eval.json` (default build) and `doc/perf-eval-optimized.json` (`SOLC_OPTIMIZER=1`):

- Method: HTTP JSON-RPC to a local Hardhat 3.18 node, 25 ms receipt polling, automine (20 samples/op; 10 for markDeparted) vs. `evm_setAutomine(false)` + `evm_setIntervalMining(1000)` (10 samples/op; 3 for markDeparted); reads sampled 100×.
- Latency Table V (median / p95 ms): automine purchase 32.6/41.5, list 30.4/37.2, buy 33.4/35.4, cancel 32.8/34.7, markDeparted 28.0/33.4; 1 s blocks 1027/1046, 1012/1042, 1014/1033, 1031/1038, 1001/1030; reads getTicket 25.2/28.6, getFlight 16.6/25.9, calculateRefund 16.7/20.2.
- Throughput: automine burst 100 tx in 1.16 s = 86.1 tx/s observed (90.7 to inclusion), 100 blocks × 1 tx; 1 s blocks: all 100 in one block, 1.21 s after first send = 82.1 tx/s observed (82.9 to inclusion); gas bound 188 purchases per 60M block; read QPS 59 (ethers) vs 827 (raw JSON-RPC).
- Optimizer A/B (`SOLC_OPTIMIZER=1`, runs=200): deployment −39.0% (13,149,598 → 8,022,148), runtime means −2.2%…−7.1% (purchase −3.5%, list −3.5%, buy −7.1%, cancel −5.7%, markDeparted −2.2%). Default build restored afterwards via `npm run compile`.
- Gates re-verified after the harness refactor: `npm run lint` 0 errors (306 pre-existing warnings), `npm test` 110/110, `npm run eval` 7/7.

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

All six original next steps are done: contracts + 110-test suite, vanilla frontend with admin console, protected upload endpoint, gates green (lint 0 errors, secret scan clean, Slither 0 High/0 Medium), prototype results captured in `doc/STATUS.md` / `doc/screenshots/phase6/`, and the IEEE testing/evaluation section written from observed outputs only. The 2026-10-04 performance pass is also complete: `npm run perf` harness added, latency/throughput/gas numbers measured and written into the paper, gates re-verified, and the paper still builds to 6 pages.

Remaining before submission, if desired:

1. Author block is intentionally blank for blind review — restore `\author{...}` only after review, if the venue wants it.
2. Re-run `pdflatex` twice after any edit and review the 6-page PDF layout (run with `Paper\` as the working directory).
3. Optionally add wall-clock timings per demo step — the performance harness now measures per-operation latency, burst throughput, and gas, but not end-to-end demo-step durations.

## Suggested Continuation Prompt

> Read `E:\Temp\Project\Airlines Ticketing System\CONTEXT.md` first. Continue the blockchain airline-ticketing project from the recorded state. Inspect the prototype implementation and compare it with `AIRLINE_TICKETING_PROTOTYPE_PRD.md`. Do not invent test results; use only observed outputs when adding the paper's testing/evaluation section.
