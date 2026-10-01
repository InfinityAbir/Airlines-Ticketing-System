# CONVENTIONS.md — Coding Standards and Practices

> Source of truth for how code is written. Stack: Solidity `^0.8.24` + Hardhat + OpenZeppelin + vanilla HTML/CSS/JS (ES2020) + Ethers.js v6. Requirements source: root-level `AIRLINE_TICKETING_PROTOTYPE_PRD.md` (§12–13; sole source of truth).

## 1. General Rules

- PRD is the requirements authority; do not invent features or add dependencies without a DECISIONS.md entry.
- Follow ARCHITECTURE.md layering and dependency direction; frontend never bypasses owning contracts.
- All user-facing ETH values display with 4+ decimals + wei tooltip; all money math in `wei` (`uint256`) integers; document the integer-division rounding rule wherever splits occur.
- Basis points convention: `10000 = 100%`; always render as `%` with 2 decimals in UI.
- Time convention: Unix seconds on-chain (UTC); UI shows local + UTC for every deadline/departure.

## 2. Repository and File Conventions

- Paths: `contracts/*.sol`, `scripts/deploy.js|seed.js`, `server/upload.js`, `test/*.test.js`, `frontend/*.html`, `frontend/assets/css/styles.css`, `frontend/assets/js/*.js`, generated `frontend/assets/js/contracts-config.js` (never hand-edit; never commit secrets into it).
- Filenames: PascalCase contracts (`AirTicketNFT.sol`), kebab/lowercase pages (`tickets.html`, `marketplace.html`), camelCase JS (`tickets.js`), `*.test.js` mirrors contract name.
- `.gitignore` must cover `node_modules/`, `artifacts/`, `cache/`, `.env`, `server/.env`, `*.key`, `*.mnemonic`, secret scans run in CI.
- Secrets rule (blocking): no API keys, Pinata/IPFS secrets, private keys, mnemonics, or seed phrases in tracked frontend files, configs, tests, or logs. Provider credentials live only in server env / protected endpoint. Middleware review + secret scan must pass (PRD §13).

## 3. Solidity Conventions

- License + pragma: `// SPDX-License-Identifier: MIT` + `pragma solidity ^0.8.24;`.
- Imports: OpenZeppelin only (`AccessControl`, `Pausable`, `ReentrancyGuard`, `ERC721`, `ERC2981` extensions); no inline crypto, no `tx.origin` for auth (use `msg.sender` + roles).
- Layout per contract: constants/roles → state → events → errors → modifiers → constructor → external → public → internal/private; NatSpec on all public/external functions.
- Naming: contracts PascalCase; functions/vars camelCase; constants `UPPER_SNAKE` incl. `MAX_ROYALTY_BPS = 1000`, `RESALE_CAP_BPS = 12000` (relative to original fare), `CHECKIN_WINDOW = 2 hours`, `DEFAULT_LISTING_DURATION = 24 hours`; roles `*_ROLE` (`AIRLINE_ROLE`, `MARKETPLACE_ROLE`); events past-tense (`FlightPublished`, `TicketMinted`, `TicketCancelled`, `TicketRefunded`, `ListingSold`, `AirlineApproved`); custom errors `ErrorName__detail` (e.g. `UnauthorizedAirline__addr`) — prefer custom errors over long revert strings, and map each custom error to a human-worded UI message (per ARCHITECTURE.md accessibility/explainability) rather than surfacing raw error names.
- State machines: use enums (`TicketState { Issued, Listed, Cancelled, Refunded, Used, Invalid }` — R1 sets single terminal `Cancelled`; `Refunded` retained unused for PRD compatibility); every transition validated explicitly and emitted; terminal states (`Cancelled`, `Used`, `Invalid`) reject further money/transfer ops.
- Money safety (blocking): `nonReentrant` on all payable/external-transfer functions; checks-effects-interactions; zero or update state before transfers; initialize all locals; per-airline accounting (`airlineBalances[airline]`); withdrawal restricted to the credited airline.
- Validation: mirror FR-08 and marketplace/cancel guards with explicit checks (past departure, zero capacity, duplicate active flight code, `refundBps > 10000`, `royaltyBps > 1000`, listing `priceWei > originalPrice * 12000/10000`, `expiresAt > departureTime - 2h`, deadline/departure, owner + `Issued`-only state, seats `S-<n>`).
- No plaintext PII in storage, events, `tokenURI`, or metadata CIDs (FR-15) — review + tests enforce this.

