# Product Requirements Document

## Airline Ticketing Prototype

**Status:** Ready for implementation  
**Product type:** Educational blockchain prototype  
**Primary reference:** Blockchain Pension System prototype  
**Audience:** Project team, supervisor, demonstrators, and evaluators

## 1. Purpose

Build a web-based airline-ticketing prototype that demonstrates how blockchain can make ticket ownership, purchase, cancellation, refund, and approved resale easier to audit. The prototype will turn the paper's proposed architecture into a usable demonstration. It is not a production booking system and must not be presented as one.

The product should feel structurally similar to the pension prototype: a wallet-first web application, role-based pages, a clear status-driven journey, smart contracts split by responsibility, transaction feedback, IPFS-backed records, and an administrator or operator workspace.

## 2. Problem Statement

Conventional booking flows are often spread across payment providers, reservation systems, and airline support processes. A traveler may pay successfully but have no confirmed ticket, may not see a trustworthy record of ticket ownership, or may experience an unclear cancellation and refund process. Resale can be opaque and may not return value to the airline.

The prototype will demonstrate a shared, tamper-evident record of the core ticket lifecycle. It will represent a valid ticket as an NFT, keep detailed ticket metadata off-chain, and use smart contracts to enforce the prototype's booking, cancellation, refund, and approved resale rules.

## 3. Goals

1. Demonstrate end-to-end booking of a flight seat using a connected test wallet.
2. Mint a unique NFT ticket after a successful payment and associate it with an IPFS metadata CID.
3. Give travelers a clear ticket wallet and transaction history.
4. Allow authorized airline operators to create flights, manage inventory, and view ticket activity.
5. Support cancellation with a visible policy calculation and an on-chain refund event.
6. Support controlled secondary resale with an airline royalty shown in the transaction result.
7. Provide a public ticket-verification page that validates ticket status without exposing passenger data.
8. Be demonstrable on a local Hardhat network using test ETH and sample flight data.

## 4. Non-Goals

- Real payment processing, real money, or live airline inventory.
- Integration with a global distribution system, airport operations, passport databases, or an airline's production reservation system.
- On-chain storage of passenger names, passport numbers, contact details, or raw identity documents.
- A production-grade DID provider or a fully implemented ZKP circuit. The prototype may use a clearly labelled credential-verification stub.
- Open, unrestricted NFT transfers. The ticket must remain transferable only through the approved marketplace flow.
- Legal or regulatory approval for ticket resale.

## 5. Prototype Audit: Pension System Lessons

### 5.1 What to reuse

| Pension prototype pattern | Airline prototype adaptation |
|---|---|
| Vanilla HTML/CSS/JavaScript frontend with Ethers wallet connection | Use the same lightweight stack for a fast, inspectable demonstration. |
| Role-aware routing and protected pages | Route wallet holders to traveler, airline operator, or platform administrator spaces. |
| Separate Registry, Documents, Fund, and Disbursement contracts | Split airline concerns into registry, inventory, ticket NFT, and settlement/marketplace contracts. |
| Pending/approved/rejected application states | Use explicit ticket states such as Issued, Listed, Cancelled, Refunded, and Used. |
| IPFS CID recording for submitted files | Store only encrypted or non-sensitive ticket metadata by CID. |
| Admin review tables, status badges, toasts, and transaction history | Use the same interaction language for flight management, ticket verification, and wallet actions. |
| Local Hardhat configuration and deployed-address configuration | Keep a local demonstration mode with deployment addresses loaded from a generated file. |

### 5.2 Findings that must not be copied

