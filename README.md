# Airlines Ticketing System — Blockchain-Based Secure & Transparent Airline Ticketing

[![Solidity](https://img.shields.io/badge/Solidity-0.8.28-363636?logo=solidity&logoColor=white)](https://docs.soliditylang.org/)
[![Hardhat](https://img.shields.io/badge/Hardhat-3.18-FFF5E6?logo=hardhat&logoColor=black)](https://hardhat.org/)
[![OpenZeppelin](https://img.shields.io/badge/OpenZeppelin-5.6-4E5EE4?logo=openzeppelin&logoColor=white)](https://www.openzeppelin.com/contracts)
[![Ethers.js](https://img.shields.io/badge/Ethers.js-v6-225BA5?logo=ethereum&logoColor=white)](https://docs.ethers.org/v6/)
[![Node.js](https://img.shields.io/badge/Node.js-24.x-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

**An educational blockchain prototype for issuing, verifying, reselling, and cancelling airline tickets as restricted NFTs — transparent, auditable, and role-gated.**

Registry • Flight Inventory • NFT Tickets • Settlement • Resale Marketplace

---

## Table of Contents

- [About the Project](#about-the-project)
- [Why I Built This](#why-i-built-this)
- [Who Will Use It](#who-will-use-it)
- [Why They Will Use It](#why-they-will-use-it)
- [Key Features](#key-features)
- [Tech Stack](#tech-stack)
- [Architecture Overview](#architecture-overview)
- [Getting Started](#getting-started)
- [Quality Gates](#quality-gates)
- [Project Structure](#project-structure)
- [Documentation](#documentation)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)
- [Author & Contact](#author--contact)

---

## About the Project

**Airlines Ticketing System** is a blockchain prototype that models the full lifecycle of an airline ticket as a restricted ERC-721 NFT: **purchase → verify → resale → cancellation → boarding**, with role-gated administration and on-chain accounting.

Conventional ticketing keeps the authoritative record inside a centralized airline database. Passengers cannot independently verify ticket state, resale happens through opaque channels, and cancellations/refunds are hard to audit. This project moves the ticket lifecycle onto a local EVM chain so that every state change is an explicit, verifiable transaction:

> A platform administrator approves airline operator wallets; an airline publishes flights with seat inventory and refund policy; a traveler pays in test ETH and atomically receives one seat-reserved ticket NFT bound to an IPFS metadata CID; the ticket can be verified publicly, resold once through an approved marketplace with a capped airline royalty, or cancelled for a policy-based refund.

The project is the working prototype behind the IEEE-style paper *A Practical Blockchain Framework for Secure and Transparent Airline Ticketing*.

Scope: educational, local Hardhat network (chainId 31337), test ETH, fictional data. No real airline or payment integration.

---

## Why I Built This

1. **Centralized trust problem:** A ticket exists only because the airline's database says so. There is no independent way for a passenger, a reseller, or a verifier to confirm authenticity without asking the operator. Putting the ticket state on-chain makes it publicly verifiable.
2. **Opaque resale and fraud risk:** Second-hand ticket sales rely on informal channels where duplicates and counterfeit tickets are common. A single active-listing rule with atomic payment + transfer removes the double-sell window.
3. **Unclear cancellations and refunds:** Refund rules are applied by the platform that also holds the money. Encoding `refundBps` policy on-chain and emitting an explicit `TicketRefunded(tokenId, refund, retained)` event makes the split auditable by anyone.
4. **Royalty leakage on resale:** When tickets resell, the airline sees none of it. ERC-2981-aligned royalty accounting — enforced by the marketplace, not by convention — guarantees the split in the same transaction.
5. **Academic requirement:** This is the implementation companion for an IEEE-format paper on decentralized airline ticketing, so the prototype must demonstrate real contracts, real tests, and real measurements rather than diagrams alone.

This is also my exploration of production-grade Solidity patterns: OpenZeppelin `AccessControl`, `Pausable`, `ReentrancyGuard`, `ERC721`, `ERC2981`, checks-effects-interactions, pull payments, and static-analysis-driven hardening.

---

## Who Will Use It

- **Researchers and students** evaluating blockchain ticketing — the code, tests, and paper ship together as a reproducible reference.
- **Airline operators (simulated)** — approve flights, manage inventory, mark tickets used at boarding, and collect royalty/revenue via pull-based withdrawals.
- **Travelers** — purchase a seat, hold the ticket in their own wallet, verify it publicly, resell it through the approved marketplace, or cancel for a policy refund.
- **Platform administrators** — govern airline approvals, limits, and emergency pause without ever touching user ownership or balances.
- **Public verifiers** — anyone can check a ticket's lifecycle state on-chain with no PII exposure.

---

## Why They Will Use It

- **Verifiability without asking anyone:** Ticket state, flight schedule, refund policy, and every lifecycle transition are readable straight from the chain.
- **Atomicity:** Purchase debits payment, reserves the exact seat, mints exactly one NFT, and records the metadata CID in one transaction — a failed payment mints nothing.
- **Safety rails locked in code:** `maxRoyaltyBps = 1000` (10%), resale price capped at 120% of the original fare, listings expiring no later than the 2-hour check-in window, seat IDs `S-<n>`.
- **One terminal cancellation state:** `Cancelled` is terminal; the refund/retained split is emitted as an event (transaction hash comes from the wallet receipt, never fabricated by the contract).
- **Least-privilege roles:** The same wallet cannot approve airlines, create flights, and mint tickets. `markUsed` has exactly one writer: `AirTicketNFT`, gated by `AIRLINE_ROLE` on its own flight.
- **Emergency controls that don't rug users:** Pause blocks creation, publishing, booking, listing, resale, and transfers — while cancellation, `markUsed`, `markDeparted`, and reads remain available so active tickets can always be resolved.
- **Security-first engineering:** Secret scanning on every commit gate, Solhint on every contract, custom-error reverts, pull-payment withdrawals, `ReentrancyGuard` on all ETH movement.

---

## Key Features

### 1. Airline Registry (`AirlineRegistry.sol`) — Phase 1

- Platform admin approves, deactivates, and reactivates airline operator wallets
- Configurable limits with bounds enforcement (`maxRoyaltyBps <= 1000`, seat/flight caps)
- Single pause source of truth: every other contract gates via `whenPlatformLive`
- Full event trail for administrative actions (FR-34 audit feed)

### 2. Flight Inventory (`FlightInventory.sol`) — Phase 1

- Flight creation with struct params: route, departure, capacity, fare, refund policy, royalty bps
- Lifecycle: `Draft → Published → Departed`, plus per-flight pause and cancel
- Seat-level reserve/release primitives (purchase path completes them in Phase 2)
- FR-08 validation on create: departure in the future, sane capacity, royalty within cap

### 3. Ticket NFT (`AirTicketNFT.sol`) — Phases 1–4

- Restricted ERC-721: transfers blocked while platform is paused, only the settlement/marketplace pathway may move a ticket
- Lifecycle states: `Issued → Listed → (Issued | Cancelled | Used | Invalid)`; `markListed`/`markUnlisted` are `MARKETPLACE_ROLE` only
- ERC-2981 `royaltyInfo` view, display-only and mirroring the marketplace's stored basis points
- `markUsed` sole writer is this contract: `AIRLINE_ROLE`, own flight, only from `departureTime - 2h`

### 4. Settlement & Marketplace (`TicketSettlement.sol`, `TicketMarketplace.sol`) — Phases 1–4 complete

- `purchase` / `calculateRefund` / `previewSeatReference` (Phase 2–3): exact payment, per-flight seat pool, refund-reserve escrow (D-20)
- `withdrawAirlineBalance` per airline — never cross-airline, always `nonReentrant`
- Marketplace settlement math is authoritative for all seller/royalty splits: `list(tokenId, priceWei, expiresAt)` → `buyListing` pays the airline royalty straight to its wallet and the remainder to the seller in one atomic tx (`royalty + proceeds == price`), with a 120%-of-fare price cap and an expiry no later than departure − 2h (Phase 4)

### 5. Deployment & Verification

- `npm run deploy` writes `frontend/assets/js/contracts-config.js` (chainId + 5 addresses, git-ignored)
- `npm run seed` approves one airline and publishes the sample flight `R1-DEMO-001`
- 88 unit tests cover role gates, validation rejections, the pause matrix, purchase, cancellation, and the full resale split

### Remaining (Phases 5–6)

- Admin console with approvals, limits, pause, and filtered audit feed
- Quality gates: coverage, static-analysis hardening, deterministic demo script

---

## Tech Stack

**Contracts:**

- Solidity 0.8.28 (EVM target: cancun), OpenZeppelin Contracts 5.6 (`AccessControl`, `Pausable`, `ReentrancyGuard`, `ERC721`, `ERC2981`, `Ownable`)

**Tooling:**

- Hardhat 3.18 (ESM), `@nomicfoundation/hardhat-ethers` 4.2, Ethers v6, Mocha + Chai 6 test runners
- Solhint 6 (`solhint:recommended`) for static linting, custom secret scanner for credential leaks

**Frontend & backend:**

- Vanilla HTML/CSS/JavaScript with Ethers wallet connection (no framework, no build step)
- Node.js protected upload endpoint (`server/`) — IPFS credentials live only in `server/.env`

**Network:**

- Local Hardhat node, chainId 31337, test ETH only

---

## Architecture Overview

Five contracts with strict, single-purpose responsibility:

```
AirlineRegistry          ← platform admin: airline approval, limits, global pause
       │ (whenPlatformLive / authorization)
FlightInventory          ← flights, capacity, fares, refund policy, seat inventory
       │                          │
       │                    AirTicketNFT  ← restricted ERC-721, lifecycle state,
       │                          │        markUsed (sole writer), ERC-2981 view
       ▼                          │
TicketSettlement   ◄──────────────┘        ← purchase, cancellation, refund,
       │                                      per-airline revenue accounting (pull)
       ▼
TicketMarketplace                             ← one active listing per ticket,
                                                atomic seller/royalty split
```

Design rules locked for R1 (see `doc/DECISIONS.md`):

- **Checks-effects-interactions + `ReentrancyGuard`** on every ETH path; withdrawals are pull-based per airline.
- **`Cancelled` is the single terminal state** for cancellation — no `Cancelled → Refunded` transition; `TicketRefunded(tokenId, refund, retained)` carries the numbers, the wallet receipt carries the tx hash.
- **Pause matrix:** blocks creation/publishing/booking/listing/resale/transfers; keeps `cancel`, `markUsed`, `markDeparted`, and all reads live.
- **Marketplace settlement math is authoritative**; `royaltyInfo` is display-only and must match.
- **Metadata:** CID is produced by a protected server-side upload first, then passed into `purchase` atomically. Credentials never touch browser code.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 24.x and npm 11+
- Git

### Run Locally

1. Clone the repo:

   ```bash
   git clone https://github.com/InfinityAbir/Airlines-Ticketing-System.git
   cd Airlines-Ticketing-System
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Compile the contracts:

   ```bash
   npm run compile
   ```

4. Run the full test suite (boots its own local chain, runs Mocha, tears down):

   ```bash
   npm test
   ```

### Local Demo (Phases 1–4)

Terminal 1 — start the local chain:

```bash
npm run node
```

Terminal 2 — deploy, then seed:

```bash
npm run deploy -- --network localhost
npm run seed -- --network localhost
```

This approves the airline operator wallet, creates and publishes the five-seat sample flight `R1-DEMO-001` (flightId 1), and writes the contract addresses to `frontend/assets/js/contracts-config.js` (git-ignored, generated per environment).

Terminal 3 — serve the frontend and the protected upload endpoint:

```bash
npx serve frontend          # or any static file server on frontend/
node server/upload.js       # protected IPFS endpoint (mock CID fallback when unconfigured)
```

Open `http://localhost:3000` (or your server's port), connect a wallet on chain 31337, and the full path works end to end: browse → book → My Tickets → list for resale → marketplace → buy → airline royalty metrics.

---

## Quality Gates

Every phase must pass all four before it is marked complete in `doc/STATUS.md`:

| Gate | Command | Latest result |
|---|---|---|
| Compile | `npm run compile` | 5 files, solc 0.8.28, cancun |
| Tests | `npm test` | 88/88 passing |
| Lint | `npm run lint` | 0 errors (306 warnings = baseline) |
| Secret scan | `npm run scan` | clean |

> Never commit API keys, provider tokens, private keys, or seed phrases. IPFS provider credentials live only in `server/.env` (git-ignored) — never in frontend code.

---

## Project Structure

```
Airlines-Ticketing-System/
├── contracts/
│   ├── AirlineRegistry.sol        # platform admin: approvals, limits, pause
│   ├── FlightInventory.sol        # flights, capacity, seats, policy
│   ├── AirTicketNFT.sol           # restricted ERC-721 ticket + lifecycle
│   ├── TicketSettlement.sol       # purchase/cancel/refund accounting
│   └── TicketMarketplace.sol      # resale + royalty split
├── test/
│   ├── _helpers.js                # chai 6 / ethers v6 test utilities
│   ├── airlineRegistry.test.js
│   ├── flightInventory.test.js
│   ├── airTicketNFT.test.js
│   ├── ticketSettlement.test.js
│   └── ticketMarketplace.test.js
├── scripts/
│   ├── deploy.js                  # deploys 5 contracts, writes config
│   ├── seed.js                    # approves airline, publishes sample flight
│   ├── run-tests.js               # npm test orchestrator (node + mocha)
│   └── scan-secrets.js            # credential leak scanner
├── frontend/                     # index, flights, checkout, tickets, marketplace, airline, verify
│   └── assets/{js,css,vendor}/    # shared wallet/UI layer, ABIs, vendored ethers + QR
├── server/.env.example            # protected IPFS upload endpoint (Phase 2)
├── doc/                           # PRD, architecture, design, status, decisions
│   └── screenshots/{phase2..4}/   # per-phase browser verification captures
├── Paper/                         # IEEE paper (LaTeX)
├── hardhat.config.js
├── .solhint.json
└── README.md
```

---

## Documentation

- `doc/AIRLINE_TICKETING_PROTOTYPE_PRD.md` — canonical PRD (Milestones §14)
- `doc/ARCHITECTURE.md` — system structure and contract responsibilities
- `doc/DESIGN.md` — UI/UX and behavior specification
- `doc/STATUS.md` — phase-by-phase implementation progress (source of truth)
- `doc/DECISIONS.md` — locked technical decisions (R1 defaults)
- `doc/CONVENTIONS.md` — coding and testing conventions
- `doc/FEEDBACK.md` — review notes

---

## Roadmap

- [x] **Phase 0** — Repo scaffolding: Hardhat 3, lint, test runner, secret scan
- [x] **Phase 1** — Foundation contracts, roles, deploy + seed, 23 unit tests
- [x] **Phase 2** — Booking flow, protected IPFS upload, airline creation UI, ticket wallet
- [x] **Phase 3** — Cancellation + refunds, use/boarding, public verification page
- [x] **Phase 4** — Marketplace list/buy and royalty distribution
- [ ] **Phase 5** — Admin console, audit feed, emergency controls UI
- [ ] **Phase 6** — Quality gates, static analysis hardening, demo readiness
- [ ] **Paper** — testing/evaluation section from verified prototype measurements

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes and keep the gates green: `npm run compile && npm test && npm run lint && npm run scan`
4. Commit: `git commit -m "Add your feature"`
5. Push and open a Pull Request

Please follow `doc/CONVENTIONS.md` (custom errors `Name__detail`, NatSpec on external functions, no secrets anywhere in tracked code).

---

## Security

- Secret scanning (`npm run scan`) runs over the whole tree and skips only its own pattern source
- No API keys, seed phrases, or private keys in tracked files — `.env` and generated configs are git-ignored
- Smart-contract posture: role-gated writes, checks-effects-interactions, `ReentrancyGuard`, pull payments, strict pause matrix
- Static-analysis cleanup (Slither high-severity findings) is scheduled in Phase 6

---

## License

This project is currently **All Rights Reserved** — source available for learning and review.

If you want to reuse code or contribute a licensed fork, please contact the author. A formal open-source license (e.g., MIT) can be added on request.

---

## Author & Contact

**Abir Hasan (InfinityAbir)** — ASP.NET Core / Android / Solidity developer, building clean, secure, real-world apps.

- GitHub: [https://github.com/InfinityAbir](https://github.com/InfinityAbir)
- Portfolio: [https://infinityabir.github.io/abir-hasan-portfolio/](https://infinityabir.github.io/abir-hasan-portfolio/)
- LinkedIn: [https://www.linkedin.com/in/infinityabirhasan/](https://www.linkedin.com/in/infinityabirhasan/)
- Email: [abirha3896@gmail.com](mailto:abirha3896@gmail.com)

> If this project helps your research or build, please ⭐ star the repo and share feedback via Issues.
