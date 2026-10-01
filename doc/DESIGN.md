# DESIGN.md — UI/UX and System Behavior

> Source of truth for UI/UX and system behavior.
> Requirements source: root-level `AIRLINE_TICKETING_PROTOTYPE_PRD.md` (§7 journeys, §8 FRs, §11 pages; sole source of truth). Tech: vanilla HTML/CSS/JS + Ethers.js, no framework.

## 1. Design Principles

1. Wallet-first, role-routed: connect → show address/network/role → route to the right dashboard, while flights + verification stay public (FR-02/04).
2. Status-driven journey: every ticket shows one unambiguous badge (`Issued, Listed, Cancelled, Used, Invalid`; R1 terminal badge is `Cancelled` — `Refunded` is never a badge, refund detail appears in the receipt from the `TicketRefunded` event); every flight shows one display label derived from on-chain flags — `Draft` (created, never published, `salesOpen=false`), `Published` (`salesOpen=true`), `Paused` (sales halted after publish, `salesOpen=false`), `Cancelled` (`cancelled=true`), `Departed` (`departed=true`) — plus a `salesOpen` indicator. Display labels introduce no new storage.
3. Human wording for blockchain: "test ETH", "transaction hash", "CID status", plain-language refund/royalty breakdowns (PRD §12 Explainability).
4. Prototype honesty: permanent disclosure banner — "Educational prototype. Test ETH, sample flights, simulated credential check. Not a real booking system."
5. Transaction transparency: every write shows pending → confirmed/failed with hash link (FR-05); failures explain and never show false success.
6. Reuse pension-prototype language: navbar, summary cards, tables with empty states, toasts, tx-history sections (PRD §5.1, §11).
7. Privacy by display: verifier and listings never show passenger name, passport, credentials, or decrypted IPFS content (FR-32).

## 2. Global Layout

- Top navbar: logo/title, links (Flights, Marketplace, My Tickets, Airline, Admin, Verify), network pill (`Hardhat 31337` green / `Unsupported chain` red), wallet button (`Connect` → `0x1234…abcd` + role chip: Traveler / Airline Operator / Administrator / Guest).
- Below navbar on every page: prototype disclosure strip + network status line.
- Shared components (`frontend/assets/js/ui.js`): `toast(type, msg, txHash?)`, `statusBadge(state)`, `txProgress(states)`, `emptyState(table, msg)`, `txHistoryList(events)`, `addressShort(addr)`, `ethFormat(wei)`.
- Responsive: single-column cards under ~768px; tables collapse to stacked cards; wallet bar remains reachable; touch targets ≥ 44px.
- Accessibility: semantic landmarks, labels on all inputs, visible focus rings, colour + text for badges (never colour alone), keyboard-operable modals/dialogs, sufficient contrast.

## 3. Screens

### 3.1 `index.html` — landing (Everyone)

- Hero: what the prototype demonstrates (NFT ticket, audit trail, controlled resale) + 3-step demo path (Browse → Buy → Verify).
- Cards: network status (connected chain, supported chain, contract addresses loaded?), role entry points (Traveler / Airline / Admin / Verify ticket).
- Connect-wallet CTA; guest browsing allowed without wallet.
- Empty/error: unsupported chain → red banner + "Switch to Hardhat" guidance; missing `contracts-config.js` → "Run deployment first" message.

### 3.2 `flights.html` — catalogue (Everyone / Traveler)

- Filters: origin, destination, date (FR-11). Client-side filtering over published flights; "Clear filters" + result count + empty state ("No flights match — adjust filters").
- Flight card: `flightCode`, `origin → destination`, departure (local + UTC), seats remaining/capacity bar, price (ETH), refund deadline + refund % preview, royalty % note, airline short address, `salesOpen` badge. Departed/cancelled/paused flights shown greyed with reason, booking disabled.
- Action: `Select` → `checkout.html?flightId=…` (requires wallet + correct chain at checkout, not to browse).

