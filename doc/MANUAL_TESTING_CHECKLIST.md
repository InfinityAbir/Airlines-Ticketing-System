# MANUAL_TESTING_CHECKLIST.md — Final manual verification (Phase 6)

> Workflow Step 10 artifact. Companion to the automated gates:
> `npm test` (unit), `npm run test:e2e` (browser), `npm run eval` (PRD §15 evaluator),
> `npm run lint`, `npm run scan`, and `doc/STATIC_ANALYSIS.md` (Slither).
> Source of requirements: `doc/AIRLINE_TICKETING_PROTOTYPE_PRD.md` (§12–§17) + `doc/DESIGN.md`.
>
> **Fresh setup:** `git clone` → `npm install` → `npm run compile` → `npm test` →
> `npm run node` (terminal 1) → `npm run deploy -- --network localhost` +
> `npm run seed -- --network localhost` (terminal 2) → `npx serve frontend` +
> `node server/upload.js` (terminal 3) → open `http://localhost:3000`.
> Wallet: any Hardhat test account, chain 31337 (admin = #0, airline = #1, traveler = #2,
> buyer = #3). Automated coverage is noted per row so manual runs focus on what scripts cannot see.

## 1. Environment and setup

| ID | Scenario | Steps | Expected result | Priority |
|---|---|---|---|---|
| ENV-01 | Fresh clone builds | Clone repo, `npm install`, `npm run compile` | 5 contracts compile with solc 0.8.28, no errors | High |
| ENV-02 | Test suite boots its own chain | `npm test` | Runner starts a local node, runs Mocha, tears down; all tests pass | High |
| ENV-03 | Generated config is environment-specific | `npm run deploy -- --network localhost` | `frontend/assets/js/contracts-config.js` appears (git-ignored) with chainId 31337 and 5 addresses | High |
| ENV-04 | Seed creates the demo dataset | `npm run seed -- --network localhost` | Airline `0x7099…79C8` approved; flight `R1-DEMO-001` (id 1) published, 5 seats, 0.1000 ETH, 80% refund, 5% royalty | High |
| ENV-05 | Evaluator passes from a fresh chain | `npm run eval` | Prints `[1/7]…[7/7] PASS`, `passed: 7, total: 7`, exit code 0 | High |
| ENV-06 | Browser suite passes | `npm run test:e2e` | All specs green; screenshots land in `doc/screenshots/phase6/` | High |

## 2. Roles and permissions

| ID | Scenario | Steps | Expected result | Priority |
|---|---|---|---|---|
| ROLE-01 | Guest (no wallet) reads everything public | Open `flights.html`, `marketplace.html`, `verify.html`, `admin.html` without connecting | All pages render; no write controls anywhere; admin shows "Public audit view" | High |
| ROLE-02 | Non-admin wallet is read-only | Connect traveler wallet → `admin.html` | "Not authorized…" notice; approvals/limits/pause cards hidden; audit feed still readable | High |
| ROLE-03 | Admin session unlocks controls | Connect admin `0xf39F…2266` → `admin.html` | Three control cards visible, R1 defaults prefilled (10.00% / 100.00%), nine matrix rows "Available" | High |
| ROLE-04 | Unapproved airline sees a pending notice | Connect a fresh wallet → `airline.html` | Pending-approval notice, no flight creation form | Medium |
| ROLE-05 | Approved airline can create and publish | Connect `0x7099…79C8` → create flight → publish | Flight row appears, then moves to published state; both require wallet confirmation | High |
| ROLE-06 | Admin cannot move tickets or money | Admin session on `marketplace.html` / `tickets.html` | No extra powers: only owner can list/cancel; admin has no transfer UI | High |
| ROLE-07 | Wrong-chain writes blocked | Connect a wallet on a non-31337 chain | Inline "Switch network" prompt; no transaction is sent | Medium |

## 3. Core workflows (PRD §15)

| ID | Scenario | Steps | Expected result | Priority |
|---|---|---|---|---|
| CORE-01 | Book a seat | `flights.html` → Book → check both checkout boxes → Pay | Success panel with `ticket #1`, transaction hash, seat `S-1`, inventory drops to 4 of 5 | High |
| CORE-02 | Ticket wallet | `tickets.html` as traveler | Card under *Active* with `Issued` badge, CID line + source tag ("mock fallback" when the upload endpoint is off), QR, verify link | High |
| CORE-03 | Public verification | Open `verify.html?ticketId=1` (no wallet) | Shows state `Issued`, seat, operator/owner shortened, refund preview; FR-32 "never shown" note; no name/e-mail/passport fields | High |
| CORE-04 | List for resale | `tickets.html` → List → publish at 0.11 | Split preview shows royalty/proceeds; card becomes `Listed` with *Cancel listing* | High |
| CORE-05 | Third wallet buys | Connect buyer `0x90F7…3b906` → marketplace → Buy | Confirmation breakdown (FR-30), result shows price 0.1100 = royalty 0.0055 + seller 0.1045, ticket moves to buyer, listing disappears | High |
| CORE-06 | Airline sees the royalty | `airline.html` as airline | Resale count 1, non-zero royalty total, one table row with the ticket | Medium |
| CORE-07 | Cancel for a policy refund | Book a second seat → `tickets.html` → Cancel & refund | Preview shows 0.0800 / 0.0200 before sending; result shows `Cancelled`, refund, retained, hash; card moves to *Past & resolved*; seat returns to inventory | High |
| CORE-08 | Departed flight blocks actions | Airline marks flight departed | Marketplace Buy disabled with "already departed" reason; checkout shows the departed notice; cancel/list buttons disabled with that reason | High |
| CORE-09 | Boarding (`markUsed`) | Airline page → mark ticket used at/after departure − 2 h | Ticket becomes `Used`; terminal — cannot be cancelled or resold afterwards | Medium |
| CORE-10 | Revenue withdrawal | Airline → Withdraw | Receives `balance − refundReserve` only; button disabled with "nothing to withdraw" when zero | Medium |

## 4. Validation

| ID | Scenario | Steps | Expected result | Priority |
|---|---|---|---|---|
| VAL-01 | Flight form (FR-08) | Create flight with past departure / zero seats / `refundBps > 100` / `royaltyBps > 10` / duplicate code | Each rejected before any transaction, with a specific human message | High |
| VAL-02 | Checkout gates | Open checkout, tick one box only | Pay button stays disabled with the hint text | Medium |
| VAL-03 | Resale price cap | List at 0.15 (above 120% of 0.10) | Inline hint "may not exceed…" and the publish button stays disabled | High |
| VAL-04 | Listing expiry bound | Set `expiresAt` beyond departure − 2 h | Rejected in the modal with the check-in bound shown | Medium |
| VAL-05 | Admin limits range | Save 101% refund cap, or 5.555% royalty cap | Client-side errors ("Between 0% and 100%", "2 decimal places"), no confirmation modal, nothing sent | High |
| VAL-06 | Approve form | Submit `0x123`, then an already-approved wallet | "valid address" / "already approved" errors, no transaction | High |
| VAL-07 | Refund preview parity | Compare checkout preview with the cancel modal and with the final result | All three show the same `0.0800 / 0.0200` values (view math = state-change math) | High |
| VAL-08 | Ticket verifier input | `verify.html` with id `0`, `99`, and a non-numeric id | Warning for 0, "Not found" for unknown, no crash | Medium |

## 5. Error handling

| ID | Scenario | Steps | Expected result | Priority |
|---|---|---|---|---|
| ERR-01 | Rejected transaction wording | Trigger a contract revert (e.g. cancel a listed ticket) | Human message ("Only an issued ticket allows that action."), not a raw custom-error name or hex data | High |
| ERR-02 | Provider/chain mismatch | Disconnect wallet, then reconnect on another chain | Inline guidance, no stuck spinner, buttons recover | Medium |
| ERR-03 | Upload endpoint unavailable | Stop `server/upload.js`, then book | Booking still completes with the tagged `mock fallback` CID (D-05) | Medium |
| ERR-04 | Config missing | Delete/rename `contracts-config.js`, reload a page | "Contract configuration missing… run `npm run deploy`" notice, no exceptions in the console | Medium |
| ERR-05 | Empty and filtered states | Clear all flights/listings; apply impossible filters | Distinct copy for "nothing on chain yet" vs "no match for these filters" on flights, marketplace, history, audit feed | Medium |
| ERR-06 | Rejected/cancelled confirmation modal | Open any confirmation modal and press Cancel | Nothing is sent; the page state is unchanged | Medium |

## 6. Edge cases

| ID | Scenario | Steps | Expected result | Priority |
|---|---|---|---|---|
| EDGE-01 | Seat reuse after cancel | Cancel a ticket, then book again | The vacated seat number is re-offered; seat numbers never exceed capacity | High |
| EDGE-02 | Double cancel | Cancel the same ticket twice (UI then direct call) | Second attempt blocked by the terminal state (`NotIssued__state`) | High |
| EDGE-03 | Refund deadline boundary | Cancel at exactly `refundDeadline`, then 1 s after | At deadline succeeds; 1 s later reverts with the deadline error | High |
| EDGE-04 | Resale after deadline/departure | List or buy after the refund deadline or after departure | Reverted with the specific reason; marketplace card disabled | High |
| EDGE-05 | One listing per ticket | List an already-listed ticket | Reverted / button replaced by *Cancel listing* | High |
| EDGE-06 | Cross-airline withdrawal | Second airline attempts `withdrawAirlineBalance` for the first airline's credit | Nothing withdrawn; balances are per-airline | High |
| EDGE-07 | Pause exemptions | Pause the platform, then try cancel / mark used / mark departed / reads | All four still work; booking, listing, resale, transfers are blocked | High |
| EDGE-08 | Withdraw a listing while paused | Pause, then withdraw an active listing | Succeeds — withdrawing is always allowed | Medium |

## 7. Frontend UX and responsive behavior

| ID | Scenario | Steps | Expected result | Priority |
|---|---|---|---|---|
| UX-01 | Mobile layout (375 px) | Open every page at 375 × 700 | No horizontal scrolling; cards stack; navigation usable (automated in `04-polish`) | High |
| UX-02 | Tablet/desktop layout | Open every page at 768 px and ≥ 1280 px | Two-column grids apply above the 768 px breakpoint; no overlapping text | Medium |
| UX-03 | Keyboard-only operation | Tab through checkout, tickets and admin forms | Every control reachable, visible `:focus-visible` outline, modal focus trapped and restored | High |
| UX-04 | Screen-reader announcements | Trigger a toast, a transaction progress step and a page notice | `aria-live="polite"` regions announce status; inputs carry labels; `lang` and `main` present (automated in `04-polish`) | Medium |
| UX-05 | Status is never colour-only | Inspect badges (`Issued`, `Listed`, `Cancelled`, `Used`, `Paused`) | Each shows text as well as colour | Medium |
| UX-06 | Money formatting | Check every ETH figure and basis-point figure | ETH shows 4+ decimals with a wei tooltip; percentages show 2 decimals | Medium |
| UX-07 | Time formatting | Check deadline/departure labels | Local time plus UTC, consistent across pages | Low |
| UX-08 | Loading states | Reload a data-heavy page (admin feed, marketplace) | "Loading." placeholders, then content — no empty flash or stuck spinner | Medium |
| UX-09 | Draft preservation in admin limits | Type a new royalty cap while the admin page refreshes in the background | The typed value is not silently reset (fixed in Phase 6) | Medium |

## 8. Integration

| ID | Scenario | Steps | Expected result | Priority |
|---|---|---|---|---|
| INT-01 | Config → pages | Redeploy, then reload every page | All pages read the new addresses without manual edits | High |
| INT-02 | Events rebuild the dashboards | Perform a booking, cancel and resale | Admin audit feed, airline table and transaction history all show the actions with hashes (no indexer) | High |
| INT-03 | Upload service (IPFS configured) | Configure `server/.env`, upload then book | Response `{cid, source:"ipfs"}`, CID recorded on-chain, source tag "IPFS" | Low |
| INT-04 | CID fingerprint check | FR-18 verification on a mocked metadata payload | "matches on-chain CID" / "mismatch" / "not uploaded" for mock CIDs | Medium |
| INT-05 | Static file server | Serve `frontend/` from any static server | No build step required; vendored ethers/QR work offline | Low |

## 9. Security

| ID | Scenario | Steps | Expected result | Priority |
|---|---|---|---|---|
| SEC-01 | No secrets in tracked code | `npm run scan` after any change | "secret-scan OK" — no API keys, private keys, mnemonics, IPFS credentials anywhere in tracked files | High |
| SEC-02 | Server-side credentials only | Inspect `frontend/**` and `server/.env` | No provider credentials in browser code; `.env` git-ignored | High |
| SEC-03 | Static analysis | Run Slither per `doc/STATIC_ANALYSIS.md` | 0 High / 0 Medium; every remaining finding documented | High |
| SEC-04 | No PII on chain | Inspect `getTicket`, events and `tokenURI` | Exactly seven non-identity fields; no names, documents or contact data (FR-15) | High |
| SEC-05 | Direct ERC-721 transfer bypass | Call `transferFrom` outside settlement/marketplace | Reverts; only the approved pathway moves tickets | High |
| SEC-06 | Reentrancy on payouts | Cancel/withdraw/buy repeatedly (unit tests cover this) | `nonReentrant` + checks-effects-interactions hold; contract balances reconcile exactly | High |
| SEC-07 | Pause cannot strand funds | Pause the platform, then withdraw airline revenue | Withdrawal and cancellation remain available | High |
| SEC-08 | Page console cleanliness | Browse all pages with devtools open | No uncaught exceptions or console errors (asserted by every E2E spec) | Medium |

## 10. PRD §17 acceptance spot-checks

| ID | Scenario | Steps | Expected result | Priority |
|---|---|---|---|---|
| ACC-01 | Full demo from fresh setup | Follow the fresh-setup block at the top of this file, then the PRD §15 scenario end to end | Every step succeeds without editing code or config by hand | High |
| ACC-02 | Public verification without PII | CORE-03 | Verifier shows state only | High |
| ACC-03 | Exact resale accounting | CORE-05 | `royalty + proceeds == price` to the wei, per the documented flooring rule | High |
| ACC-04 | Test coverage of every public write | `npm test` + CONTRACTS checklist | Every public state-changing function has success and failure-path tests | High |
| ACC-05 | Documentation consistency | Read PRD → ARCHITECTURE → DESIGN → CONVENTIONS → STATUS → DECISIONS | No contradictions; Phase 6 marked complete with evidence | Medium |
