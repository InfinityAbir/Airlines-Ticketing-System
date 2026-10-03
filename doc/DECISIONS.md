# DECISIONS.md — Architectural and Technical Decisions

> Records important decisions and their reasoning. Non-trivial only. Requirements source: root-level `AIRLINE_TICKETING_PROTOTYPE_PRD.md` (sole source of truth).

## D-01 — Retain vanilla HTML/CSS/JS + Ethers.js frontend (no framework)

- Decision: R1 uses vanilla HTML/CSS/JS with Ethers.js v6, per PRD §5.1 and §18 default.
- Reasoning: fastest inspectable demo, matches pension-prototype pattern evaluators know, avoids framework build/tooling overhead for 8 static pages.
- Alternatives rejected: React/Next — unjustified for R1 scope; reconsider only if page-state complexity forces it.
- Affects: ARCHITECTURE.md §2, DESIGN.md, Phase 2.

## D-02 — Single local Hardhat chain in R1, writes blocked elsewhere

- Decision: support exactly one configured chain (default 31337); UI refuses writes on any other chain (FR-03).
- Reasoning: PRD scopes R1 to local demo with test ETH (§3 goal 8, FR-03); multi-chain adds config/key risk with no demo value.
- Affects: `wallet.js` chain guard, generated `contracts-config.js`, Phase 1 completion.

## D-03 — Five-contract split (Registry / Inventory / NFT / Settlement / Marketplace)

- Decision: implement the PRD §9 table as five contracts with the dependency direction in ARCHITECTURE.md §5.
- Reasoning: mirrors pension separation (Registry/Documents/Fund/Disbursement), isolates money flows (settlement, marketplace) from records (inventory, NFT) and governance (registry); makes per-airline accounting and pause scoping testable.
- Affects: `contracts/`, Phase 1–4.

## D-04 — Ticket transfers restricted to approved contract pathway

- Decision: override ERC-721 transfer entry points so direct `transferFrom`/`safeTransferFrom` revert; only settlement/marketplace-controlled transitions succeed (FR-26).
- Reasoning: PRD non-goal + paper royalty model require resale to pass through royalty logic; open transfers would bypass airline royalty and state guards.
- Affects: `AirTicketNFT`, Phase 4 tests (bypass attempts must revert).

## D-05 — Protected IPFS upload in R1; mock CID as fallback only [SUPERSEDES mock-default, approved 2026-10-01]

- Decision: R1 uploads fictional, non-sensitive ticket metadata through a minimal server-side endpoint (`server/upload.js`, credentials via env, never in frontend or repo), then calls `purchase(flightId, cid)` with the returned CID; the contract atomically validates payment, reserves the seat, mints the NFT, and records the CID. IPFS upload is not atomic with the chain transaction: an unused CID after a failed transaction is acceptable prototype-level orphaned metadata. The deterministic mock/local CID generator remains only as a fallback when the endpoint is unreachable, with the CID source tagged `IPFS` / `mock fallback` in UI.
- Reasoning: owner-approved direction combining real upload integrity demo (FR-17/18) with the pension Critical finding (no browser secrets) and FR-20 (server-side custody of credentials).
- Affects: ARCHITECTURE.md §2–4/7, `server/`, Phase 2, security checklist.

## D-06 — One fixed refund rate per flight (no tiered schedule in R1)

- Decision: single `refundBps` + `refundDeadline` per flight; `refund = price * refundBps / 10000` (FR-22).
- Reasoning: PRD §18 recommends fixed rate; data model (§10) has no tier structure; tiered schedules add contract/test surface with no demo requirement.
- Affects: `FlightInventory`, `TicketSettlement.calculateRefund`, checkout cancel-preview, Phase 3 tests.

## D-07 — Cancelled seat returns to inventory in R1

- Decision: follow FR-23 release-1 rule — cancellation returns one seat to `seatsAvailable`.
- Reasoning: simplest demonstrable inventory story; PRD explicitly scopes R1 to return the seat.
- Affects: Phase 3.

## D-08 — Exactly one seat per purchase transaction in R1

- Decision: enforce single-seat `purchase(flightId, cid)` (FR-12); no quantity parameter, no batch mint.
- Reasoning: removes partial-fill and multi-mint edge cases from demo; matches PRD demo scenario.
- Affects: `purchase`, checkout UX, Phase 2 tests.

## D-09 — Simulated credential badge only (no real DID/ZKP in R1)

- Decision: labelled stub checkbox/badge gates checkout; copy states it is simulated and not identity verification (FR-19).
- Reasoning: PRD §4/§16 rule out production DID/ZKP as too large for timeline; stub preserves the paper's placement in the flow and marks the replacement boundary.
- Affects: checkout page, Phase 2.

## D-10 — No central database; chain + events + CID are the data layer

- Decision: no Postgres/MongoDB in R1; dashboards read contract state + event filters; metadata via CID fetch + match check.
- Reasoning: PRD defines no database requirement; adding one duplicates chain state and weakens the "shared tamper-evident record" demo.
- Affects: ARCHITECTURE.md §6, admin/operator history, Phases 2–5.

## D-11 — Per-airline revenue accounting with pull withdrawals

- Decision: settlement accrues `airlineBalances[airline]`; airline pulls via `withdrawAirlineBalance`; never push to arbitrary addresses; never cross-airline withdrawal (PRD §5.2 High).
- Reasoning: directly addresses the pension arbitrary-send finding; pull pattern + `nonReentrant` + checks-effects-interactions minimizes fund-misrouting risk.
- Affects: `TicketSettlement`, Phase 2/6 tests.

