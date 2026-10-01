# STATUS.md — Implementation Roadmap

> Source of truth for implementation progress.
> Tracks the canonical root-level PRD (`AIRLINE_TICKETING_PROTOTYPE_PRD.md`, Milestones §14) in small phases.

**Global completion rule:** a phase is complete only when its completion criteria are met, the project builds, its tests pass, and this file is updated. Do not work ahead on later phases.

## Phase 0 — Repo Scaffolding and Tooling

- Status: **Complete**
- Objective: runnable Hardhat project with lint, test, and secret-scan gates before any domain code.
- Tasks:
  1. Init `package.json`, Hardhat config (chain 31337), `.gitignore` (node_modules, artifacts, cache, secrets incl. `server/.env`, generated config).
  2. Add OpenZeppelin dependency, Ethers v6 for scripts/tests.
  3. Add test runner, linter (Solhint / ESLint), secret-scan step.
  4. Skeleton `README.md` with setup headings (filled in Phase 5) + `server/` placeholder for the protected upload endpoint.
- Dependencies: none.
- Completion criteria: `npx hardhat compile` and `npx hardhat test` run green on empty suite; secret scan configured; Node/Hardhat versions documented.
- Notes: Hardhat 3.18 (ESM, `"type": "module"`), solidity `0.8.28` (OpenZeppelin 5.6 requires `mcopy`/cancun; 0.8.24 WASM failed). `hardhat-chai-matchers@3` is a deprecated stub that aborts the process — removed; JS tests run via `npm test` (`scripts/run-tests.js`: boots `hardhat node`, runs Mocha, tears down) because Hardhat 3's `hardhat test` only runs Solidity tests. Solhint 6 (`solhint:recommended`). `npm run scan` = `scripts/scan-secrets.js`.

## Phase 1 — Foundation Contracts, Roles, Deploy + Seed

- Status: **Complete**
- Objective: admin can approve an airline; airline can create + publish a flight on the local chain via scripts (PRD Milestone 1 exit at contract level; UIs arrive in Phases 2 and 5).
- Tasks:
  1. Implement `AirlineRegistry` (approve/deactivate/reactivate, limits, pause) with events.
  2. Implement `FlightInventory` (create/publish/pause/cancel/markDeparted, reserve/release gated, FR-08 validation) with events.
  3. Implement `AirTicketNFT` skeleton only (compiles; restricted transfers, states, `MARKETPLACE_ROLE` gate, ERC-2981 view; no full mint logic beyond stub).
  4. Implement `TicketSettlement` + `TicketMarketplace` skeletons only (compiles + role gates + events; full purchase logic in Phase 2, full cancel logic in Phase 3, full marketplace logic in Phase 4).
  5. Lock two decisions in code: `markUsed` sole writer is `AirTicketNFT` (`AIRLINE_ROLE`, own flight, allowed from `departureTime - 2h` onward) and the pause matrix (pause blocks creation/publishing, purchase, listing, resale, transfers; `cancel`, `markUsed`, `markDeparted` + reads remain).
  6. Deploy script + generated `contracts-config.js` (chainId + addresses); seed script (1 airline, 1 five-seat flight, `royaltyBps <= 1000`).
  7. Unit tests: role gates, flight validation rejections (incl. `royaltyBps > 1000`), pause matrix (blocked vs remaining paths), address/config generation.
- Dependencies: Phase 0.
- Completion criteria: on fresh `hardhat node`, deploy + seed succeed; admin approves airline and airline publishes flight via script/direct contract call (no UI yet), UI config shows correct chain; role-violation writes revert; tests green.
- Verified (2026-10-01): `npm test` → 23/23 passing (AirlineRegistry 7, AirTicketNFT 5, FlightInventory 6, TicketMarketplace 3, TicketSettlement 2); `npm run lint` → 0 errors; `npm run scan` → clean; fresh `hardhat node` + `npm run deploy -- --network localhost` + `npm run seed -- --network localhost` → 5 contracts wired, airline approved, flight `R1-DEMO-001` (flightId 1) created and published, `frontend/assets/js/contracts-config.js` written with chainId 31337.
- Notes: `createFlight` takes a `CreateFlightParams` struct (9 flat params caused stack-too-deep; viaIR not enabled). Test helpers in `test/_helpers.js` use `cacheTimeout: -1` (ethers otherwise replays a pre-`evm_setNextBlockTimestamp` revert for 250ms) and chai 6 needs bigint literals (`1000n`) + exported `AssertionError`.