| Priority | Finding | Required airline response |
|---|---|---|
| Critical | The pension frontend contains live-looking Pinata credentials in a client-side configuration file. Anyone loading the app can read them. | Do not put API keys, secrets, private keys, or upload tokens in browser code or version control. Use a server-side upload proxy, an expiring upload URL, or a mock/local CID workflow for the demo. Rotate the exposed pension credentials immediately. |
| High | The pension security report flags an arbitrary ETH send in its unallocated-fund withdrawal path. | The airline settlement contract must use explicit role checks, per-airline accounting, checks-effects-interactions, reentrancy protection, and tests for every payout path. |
| Medium | The report flags a potential reentrancy issue in a nominee withdrawal flow and an uninitialized local amount in pension startup logic. | Use OpenZeppelin `ReentrancyGuard`; zero or update state before external transfers; initialize all local variables; add unit tests for refund and royalty values. |
| High | Contract addresses are fixed to a local network in browser configuration. | Generate environment-specific contract configuration at deployment. The UI must show the connected network and refuse writes on an unsupported chain. |
| Medium | No automated test files were found in the indexed JavaScript project. | Airline smart contracts require a tested happy path and failure path for every public state-changing function before demonstration. |
| Medium | A single administrator is responsible for sensitive actions. | Separate platform administrator and airline-operator roles. For a future production design, use multisig control and a pause process. |

## 6. Users and Roles

### Traveler

- Connects a test wallet.
- Browses sample flights.
- Buys a seat and receives a ticket NFT.
- Opens the ticket wallet, checks ticket status, lists an eligible ticket for resale, or cancels it.
- Sees refund, royalty, and transaction details in plain language.

### Airline Operator

- Is approved by the platform administrator for the prototype.
- Creates and publishes flights with route, schedule, fare, seat capacity, refund policy, and resale royalty percentage.
- Reviews bookings and ticket events for that airline.
- Marks a flight as departed and can mark a ticket as checked in/used in the prototype.

### Platform Administrator

- Approves or disables airline operator wallets.
- Configures prototype-wide limits, such as the maximum resale royalty and allowed refund-policy bounds.
- Pauses the platform in an emergency.
- Views the audit event feed but cannot alter ticket ownership or traveler data.

### Public Verifier

- Enters a ticket ID or scans a prototype QR code.
- Sees only non-sensitive information: validity, airline, route code, departure time, seat status, and a shortened owner address.

## 7. User Journeys

### 7.1 Traveler booking

1. The traveler opens the landing page and connects a wallet on the supported test network.
2. The traveler searches the sample flight catalogue by origin, destination, and date.
3. The traveler selects a flight and available seat, reviews the fare and cancellation policy, and accepts the prototype disclosure.
4. The traveler confirms a wallet transaction.
5. The settlement contract accepts the payment, inventory decreases by one, ticket metadata is uploaded or generated, and the ticket NFT is minted.
6. The confirmation page shows the ticket ID, transaction hash, CID status, price, and next actions.

### 7.2 Airline flight management

1. An approved airline operator connects a wallet.
2. The operator creates a flight with unique flight code, route, departure timestamp, capacity, price, refundable-until timestamp, refund basis points, and resale royalty basis points.
3. The operator publishes the flight.
4. The operator dashboard displays seats sold, seats remaining, ticket activity, and collected test ETH.
5. The operator can mark the flight departed; the UI then blocks cancellation and resale.

### 7.3 Cancellation and refund

1. The traveler opens an issued ticket from the ticket wallet.
2. The UI shows whether cancellation is allowed and calculates the expected refund before the wallet request.
3. The traveler confirms cancellation.
4. The contract verifies ownership, current ticket state, refund deadline, and flight status; it burns or permanently invalidates the NFT and transfers the refund.
5. The result screen displays the refund, retained amount, transaction hash, and final ticket state.

### 7.4 Approved resale

1. The ticket owner lists an eligible, unused ticket in the marketplace at or below a configurable price cap.
2. Another traveler buys the listing through the marketplace contract.
3. The contract transfers ownership, pays the seller, routes the airline royalty, updates the ticket state, and records the event.
4. The ticket wallet and public verifier display the new owner state without revealing personal data.

## 8. Functional Requirements

### 8.1 Wallet, network, and roles

- **FR-01:** The app shall connect through MetaMask or another injected EVM wallet.
- **FR-02:** The app shall display wallet address, active network, and role after connection.
- **FR-03:** The app shall support only a configured local Hardhat chain for the first release and block write actions on all other chains.
- **FR-04:** The app shall route each wallet to the appropriate role dashboard while still allowing public flight browsing.
- **FR-05:** Every write action shall show pending, confirmed, and failed states, with a transaction hash link when available.