## D-12 — OpenZeppelin standards wherever applicable

- Decision: `AccessControl` (roles incl. `DEFAULT_ADMIN_ROLE`, `AIRLINE_ROLE`, `MARKETPLACE_ROLE`), `Pausable`, `ReentrancyGuard`, `ERC721`, `ERC2981` (PRD §9).
- Reasoning: audited primitives for the exact risks the pension audit flagged (reentrancy, uninitialized state, role confusion).
- Affects: all contracts, CONVENTIONS.md security rules.

## D-13 — Separate platform-admin and airline-operator roles; no multisig in R1

- Decision: two human roles from day one (PRD §5.2 Medium, §6); multisig/pause-process noted as future production work only.
- Reasoning: fixes single-admin concentration enough for a prototype without importing multisig complexity.
- Affects: registry, admin/operator pages, Phase 5.

## D-14 — Generated deployment config; UI shows network and refuses mismatches

- Decision: deploy writes `frontend/assets/js/contracts-config.js` (`chainId` + addresses); UI displays active network and blocks writes on mismatch (addresses PRD §5.2 High finding on hardcoded local addresses).
- Reasoning: environment-specific config prevents the "fixed to local network" failure mode while keeping local demo one-command.
- Affects: scripts, `wallet.js`, Phase 1.

## D-20 — Refund escrow held inside the airline balance (approved 2026-10-02)

- Decision: `purchase` credits the full fare (`airlineBalances[airline] += price`) **and** adds `refundReserve[airline] += price * refundBps / 10000`; `cancel` debits the refund from both (then pays the traveler); `withdrawAirlineBalance` pays `balance - refundReserve` only. The reserve is the slice of an airline's own credit that still backs active tickets.
- Reasoning: one ledger per airline instead of a second accounting structure; withdrawal stays a single subtraction; escrowed ETH is unwinnable by the withdraw path, and the reserve decays automatically as tickets cancel (each cancel removes exactly the share that purchase added). Cross-airline withdrawal stays impossible (D-11).
- Affects: `TicketSettlement` (`cancel`, `withdrawAirlineBalance`, `refundReserve`), ARCHITECTURE.md §4.4, Phase 3 tests, airline withdrawal panel.

## D-21 — Client-side QR generation with a vendored MIT library (approved 2026-10-02)

- Decision: `frontend/assets/vendor/qrcode.js` (`qrcode-generator@2.0.4`, MIT) renders a data-URL image of `verify.html?ticketId=N` in `ui.js` (`qrDataUrl`, `verifyLink`); the wallet card and verifier page both use it.
- Reasoning: the demo must run offline against a local chain — an external QR API would be a runtime dependency and would leak ticket links off-machine. Same vendoring pattern as ethers (small, MIT, checked-in bundle), and the secret scanner's `vendor/` exclusion already covers it.
- Affects: `ui.js`, `tickets.js` card, `verify.html`, Phase 3.

## D-22 — `list` takes an explicit `expiresAt` argument (approved 2026-10-03)

- Decision: `TicketMarketplace.list(uint256 tokenId, uint256 priceWei, uint256 expiresAt)`; the contract does **not** compute the 24-hour default internally. `previewResale(tokenId, 0)` still returns `defaultExpiry` and `checkinBound` so callers/UI can prefill a compliant value.
- Reasoning: the frontend must show and let the seller edit the expiry (it is displayed on the listing card, in the withdraw modal, and in history), and the test suite must be able to target both boundaries — `ExpiryInPast__expiresAt` and `ExpiryPastCheckin__expiresAt` — directly instead of manipulating `block.timestamp` around an internal default. The 24-hour default stays an R1 constant (`DEFAULT_LISTING_DURATION`) applied by the caller, so the on-chain rule remains only the two bounds: `expiresAt > now` and `expiresAt <= departureTime - 2h`.
- Affects: `TicketMarketplace.sol` (`list`, `previewResale`), `test/ticketMarketplace.test.js`, `frontend/assets/js/tickets.js` (list modal with `datetime-local` expiry input + live validation), ARCHITECTURE.md §4.5.

## Pending / Deferred (not decided — need input)

- P-05: `Design.md` vs `DESIGN.md` filename on case-insensitive filesystems (`DESIGN.md` canonical per workflow; no separate `Design.md` created).

## Locked R1 Defaults (approved 2026-10-01)

- D-15 — PRD file: root-level `AIRLINE_TICKETING_PROTOTYPE_PRD.md` is the sole canonical source; no `doc/PRD.md` alias and no `doc/` copy as a second source of truth.
- D-16 — Single terminal ticket state `Cancelled`; payout detail in separate `TicketRefunded(tokenId, refund, retained)` event (simpler, still auditable; contracts cannot know their own final transaction hash, so the frontend displays the hash from the wallet receipt). `Refunded` stays in the enum unused in R1 for PRD compatibility.
- D-17 — `markUsed` sole writer is `AirTicketNFT` (`AIRLINE_ROLE`, own flight, from `departureTime - 2h` onward). Pause blocks creation/publishing, purchase, listing, resale, transfers; `cancel`, `markUsed`, `markDeparted` + reads remain so active tickets resolve safely.
- D-18 — Marketplace settlement math authoritative; `royaltyInfo` display-only and equal to stored `royaltyBps`.
- D-19 — Numeric defaults: `maxRoyaltyBps = 1000` (10%); resale cap `priceWei <= originalPrice * 12000/10000` (120%); listing `expiresAt <= departureTime - 2h`, default duration 24h; check-in window 2h; seats auto-assigned `S-<n>`.
