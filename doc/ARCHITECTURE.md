# ARCHITECTURE.md — Airline Ticketing Prototype

> Source of truth for system structure.
> Requirements source: root-level `AIRLINE_TICKETING_PROTOTYPE_PRD.md` (canonical; per approved decision 2026-10-01 there is no `doc/PRD.md` alias and `doc/AIRLINE_TICKETING_PROTOTYPE_PRD.md` is not a second source of truth). Do not invent requirements beyond the PRD.

## 1. Overview

Educational blockchain prototype demonstrating an auditable ticket lifecycle: flight creation → purchase + NFT mint → ticket wallet → cancellation/refund → controlled resale with airline royalty → public verification.

What the system is:

- Wallet-first web dApp (vanilla HTML/CSS/JS + Ethers.js), role-routed by wallet address.
- Five Solidity contracts on a local Hardhat chain (R1 supports one configured chain only).
- Ticket = restricted ERC-721 NFT; off-chain metadata referenced by CID only.
- No production payments, no GDS integration, no real identity, no open transfers (PRD §4).

What the system is not:

- Not a booking engine, not a payment gateway, not a DID/ZKP provider.

## 2. Technology Stack (from PRD §5.1, §9, §12)

| Layer | Choice (R1) | Notes |
|---|---|---|
| Smart contracts | Solidity `^0.8.24`, Hardhat, OpenZeppelin (`AccessControl`, `Pausable`, `ReentrancyGuard`, `ERC721`, `ERC2981`) | No custom crypto; no proxy upgrades in R1 |
| Local chain | Hardhat network, chain ID 31337 (default) | Single supported chain; UI blocks writes on other chains (FR-03) |
| Frontend | Vanilla HTML/CSS/JS (no framework), Ethers.js v6, MetaMask / injected EVM wallet | Reuses pension-prototype pattern per PRD §5.1 |
| Off-chain metadata | Protected IPFS upload in R1 (fictional, non-sensitive sample data only); credentials held server-side only; deterministic mock CID generator as fallback when IPFS is unavailable | Never embed API keys in frontend (PRD §5.2 Critical); UI verifies retrieved metadata matches recorded CID (FR-18) |
| Upload service | Minimal server-side upload endpoint (`server/` — plain Node, no framework) holding provider credentials; frontend POSTs metadata, receives CID | Secrets stay server-side and git-ignored; mock CID fallback keeps local demo runnable |
| Tests / analysis | Hardhat + Chai unit tests, static analysis (Slither or equivalent), secret scan (gitleaks/trufflehog or equivalent) | 100% of public state-changing fns need happy + failure-path tests (PRD §17) |
| Seed / deploy | Hardhat Ignition or `scripts/deploy.js` + `scripts/seed.js`, generated `frontend/assets/js/contracts-config.js` (chainId + addresses + ABIs; committed in R1 because it holds no secrets) | Never commit private keys / mnemonics; if a future upload proxy needs secrets, split config so secrets stay server-side and git-ignored |

No backend database, no UI framework in R1. One minimal backend exception: the server-side IPFS upload endpoint above (approved 2026-10-01). Any further addition needs a DECISIONS.md entry and approval.

## 3. Proposed Repository Structure

```text
project-root/
├── AIRLINE_TICKETING_PROTOTYPE_PRD.md   # canonical PRD (sole source of truth for requirements)
├── doc/
│   ├── ARCHITECTURE.md                       # this file
│   ├── DESIGN.md
│   ├── STATUS.md
│   ├── DECISIONS.md
│   ├── FEEDBACK.md
│   └── CONVENTIONS.md
├── contracts/
│   ├── AirlineRegistry.sol
│   ├── FlightInventory.sol
│   ├── AirTicketNFT.sol
│   ├── TicketSettlement.sol
│   └── TicketMarketplace.sol
├── scripts/
│   ├── deploy.js
│   └── seed.js            # sample airlines + flights (5-seat demo flight per PRD §15)
├── server/
│   └── upload.js          # R1 protected IPFS upload endpoint (holds credentials server-side; returns CID). Mock CID fallback lives in frontend when this endpoint is unreachable.
├── test/
│   ├── airlineRegistry.test.js
│   ├── flightInventory.test.js
│   ├── airTicketNFT.test.js
│   ├── ticketSettlement.test.js
│   └── ticketMarketplace.test.js
├── frontend/
│   ├── index.html
│   ├── flights.html
│   ├── checkout.html
│   ├── tickets.html
│   ├── marketplace.html
│   ├── airline.html
│   ├── admin.html
│   ├── verify.html
│   └── assets/
│       ├── css/styles.css
│       └── js/
│           ├── wallet.js        # connect, network guard, role routing
│           ├── contracts-config.js  # GENERATED at deploy (addresses + chainId + ABIs or ABI paths)
│           ├── flights.js
│           ├── checkout.js
│           ├── tickets.js
│           ├── marketplace.js
│           ├── airline.js
│           ├── admin.js
│           ├── verify.js
│           └── ui.js            # toasts, badges, tx states, empty states
├── hardhat.config.js
├── package.json
└── README.md                  # fresh-setup demo steps (Phase 5)
```