### 8.2 Airline and flight management

- **FR-06:** An administrator shall be able to approve, deactivate, and reactivate airline operator wallets.
- **FR-07:** An approved operator shall create a flight with a unique flight code, route, departure time, total seats, base fare, refund deadline, refund rate, and resale royalty rate.
- **FR-08:** The system shall reject invalid data, including past departure times, zero capacity, duplicate active flight codes, refund rates above 100%, and royalties above the configured cap.
- **FR-09:** An operator shall publish, pause sales for, cancel, or mark its own flight as departed.
- **FR-10:** The operator dashboard shall show flight inventory, sales, cancellations, and resale-royalty events.

### 8.3 Ticket purchase and record

- **FR-11:** A traveler shall browse and filter published flights.
- **FR-12:** A traveler shall purchase exactly one available seat per transaction in release 1.
- **FR-13:** A successful purchase shall decrease available inventory, mint exactly one ticket NFT, and create an immutable booking event.
- **FR-14:** Each ticket shall contain a ticket ID, flight ID, seat reference, issue time, state, owner wallet, and metadata CID reference.
- **FR-15:** Passenger-identifying fields shall never be written in plaintext to smart-contract storage, NFT metadata, browser local storage, or public logs.
- **FR-16:** The traveler dashboard shall display tickets owned by the connected wallet and their lifecycle status.

### 8.4 Metadata and identity proof

- **FR-17:** Ticket metadata shall be stored off-chain and referenced by CID. For the first release, it may contain only non-sensitive sample data or encrypted data.
- **FR-18:** The app shall verify that retrieved metadata matches the recorded CID before presenting it as valid.
- **FR-19:** The UI shall include a clearly labelled simulated DID/credential check before booking. It must not claim to be a real identity verification service.
- **FR-20:** Upload credentials shall be held only by a server-side component or replaced by a local mock implementation; no secret shall be bundled into frontend assets.

### 8.5 Cancellation, refund, and use

- **FR-21:** A traveler may cancel only an issued ticket they own, before its refundable-until time and before flight departure.
- **FR-22:** The contract shall calculate the refund from the flight's stored basis-point policy and show the same calculation in the UI before confirmation.
- **FR-23:** A cancellation shall atomically update the ticket to Cancelled, prevent reuse and resale, and transfer the refund. Inventory shall be returned only if the airline policy allows it; release 1 will return the seat to inventory.
- **FR-24:** An airline operator shall be able to mark an issued ticket as Used only after the flight departs or within a configured check-in window.
- **FR-25:** The system shall reject cancellation, resale, or ownership transfer for Used, Cancelled, Refunded, or Invalid tickets.

### 8.6 Marketplace and royalties

- **FR-26:** Standard direct NFT transfers shall be disabled or restricted; ownership changes must pass through the ticket contract or marketplace contract.
- **FR-27:** An owner shall be able to list one eligible ticket at a time through the marketplace.
- **FR-28:** The marketplace shall reject listings after the refund deadline, after departure, or above the configured price cap.
- **FR-29:** A completed resale shall pay the seller and airline royalty in one atomic transaction, then transfer the ticket to the buyer.
- **FR-30:** The UI shall show resale price, airline royalty, seller proceeds, and the resulting ticket-owner address before confirmation.

### 8.7 Verification and audit

- **FR-31:** A public verification page shall confirm whether a ticket ID is valid, active, cancelled, used, or invalid.
- **FR-32:** The page shall not show passenger name, passport data, unmasked credentials, or unencrypted IPFS content.
- **FR-33:** All contract state changes shall emit events that support dashboard history and demonstration audit trails.
- **FR-34:** The administrator dashboard shall include filters for flight, airline, ticket state, and event type.

## 9. Smart-Contract Design