### 3.3 `checkout.html` — purchase (Traveler)

Flow: flight summary → seat confirmation (R1: exactly one seat per tx, auto-assigned `S-<n>`, FR-12) → fare + policy review (price, refund deadline, refund %, royalty note) → simulated credential check (FR-19, labelled "SIMULATED CHECK — not real identity verification", checkbox/pass badge required before pay) → prototype disclosure accept checkbox → metadata upload (frontend POSTs fictional, non-sensitive metadata to the protected endpoint and receives a CID; mock CID fallback only when the endpoint is unreachable) → `Confirm payment` calling `purchase(flightId, cid)` → tx progress (pending → confirmed, hash link from the wallet receipt, ticket ID, CID status) → next actions (View ticket / Verify / Wallet).

- If the chain transaction fails after a successful upload, the UI explains that no ticket was issued and the unused CID is harmless orphaned prototype metadata; inventory is unchanged.

- Pre-confirmation panel shows exact price in ETH + wei; mismatched chain or insufficient balance blocks with plain message.
- Failure: clear reason (e.g. "Flight paused", "No seats left", "Payment rejected in wallet"), no ticket created, inventory unchanged.

### 3.4 `tickets.html` — ticket wallet (Traveler)

- Owned-ticket cards (FR-16): ticket ID, flight code/route/departure, seat ref (`S-<n>`), state badge, issue time, metadata CID + source tag (`IPFS` / `mock fallback`) + verification tick (`matches on-chain CID` / `mismatch`), QR + verification link (`verify.html?ticketId=`).
- Actions per state:
  - `Issued` + before deadline + before departure: `Cancel (preview refund)` → modal with refund/retained breakdown (matches contract math, FR-22) → confirm → result screen (refund + retained from the `TicketRefunded` event, transaction hash from the wallet receipt, final `Cancelled` state).
  - `Issued` + eligible: `List for resale` → price input (≤ 120% of original fare, validated) + expiry input (default 24h, never later than departure minus 2h) → preview (price, royalty ≤ 10%, seller proceeds, buyer view) → confirm.
  - `Listed`: `Cancel listing`.
  - `Cancelled/Used/Invalid` or post-departure: actions disabled with reason tooltip.
- Paused platform: creation/listing/purchase/resale entry points disabled with reason; cancel and used-marking remain available per ARCHITECTURE.md §9.
- Sections: active tickets, past tickets, transaction history (booking/cancel/sale events for this wallet).

### 3.5 `marketplace.html` — resale listings (Everyone / Traveler)

- Listing cards: ticket ID, route/departure, seat, price, airline royalty (≤ 10%), seller proceeds, seller short address, expiry (default 24h, capped at departure minus 2h), eligibility note. Buyers see pre-confirmation breakdown (FR-30): price = seller proceeds + airline royalty, new-owner address.
- Filters: route, max price, airline. Empty state: "No eligible listings."
- Buy flow: connect + chain check → confirm modal → atomic tx → receipt (hash, new owner, royalty paid). Direct NFT transfers are not offered in UI (FR-26).

### 3.6 `airline.html` — operator workspace (Airline Operator)

- Guard: unapproved wallets see "Awaiting administrator approval" + read-only flight list.
- Flight creation form (FR-07): flight code (unique), origin, destination, departure datetime, capacity, base fare (ETH), refundable-until, refund % (≤100), royalty % (≤ 10% platform cap). Inline validation mirrors FR-08 with field-level errors; past dates, zero capacity, duplicates rejected before sending tx.
- Inventory table: per flight — sold/remaining, sales display state (mapped from `salesOpen`/`cancelled`/`departed` per §1, never separate storage), test-ETH collected, royalty events; actions: `Publish / Pause sales / Cancel flight / Mark departed` (FR-09) with confirm modals for destructive actions.
- Event history: bookings, cancellations, resale royalties for own airline (FR-10).
- After `Mark departed`: UI immediately disables cancel/resale entry points for that flight's tickets and explains why.