Nothing above exists yet (repo currently holds only `AIRLINE_TICKETING_PROTOTYPE_PRD.md`, `Paper/`, workflow file). Do not treat this layout as already implemented — it is the target.

## 4. Modules and Responsibilities

### 4.1 `AirlineRegistry` — platform administration

- Roles: `DEFAULT_ADMIN_ROLE` = platform administrator.
- State: `airlineApproved[wallet]`, platform limits (`maxRoyaltyBps`, refund-policy bounds), `paused`.
- Ops: `approveAirline`, `deactivateAirline`, `reactivateAirline` (FR-06); `setLimits`, `pause/unpause` (admin only).
- Emits events for every state change (FR-33).

### 4.2 `FlightInventory` — airline-owned flight records

- Roles: `AIRLINE_ROLE` granted only to registry-approved operator wallets.
- State per `Flight` (PRD §10): `flightId, airline, flightCode, origin, destination, departureTime, seatCapacity, seatsAvailable, priceWei, refundDeadline, refundBps, royaltyBps, salesOpen, departed, cancelled`.
- Ops: `createFlight`, `publishFlight`, `pauseSales`, `cancelFlight`, `markDeparted` (FR-07/09); `reserveSeat` / `releaseSeat` callable only by settlement/marketplace contracts; `markDeparted` blocks later cancel/resale at contract level.
- Validation (FR-08 + locked R1 defaults 2026-10-01): reject past `departureTime`, zero capacity, duplicate active `flightCode`, `refundBps > 10000`, `royaltyBps > maxRoyaltyBps` where `maxRoyaltyBps = 1000` (10%).
- Seats (R1): auto-assigned sequential `seatReference` in `S-<n>` format (`S-1, S-2, …`); no buyer-chosen seats, no seat map in R1.

### 4.3 `AirTicketNFT` — restricted ERC-721

- State per `Ticket` (PRD §10): `tokenId, flightId, seatReference, owner, metadataCID, issuedAt, state, lastTransferAt`. R1 terminal state: `Cancelled` (single terminal per approved decision 2026-10-01; `Refunded` remains in the enum for PRD compatibility but is never set as `state` — payout detail travels in the `TicketRefunded` event instead).
- Ops: `mint` (settlement only), `invalidate/burn` (settlement on cancel), `markUsed(tokenId)` (sole writer: `AIRLINE_ROLE`, own flight only, allowed only when `block.timestamp >= departureTime - checkInWindow` with `checkInWindow = 2 hours`, or after departure), `markListed(tokenId)` / `markUnlisted(tokenId)` (sole writer: `MARKETPLACE_ROLE`), `setState`, controlled transfer hook (marketplace or settlement only).
- Listing state: `markListed` requires state `Issued` (so a terminal or already-listed ticket rejects) and is gated by `whenPlatformLive`, which reads `AirlineRegistry.paused()` only — the marketplace's own `pause()` does not stop the NFT state change. `markUnlisted` is intentionally not pause-gated so a listing can always be withdrawn. Both emit `TicketListed` / `TicketDelisted`.
- Standard direct transfers (`transferFrom`/`safeTransferFrom`) are disabled/overridden to revert except through the approved pathway (FR-26). Enforce via `_update` override + `MARKETPLACE_ROLE` gate.
- ERC-2981 `royaltyInfo` is display-only and must equal the marketplace's stored `royaltyBps` for that flight; settlement math in `TicketMarketplace` is authoritative.

### 4.4 `TicketSettlement` — purchase, cancellation, refund, revenue