## 4. JavaScript / Frontend Conventions

- Vanilla ES2020 modules or plain scripts with one responsibility per file (see ARCHITECTURE.md §4.6); shared UI helpers only in `ui.js`; no logic duplication across page scripts.
- Ethers v6: `BrowserProvider`, `Contract` instances from generated config; every write path: (1) check `chainId`, (2) estimate/preview, (3) send, (4) `tx.wait(1)`, (5) toast pending → confirmed/failed with hash link (FR-05).
- Formatting helpers mandatory: `shortAddress`, `formatEth`, `formatBpsToPct`, `formatTimestamp` (local + UTC title attr).
- DOM: semantic HTML, `<label>` for every input, `aria-live="polite"` on toasts/tx status, focus moved to modal on open and restored on close; status shown as text + colour, never colour alone.
- CSS: single `styles.css`, CSS variables for palette/badges, mobile-first, breakpoint ~768px; focus-visible outlines required.
- Error handling: try/catch around every wallet/tx call; map revert reasons to human messages; never leave a disabled button or spinner stuck; failed tx writes to visible history.
- Storage: `localStorage` for UI prefs/chain hint only; never PII, documents, credentials, or keys (FR-15/20).

## 5. API (Contract) Conventions

- External function names: verbs (`createFlight`, `purchase`, `cancel`, `list`, `cancelListing`, `buyListing`, `calculateRefund`, `withdrawAirlineBalance`, `markDeparted`, `markUsed`). Booking signature is `purchase(flightId, cid)`; the contract validates and records the caller-supplied CID and rejects empty/invalid CIDs.
- View/preview parity: `calculateRefund(tokenId)` and marketplace preview math must equal the mutating function's formula exactly; UI calls the view before confirming.
- Events: emit on every state change with the IDs needed to rebuild dashboards (`flightId`, `tokenId`/`listingId`, actor, amounts, new state, timestamps) to satisfy FR-33/34 without an indexer. Cancel emits both `TicketCancelled` and `TicketRefunded(tokenId, refund, retained)`; the transaction hash is never an event field — the frontend reads it from the wallet transaction receipt. Resale emits price/royalty/seller proceeds.
- Upload endpoint: `POST /api/upload` accepts fictional non-sensitive JSON only (size/type limits, no PII check + reject), returns `{ cid, source: "ipfs" }`; credentials via server env only; frontend tags fallback CIDs `mock fallback`. R1 booking order is upload → CID → `purchase(flightId, cid)`; the upload is not atomic with the chain transaction and orphaned CIDs after failed transactions are acceptable.

## 6. Testing Conventions

- Framework: Hardhat + Chai (+ matchers); one test file per contract; `test/` names mirror contracts.
- Coverage bar (blocking for demo): 100% of public state-changing functions have happy-path + each documented failure-path test (wrong role, wrong state, wrong value, deadline/departure boundaries, double-action, bypass attempts, payout math incl. rounding).
- Each money test asserts exact wei splits (`seller + royalty == price`), correct payee, event args, and final states; boundary tests hit `refundDeadline`/`departureTime` ±1s.
- Static analysis + secret scan: zero unresolved high-severity findings and zero tracked secrets before demo (PRD §13/§17).
- E2E (Phase 6): scripted PRD §15 scenario runnable from fresh setup; browser checks follow DESIGN.md flows where applicable.

## 7. Git and Docs Hygiene

- Commits scoped to one STATUS.md phase; messages reference phase/task (e.g. `phase-2: purchase atomicity + tests`).
- After each phase: build + tests green, STATUS.md progress updated, DECISIONS.md appended only for meaningful technical calls, FEEDBACK.md triaged per Step 8.
- Keep the six docs mutually consistent; contradictions resolved in favour of PRD → ARCHITECTURE → DESIGN → CONVENTIONS → STATUS, and recorded in DECISIONS.md.