| Contract | Responsibility | Key operations |
|---|---|---|
| `AirlineRegistry` | Platform administration and airline authorization. | approve/deactivate airline, configure limits, pause/unpause. |
| `FlightInventory` | Airline-owned flight records and seat availability. | create/publish/pause flight, reserve/release seat, mark departed. |
| `AirTicketNFT` | Restricted ERC-721 representation of a ticket. | mint, invalidate/burn, allow marketplace-controlled transfer, retrieve ticket state. |
| `TicketSettlement` | Purchase, cancellation, refund, and airline revenue accounting. | purchase, cancel, calculate refund, withdraw accrued airline balance. |
| `TicketMarketplace` | Approved resale and royalty distribution. | list, cancel listing, buy listing, distribute seller and airline proceeds. |

Use OpenZeppelin `AccessControl`, `Pausable`, `ReentrancyGuard`, `ERC721`, and `ERC2981` where appropriate. Roles must include `DEFAULT_ADMIN_ROLE`, `AIRLINE_ROLE`, and `MARKETPLACE_ROLE`. Each external payment operation must follow checks-effects-interactions and must be protected with `nonReentrant`.

## 10. Data Model

### Flight

`flightId`, `airline`, `flightCode`, `origin`, `destination`, `departureTime`, `seatCapacity`, `seatsAvailable`, `priceWei`, `refundDeadline`, `refundBps`, `royaltyBps`, `salesOpen`, `departed`, `cancelled`.

### Ticket

`tokenId`, `flightId`, `seatReference`, `owner`, `metadataCID`, `issuedAt`, `state`, `lastTransferAt`.

### Listing

`listingId`, `tokenId`, `seller`, `priceWei`, `active`, `createdAt`, `expiresAt`.

### Ticket states

`Issued`, `Listed`, `Cancelled`, `Refunded`, `Used`, `Invalid`.

## 11. Pages and Navigation

| Page | Main content | Users |
|---|---|---|
| `index.html` | Product explanation, prototype disclosure, network status, connect wallet. | Everyone |
| `flights.html` | Search/filter sample flights; flight cards; booking entry point. | Everyone/Traveler |
| `checkout.html` | Selected flight, seat, policy, credential stub, payment confirmation. | Traveler |
| `tickets.html` | Owned ticket cards, QR/verification link, cancel and resale actions. | Traveler |
| `marketplace.html` | Eligible active listings and purchase flow. | Everyone/Traveler |
| `airline.html` | Flight creation form, inventory table, sales and event history. | Airline Operator |
| `admin.html` | Airline approvals, platform configuration, pause control, event filters. | Platform Administrator |
| `verify.html` | Ticket-ID or QR lookup with non-sensitive validity result. | Everyone |

The interface should reuse the pension prototype's strengths: clear navbar, summary cards, readable status badges, tables with empty states, toast notifications, explicit wallet actions, and transaction-history sections.

## 12. Non-Functional Requirements

- **Security:** No browser secrets. No plaintext PII on-chain. Contract writes require role checks and reentrancy protection. Inputs must be validated both in UI and contracts.
- **Reliability:** A transaction failure must leave the user with a clear explanation and no false success state. Contract operations must be atomic.
- **Performance:** On local Hardhat, common read screens should render within two seconds after wallet connection. A single booking should complete within one normal local transaction confirmation.
- **Accessibility:** Keyboard-operable controls, visible focus state, semantic labels, sufficient colour contrast, and text equivalents for status badges.
- **Explainability:** Every blockchain feature must use human wording in the UI. The app should explain that test ETH, sample flights, and simulated credential checks are used.
- **Privacy:** The public verifier exposes only minimal ticket state. CIDs must never point to unencrypted real traveler documents.

## 13. Security and Privacy Acceptance Checklist

- [ ] A secret scan finds no API key, Pinata secret, private key, seed phrase, or production credential in tracked frontend files.
- [ ] Airline revenue withdrawal is restricted to the intended airline and cannot withdraw another airline's balance.
- [ ] Refund and resale functions use `nonReentrant` and update state before transfers.
- [ ] A failed payment does not mint a ticket or decrement inventory.
- [ ] A cancelled, used, departed, or invalid ticket cannot be listed or resold.
- [ ] A ticket cannot be transferred directly outside the approved contract pathway.
- [ ] Unit tests cover all role checks, status transitions, exact payment values, deadline boundaries, and payout calculations.
- [ ] Static analysis results are reviewed and any high-severity issue is fixed before demonstration.