- Ops: `purchase(flightId, cid)` payable — exactly one seat per tx (FR-12); `cancel(tokenId)`; `calculateRefund(tokenId)` view; `withdrawAirlineBalance()` per-airline only. `markUsed` lives on `AirTicketNFT` (locked 2026-10-01), not here.
- Purchase flow (R1, not atomic across systems): `Frontend uploads fictional, non-sensitive metadata through the protected upload endpoint → endpoint returns CID → traveler calls purchase(flightId, cid) → smart contract atomically validates payment, reserves the seat, mints the ticket NFT, and records the CID.` The on-chain leg is atomic (on any failure: no mint, no decrement, PRD §13 checklist). IPFS upload cannot be atomic with the blockchain transaction: if the chain transaction fails after upload, the unused CID is acceptable prototype-level orphaned metadata. Mock CID fallback applies only when the upload endpoint is unreachable.
- Cancel flow (atomic): check caller is the ticket owner and state is `Issued` (plus `block.timestamp <= refundDeadline`, `refundDeadline` never later than departure, and the flight not marked departed — terminal `Used`/`Cancelled`/`Invalid` therefore always reject) → compute `refund = price * refundBps / 10000`, `retained = price - refund` → effects: set state `Cancelled` (`invalidateAsCancelled`, burn) and re-queue the seat number into the flight's pool → interaction: transfer `refund` to the owner last → emit `TicketCancelled` + separate `TicketRefunded(tokenId, refund, retained)`. Zero-rate flights simply move no ETH. The frontend obtains the transaction hash from the wallet transaction receipt and displays it alongside the event data.
- Accounting (escrow inside the balance, D-20): `purchase` does `airlineBalances[airline] += price` and `refundReserve[airline] += price * refundBps / 10000`; `cancel` debits the refund from both before paying; `withdrawAirlineBalance()` pays `airlineBalances[airline] - refundReserve[airline]` and never touches the reserve, so the reserve always covers every still-active ticket's maximum refund. Withdrawals use checks-effects-interactions + `nonReentrant`; an airline can never withdraw another airline's balance.

### 4.5 `TicketMarketplace` — approved resale

- State per `Listing` (PRD §10): `listingId, tokenId, seller, priceWei, active, createdAt, expiresAt`. Indexes: `nextListingId`, `activeListingByToken[tokenId]` (zero ⇒ no active listing). The contract holds no ETH — it is a pass-through, so its balance is `0` after every `buyListing`.
- Ops: `list(tokenId, priceWei, expiresAt)` (the expiry is an explicit caller argument, see DECISIONS D-22 — the UI needs to show and validate it and the tests need to target the check-in bound), `cancelListing(listingId)`, `buyListing(listingId)` payable; views `getListing(listingId)`, `getActiveListings()`, `previewResale(tokenId, priceWei)`; admin `pause()` / `unpause()`.
- Guards (FR-27/28 + locked R1 defaults 2026-10-01): one active listing per ticket (`AlreadyListed__tokenId`); seller only (`NotTicketOwner__caller`); ticket must be `Issued` (terminal `Cancelled`/`Used`/`Invalid` always reject); flight not cancelled and not departed; `block.timestamp <= refundDeadline`; `expiresAt > block.timestamp`; `expiresAt <= departureTime - checkInWindow` (`checkInWindow = 2 hours`); default listing duration 24 hours (capped by that bound); `priceWei > 0` and `priceWei <= originalPrice * 12000 / 10000` (120% of original fare); `royaltyBps <= maxRoyaltyBps (1000)`.
- List flow (atomic): validate guards → record the listing and set `activeListingByToken` → `AirTicketNFT.markListed(tokenId)` → emit `ListingCreated(listingId, tokenId, seller, priceWei, expiresAt)`.
- Buy flow (atomic, sibling rule §5 rule 4): re-check active + unexpired + `msg.value == priceWei` → effects: close the listing, clear `activeListingByToken`, `markUnlisted`, `controlledTransfer(seller → buyer)` and the ticket returns to `Issued` under the new owner → interactions: `royalty = price * royaltyBps / 10000` (floored) paid straight to the flight's airline wallet, `sellerProceeds = price - royalty` paid to the seller, so `royalty + sellerProceeds == price` exactly → emit `ListingSold(listingId, tokenId, buyer, priceWei, royalty, sellerProceeds)`. Settlement is never called and no ETH is escrowed anywhere.
- Withdraw flow: `cancelListing(listingId)` — seller only, active only, no pause guard → clear the index, `markUnlisted` (ticket returns to `Issued`), emit `ListingCancelled(listingId)`.
- Pause: both `AirlineRegistry.paused()` and the marketplace's own `pause()` block `list` and `buyListing` (`PlatformPaused__`); only the admin (`NotAdmin__caller`) toggles the local pause. `cancelListing` and all views stay available.