## Phase 2 — Booking Flow, Airline Creation UI, Upload Service, and Ticket Wallet

- Status: **Not Started**
- Objective: traveler buys one seat and sees exactly one issued NFT ticket; approved airline can create/manage flights from UI; metadata uploads via protected endpoint (PRD Milestone 2 exit).
- Tasks:
  1. Complete `purchase(flightId, cid)` (one seat/tx, on-chain leg atomically validates payment + reserves seat + mints NFT + records CID, exact-value check, auto `S-<n>` seat; CID comes from the protected upload first), `calculateRefund` view.
  2. Implement minimal `server/upload.js` (`POST /api/upload`, credentials server-side via env, fictional non-sensitive data only, size/type limits); R1 flow is upload → CID → `purchase(flightId, cid)`; document that a failed chain transaction after upload leaves acceptable orphaned metadata; frontend falls back to mock CID only when the endpoint is unreachable (CID source tagged `IPFS` / `mock fallback`).
  3. Frontend: `wallet.js` + `contracts-config` loading + chain guard; `index, flights, checkout, tickets` pages per DESIGN.md.
  4. Frontend: basic `airline.html` — flight creation form + inventory table + publish/pause/cancel/mark-departed actions (no royalty metrics yet; those arrive in Phase 4).
  5. Simulated credential stub (labelled) gating checkout; disclosure checkbox.
  6. CID-match verification display in wallet.
  7. Tests: happy-path purchase (inventory −1, one NFT, event, `S-<n>` seat, CID recorded from upload), failure paths (wrong value, no seats, paused, unauthorized mint, unapproved-airline create, empty/invalid CID rejected), upload-fallback CID recording, orphaned-CID-after-failure acceptance, secret scan (no credentials in frontend).
- Dependencies: Phase 1.
- Completion criteria: demo purchase on local chain yields one `Issued` ticket with correct owner/CID (source-tagged)/event; failed payments mint nothing; wallet shows ticket + lifecycle status; airline creates/publishes flight from UI; no secrets in tracked frontend code; tests green.

## Phase 3 — Cancellation, Use, and Public Verification

- Status: **Not Started**
- Objective: valid ticket verifies, cancels before deadline with correct refund, and is rejected afterwards (PRD Milestone 3 exit).
- Tasks:
  1. Complete `cancel` (owner + `Issued`-only + deadline + departure checks, atomic state update to single terminal `Cancelled` + refund + inventory return per FR-23, events `TicketCancelled` + `TicketRefunded(tokenId, refund, retained)`; transaction hash read from the wallet receipt, never from the contract), `markUsed` / `markDeparted` enforcement (writer locked in Phase 1; `markUsed` from `departureTime - 2h` onward).
  2. Complete `withdrawAirlineBalance` (per-airline pull, `nonReentrant`, never cross-airline).
  3. Frontend: cancel preview modal (refund/retained), result screen showing `Cancelled` + `TicketRefunded` event values with the transaction hash from the wallet receipt, `verify.html` (minimal fields, QR link), tx-history + filters.
  4. Tests: refund math (incl. boundaries: at/after deadline, after departure, double-cancel, non-owner, Listed-ticket cancel rejection, Used/Cancelled/Invalid tickets), inventory return, withdrawal gates + balances (incl. cross-airline rejection), `TicketRefunded` event args (refund + retained) plus receipt-hash display, verification reads.
- Dependencies: Phase 2.
- Completion criteria: cancel before deadline sets `Cancelled` and refunds `price*refundBps/10000` with matching `TicketRefunded` event; late/post-departure/duplicate/listed-state cancels revert; withdrawals pay only the credited airline; verifier shows state without PII; tests green.

## Phase 4 — Marketplace and Royalty Distribution

- Status: **Not Started**
- Objective: eligible ticket resells once with correct seller/royalty split verifiable from events (PRD Milestone 4 exit).
- Tasks:
  1. Complete `list(tokenId, priceWei) / cancelListing(listingId) / buyListing(listingId)` (one active listing/ticket, deadline/departure/cap guards with locked R1 values: `priceWei <= originalPrice * 12000/10000`, `royaltyBps <= 1000`, `expiresAt <= departureTime - 2h` default 24h; atomic pay-split + transfer + state update + events; `royaltyInfo` mirrors stored `royaltyBps`).
  2. Frontend: `marketplace.html` (list/buy flows with pre-confirmation breakdown); extend `airline.html` (built in Phase 2) with royalty/sales metrics; resale blocking after departed/cancelled.
  3. Tests: list guards (non-owner, terminal states, after deadline/departure, over 120% cap, `royaltyBps > 1000` at flight level, `expiresAt` past check-in bound, double-list), cancel-listing gates, buy split math (seller + royalty == price, rounding rule documented), royalty to correct airline, direct-transfer bypass attempts revert, double-buy and buy-after-cancel fail.