## 14. Delivery Plan

### Milestone 1: Foundation

Create the Hardhat project, contract skeletons, roles, local deployment module, generated deployment configuration, and sample airline/flight seed data.

**Exit criteria:** Admin can approve an airline and the airline can create and publish a flight on a local chain.

### Milestone 2: Booking and Ticket Wallet

Implement flight browsing, checkout, inventory reservation, payment, NFT minting, mock metadata CID generation, and traveler ticket wallet.

**Exit criteria:** A traveler can buy a sample seat and see exactly one issued NFT ticket.

### Milestone 3: Cancellation and Verification

Implement cancellation/refund rules, ticket-state controls, event history, and the public verification page.

**Exit criteria:** A valid ticket can be verified, cancelled before its deadline, refunded correctly, and rejected after cancellation.

### Milestone 4: Marketplace and Royalty

Implement controlled listings, purchase, royalty distribution, operator sales metrics, and user-facing receipt details.

**Exit criteria:** An eligible ticket can be resold once; seller proceeds and airline royalty are correct and verifiable from events.

### Milestone 5: Quality and Demonstration

Add unit tests, static analysis, responsive UI polish, a scripted demo dataset, error states, README instructions, and a short evaluator demo script.

**Exit criteria:** The complete demonstration can be run from a fresh local setup using documented steps and passes the security checklist.

## 15. Demo Scenario

1. The administrator approves a sample airline wallet.
2. The airline creates and publishes a flight with five seats.
3. A traveler connects a second wallet, selects the flight, passes the labelled credential stub, and buys a seat with test ETH.
4. The traveler opens the issued NFT ticket and verifies it on the public page.
5. The traveler lists the ticket. A third wallet buys it; the UI shows seller proceeds and airline royalty.
6. A second ticket is purchased and cancelled before the deadline; the UI shows the calculated refund and invalid status.
7. The operator marks the flight departed; the UI demonstrates that new cancellation and resale attempts are blocked.

## 16. Risks and Decisions

| Risk | Decision for the prototype |
|---|---|
| Public-chain metadata can reveal personal information. | Use fictional data only; use non-sensitive or encrypted metadata; never upload real travel documents. |
| Test ETH transactions do not match real-world card payment behaviour. | State clearly that on-chain payment is a prototype settlement model, not a real payment-gateway integration. |
| NFT resale may conflict with airline policy or regulation. | Restrict resale to the marketplace contract and present it as a configurable demonstration feature. |
| DID and ZKP implementation is too large for the project timeline. | Provide a transparent simulated credential check, define its replacement boundary, and do not claim full decentralized identity coverage. |
| Smart-contract errors can lock or misroute funds. | Use local test ETH only, implement no real-value deployment, test every payout path, and review static-analysis warnings. |

## 17. Success Metrics

- 100% of the scripted demo flows complete on the local network.
- 100% of public state-changing contract functions have passing success and failure-path tests.
- Zero secrets are present in tracked client-side code.
- Zero unresolved high-severity static-analysis findings.
- A verifier can identify each demo ticket's state without access to traveler personal data.
- A resale event correctly accounts for 100% of the payment as seller proceeds plus airline royalty, with no rounding loss beyond the documented integer-division rule.

## 18. Open Decisions to Confirm Before Implementation

These defaults keep the build moving, but should be confirmed before development begins:

1. **Frontend:** retain the pension prototype's vanilla HTML/CSS/JavaScript approach, or move to a framework such as React.
2. **Metadata:** use a mock CID generator for the demo, or add a small server-side upload service with protected credentials.
3. **Refund policy:** use one fixed demonstration rate per flight (recommended), or implement a time-tiered refund schedule.
4. **Identity:** use a simulated credential badge only (recommended for the prototype), or include a lightweight verifiable-credential demo.
5. **Resale:** retain the recommended price cap and operator-enabled resale rule, or make resale unavailable for selected flights.