### 4.6 Frontend modules (`frontend/assets/js/`)

- `wallet.js`: connect, display address/network/role (FR-02), chain guard, pending/confirmed/failed tx toasts with hash link (FR-05).
- Page scripts: one per page, no shared business logic duplication; shared UI in `ui.js`. `verify.js` is the public verifier — it reads through a plain `JsonRpcProvider` (`Wallet.readPublic`) and needs no wallet, no login, and shows no identity fields (FR-32).
- `contracts-config.js`: generated artifact — `{ chainId, addresses: {...}, ... }`. UI refuses writes when `walletChainId !== config.chainId`.
- Pause mirroring (verified 2026-10-03): every page that gates a write must read **both** sources that the target contract's `whenPlatformLive` checks — `registry.paused() || <own>.paused()`. Reading only the registry leaves live-looking buttons that revert. `checkout.js` therefore reads registry + settlement, `marketplace.js` reads registry + marketplace, and `tickets.js` reads registry + marketplace (listing only; withdrawing a listing stays available under either).

## 5. Layering and Dependency Direction

```text
frontend (vanilla JS + Ethers)
   │ reads/writes via contract ABIs
   v
TicketSettlement  TicketMarketplace
   │ \                │ \
   │  \               │  \ (reads flight policy, reserves/releases via restricted fns)
   v   v              v   v
FlightInventory   AirTicketNFT
   │                  │
   v                  v
AirlineRegistry (roles/limits/pause source)
```

Rules:

1. Frontend never encodes business rules authoritatively — contracts are authoritative; UI mirrors calculations (e.g. refund preview) for display only.
2. `FlightInventory` and `AirTicketNFT` never call settlement/marketplace; the direction is strictly downward except via role-gated callbacks.
3. `AirlineRegistry` is depended upon, never depends on other ticketing contracts.
4. `TicketSettlement` and `TicketMarketplace` are siblings — neither calls the other directly in R1 (avoids circular dependency); shared ticket-state transitions go through `AirTicketNFT`.
5. No direct frontend → `reserveSeat` / `mint` / raw transfers; all writes pass through the owning contract's public function.

## 6. Data Approach (no central DB in R1)

- Authoritative state: on-chain (flights, tickets, listings, balances).
- Off-chain: ticket metadata blob referenced by CID (non-sensitive sample or encrypted data only, FR-17). UI verifies retrieved metadata matches recorded CID before showing it as valid (FR-18).
- History/audit: contract events (FR-33/34); dashboards filter by flight, airline, ticket state, event type using Ethers event filters over the local chain. No indexer (e.g. subgraph) in R1.
- Browser storage: wallet/session UI prefs only. Never store PII, passenger documents, or secrets in `localStorage`, logs, or NFT metadata (FR-15/20).

## 7. Integrations and Boundaries

| Integration | Boundary | R1 decision |
|---|---|---|
| Wallet | EIP-1193 injected provider (`window.ethereum`), Ethers `BrowserProvider` | MetaMask-compatible; no WalletConnect in R1 |
| IPFS | `metadataCID` string on ticket; upload via `POST /api/upload` on the server endpoint, retrieval via public gateway | Protected upload in R1 with fictional non-sensitive data only; credentials server-side, never in frontend (PRD §5.2 Critical); mock CID fallback only when endpoint unreachable |
| DID/credentials | Clearly labelled simulated check badge before booking (FR-19) | Stub only; must not claim real verification; replacement boundary documented in code |
| QR verification | `verify.html?ticketId=` + rendered QR encoding that URL | Public, no auth; minimal fields only |
| Payments | Native test ETH on Hardhat | No fiat, no card gateway; disclosure banner on every payment screen |

API boundaries: there is no booking REST API in R1. The contract surface (public functions + emitted events incl. `TicketRefunded`) is the system API and the frontend/backend boundary for chain reads/writes (Ethers contract instances from the generated file). The sole REST surface is `POST /api/upload` (metadata → CID) on the protected upload endpoint.

## 8. Authentication and Authorization