### 3.7 `admin.html` — platform administration (Platform Administrator)

- Airline approvals table (FR-06): wallet, status (Approved/Disabled), approve/deactivate/reactivate actions + confirm.
- Platform limits form: `maxRoyaltyBps`, refund-policy bounds; shows current values; out-of-range rejected.
- Emergency `Pause / Unpause` platform control with explicit warning.
- Audit event feed with filters: flight, airline, ticket state, event type (FR-34); read-only — no ownership/data mutation controls exist on this page by design.

### 3.8 `verify.html` — public verification (Everyone, no wallet needed)

- Input: ticket ID or QR scan (QR encodes `verify.html?ticketId=`); deep-linkable.
- Result (FR-31/32): validity (`Valid / Cancelled / Used / Invalid`), airline short id, route code, departure time, seat status, shortened owner address. Explicitly absent: names, passport, credentials, raw IPFS content.
- CID integrity line: source tag (`IPFS` / `mock fallback`) + "Metadata matches on-chain record" or mismatch warning. Invalid IDs → "Not found / invalid ticket" (never an exception dump).

## 4. Navigation and Role Routing

- Public: `index, flights, marketplace, verify` — no wallet required to read.
- Protected: `checkout, tickets` (any connected wallet on supported chain); `airline` (approved `AIRLINE_ROLE`); `admin` (`DEFAULT_ADMIN_ROLE`).
- Router behavior (FR-04): unknown role → traveler view; wrong role → friendly "Not authorized for this space" + link to correct dashboard (never a blank page or redirect loop); logged-out access to protected page → connect prompt preserving intended destination.
- Chain guard global: any write on unsupported chain is blocked before signing with "Switch network" guidance (FR-03).

## 5. Forms, Validation, Loading and Error States

- Validation is dual: instant client-side (format, range, required) + authoritative contract revert display. Client messages quote the same rule (e.g. "Royalty exceeds platform cap of 10%", "Listing price exceeds 120% of original fare", "Listing expiry must be no later than departure minus 2 hours").
- Numeric inputs: ETH with wei preview; basis points shown as % with 2-decimal display; datetimes show local + UTC to avoid deadline confusion.
- Loading: buttons disable + spinner + `txProgress` stepper during signing/mining; tables show skeleton rows; event feeds show "Loading history…".
- Errors: toast + inline field error + tx-history entry with hash where available; failed tx never advances the UI state (e.g. no "Ticket issued" on revert).
- Empty states for every table/list (flights, tickets, listings, events, approvals).

## 6. Component Behavior Summary

| Component | Behavior |
|---|---|
| `statusBadge` | Fixed colour + text mapping for all ticket/flight states; text always present |
| `refundPreview` | Calls `calculateRefund` view; shows `refund / retained / rate / deadline`; identical formula to contract |
| `resalePreview` | Shows `price / royalty / seller proceeds / buyer` before signing |
| `credentialStub` | Labelled badge + checkbox; blocks checkout until passed; copy states it is simulated |
| `txHistory` | Per-page event list with type filter, short hash links, relative + absolute timestamps |
| `networkPill` | Green (supported) / red (unsupported); click → network help |

## 7. Locked R1 Defaults (approved 2026-10-01)

- Seats: auto-assigned `S-<n>`; no seat picker in R1.
- Ticket terminal badge: `Cancelled` only; refund shown from the `TicketRefunded` event (refund + retained); transaction hash shown from the wallet transaction receipt.
- Listing expiry: default 24h, hard cap at departure minus 2h (check-in window).
- Check-in window: 2h before departure; `markUsed` allowed from check-in open onward.
- Price cap: 120% of original fare; royalty cap: 10%.
- Metadata: protected IPFS upload; CID line carries `IPFS` / `mock fallback` source tag. R1 sequence is upload → CID → `purchase(flightId, cid)`; orphaned CIDs after failed chain transactions are acceptable.