- Dependencies: Phase 3.
- Completion criteria: full resale demo (list → buy) shows correct proceeds/royalty/new owner in UI and events; ineligible listings/buys revert; tests green.

## Phase 5 — Admin Console, Audit Feed, and Emergency Controls

- Status: **Not Started**
- Objective: platform administrator can govern airlines, limits, and pause without touching ownership/data.
- Tasks:
  1. Frontend: `admin.html` (approvals, limits form, pause/unpause, filtered audit feed per FR-34).
  2. Contract wiring if missing: limit-bounds enforcement, pause coverage matrix (locked in Phase 1; wire UI to it).
  3. Tests: admin-only gates, limit validation (incl. `royaltyBps > 1000` rejection), pause matrix (creation/publishing, purchase, listing, resale, transfers blocked; `cancel`, `markUsed`, `markDeparted`, reads remain), admin cannot transfer tickets or alter balances.
- Dependencies: Phase 3 (registry core from Phase 1, UI patterns from Phase 2, event set from Phases 2–4). Sequenced after Phase 4 so the audit feed covers all event types.
- Completion criteria: approve/deactivate/reactivate + limits + pause all work from UI; audit filters function; unauthorized admin actions revert; tests green.

## Phase 6 — Quality Gates, Polish, and Demo Readiness

- Status: **Not Started**
- Objective: full demo runs from fresh setup, passes the security checklist (PRD Milestone 5 exit).
- Tasks:
  1. Reach 100% happy + failure-path coverage for all public state-changing functions; fix static-analysis high-severity findings; secret scan clean.
  2. Responsive/accessibility polish, empty/loading/error states, human-wording review.
  3. Deterministic demo dataset + evaluator script covering PRD §15 (approve → 5-seat flight → buy → verify → resale → cancel → departed blocks).
  4. Final `README.md` (fresh-setup steps), manual testing checklist (workflow Step 10 input), Playwright E2E for facing flows if browser coverage is required.
- Dependencies: Phases 0–5.
- Completion criteria: fresh-clone demo passes 100% per PRD §17 metrics; zero secrets in tracked client code; zero unresolved high-severity findings; verifier shows state without PII; resale accounting exact per documented rounding rule.

## Progress Log

| Date (UTC) | Phase | Update |
|---|---|---|
| 2026-10-01 | — | Roadmap created (Step 1). All phases Not Started. No implementation yet. |
| 2026-10-01 | — | Step 2 review: fixed Phase 1–5 dependencies/scope (script-first Phase 1, airline UI in Phase 2, withdrawal + listed-state tests in Phase 3, royalty extension in Phase 4, admin sequencing in Phase 5); no code written. |
| 2026-10-01 | — | Approved R1 defaults applied (single `Cancelled` terminal + `TicketRefunded` event; `markUsed` on NFT + pause matrix; marketplace math authoritative; 10% royalty cap / 120% price cap / 24h listing / 2h check-in / `S-<n>`; protected IPFS upload with mock fallback). No code written. |
| 2026-10-01 | 0 | Phase 0 complete: Hardhat 3.18 ESM project, solc 0.8.28, solhint 6, mocha-based `npm test` orchestrator, secret scan, README/.gitignore/`.solhint.json`. Compile + gates green. |
| 2026-10-01 | 1 | Phase 1 complete: 5 contracts (registry, inventory, NFT skeleton, settlement skeleton, marketplace skeleton) + deploy/seed scripts + 23 unit tests green; lint 0 errors; secret scan clean; deploy+seed verified on fresh localhost node; generated `contracts-config.js` (chainId 31337). |

## Locked R1 Defaults (approved 2026-10-01)

- `maxRoyaltyBps = 1000`; resale `priceWei <= originalPrice * 12000/10000`; listing `expiresAt <= departureTime - 2h` (default 24h); check-in window 2h; seats `S-<n>`; single terminal `Cancelled` + `TicketRefunded` event; protected IPFS upload, mock fallback only.