- Authentication = wallet signature / connected address. No passwords, no sessions.
- Authorization = on-chain `AccessControl`:
  - `DEFAULT_ADMIN_ROLE`: approve/deactivate airlines, set limits, pause.
  - `AIRLINE_ROLE`: create/manage own flights, mark departed/used (own flights only).
  - `MARKETPLACE_ROLE`: held by `TicketMarketplace` contract address on `AirTicketNFT` for controlled transfers.
- Frontend role routing is convenience only (FR-04); every privileged write re-checks on-chain. Admin cannot alter ticket ownership or traveler data (PRD §6).

## 9. Cross-Cutting Architectural Rules

1. Single-chain guard: every write path checks chain ID first; mismatch → block with explanatory error.
2. Atomicity: the on-chain legs of purchase/cancel/resale either fully succeed or leave chain state unchanged; failed payment never mints or decrements. The off-chain IPFS upload precedes `purchase(flightId, cid)` and is not part of the atomic unit (orphaned CIDs acceptable, see §4.4).
3. State machine enforcement: terminal `Cancelled` plus `Used`/`Invalid` tickets (and defensively `Refunded`) reject cancel/resale/transfer (FR-25); departed flights reject cancel/resale at contract level, not just UI.
4. Money safety: `nonReentrant` + checks-effects-interactions on all payable/external-transfer fns; per-airline accounting; zero-before-transfer; initialized locals; exact-value tests. Royalty math: `royalty = price * royaltyBps / 10000` with `royaltyBps <= maxRoyaltyBps (1000)`; marketplace split authoritative, `royaltyInfo` mirrors it.
5. No secrets in frontend bundle or repo: CI secret scan must pass (PRD §13).
6. Events for everything: every state change emits an event sufficient to rebuild dashboards and demo audit trails.
7. Pause (locked 2026-10-01): `Pausable` on registry/settlement/marketplace. While paused, flight creation/publishing, purchase, listing, resale (`buyListing`), and NFT transfers are blocked. Cancellation/refund (`cancel`), `markUsed`, and `markDeparted` remain available so active tickets can be resolved safely; reads stay available. Two independent pause sources feed the marketplace (`AirlineRegistry.paused()` and `TicketMarketplace.pause()`, admin-only), and `AirTicketNFT.whenPlatformLive` reads only the registry; `cancelListing` / `markUnlisted` are deliberately exempt so a listing can always be withdrawn while paused (verified by the Phase 4 pause test and browser check).

## 10. Non-Functional Implications

- Performance: local reads < 2s after connect; one booking = one local tx confirmation (PRD §12). No optimization beyond avoiding event-scan storms (bounded block ranges in UI).
- Accessibility / explainability: handled in DESIGN.md; architecture supports it via human-readable revert reasons + structured events.
- Privacy: contract storage, NFT metadata, logs contain zero plaintext PII by construction; enforced by code review + tests, not just convention.

## 11. Relationship to Paper

The paper (`Paper/blockchain_airline_ticketing_ieee.tex`) proposes DID+ECC+ZKP + ERC-2981 + IPFS. The prototype implements the demonstrable subset: ERC-721 + ERC-2981 royalties + IPFS-CID integrity + simulated credential stub. Full DID/ZKP circuits are explicitly out of scope (PRD §4) — the stub marks the replacement boundary.

## 12. Locked R1 Defaults (approved 2026-10-01)

- PRD file: root-level `AIRLINE_TICKETING_PROTOTYPE_PRD.md` is the sole canonical source; no `doc/PRD.md` alias and no `doc/` copy as a second source of truth.
- Ticket terminal state: single `Cancelled` + separate `TicketRefunded(tokenId, refund, retained)` event (transaction hash comes from the wallet receipt, never from the contract).
- `markUsed`: sole writer `AirTicketNFT`, `AIRLINE_ROLE`, own flight only, allowed when `block.timestamp >= departureTime - 2 hours` (check-in window) or after departure.
- Royalty: marketplace math authoritative; `royaltyInfo` display-only and equal to stored `royaltyBps`; `maxRoyaltyBps = 1000` (10%).
- Resale: `priceWei <= originalPrice * 12000 / 10000` (120% of original fare); `expiresAt <= departureTime - 2 hours`; default listing duration 24 hours (capped by that bound).
- Seats: auto-assigned `S-<n>` (`S-1, S-2, …`).
- Metadata: protected IPFS upload with fictional non-sensitive data only; mock CID fallback only when the endpoint is unreachable.
