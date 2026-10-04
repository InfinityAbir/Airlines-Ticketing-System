# STATIC_ANALYSIS.md — Slither findings and disposition (Phase 6)

> Companion to PRD §13 ("static analysis results are reviewed and any high-severity issue is
> fixed before demonstration") and CONVENTIONS §6. Referenced from the annotated finding in
> `contracts/TicketMarketplace.sol`.

## How to reproduce

```powershell
# one-time: python -m pip install slither-analyzer
$sl  = "$env:APPDATA\Python\Python314\Scripts\slither.exe"
$solc = "$env:LOCALAPPDATA\hardhat-nodejs\Cache\compilers-v2\windows-amd64\solc-windows-amd64-v0.8.28+commit.7893614a.exe"
Remove-Item artifacts\slither-report.json -ErrorAction SilentlyContinue
& $sl contracts --solc $solc `
  --solc-remaps "@openzeppelin/=node_modules/@openzeppelin/" `
  --exclude-dependencies --filter-paths "node_modules" `
  --json artifacts\slither-report.json
```

- Tool: `slither-analyzer` **0.11.5**, compiler `solc 0.8.28` (Hardhat-managed binary),
  OpenZeppelin 5.6.1 resolved through the `--solc-remaps` above.
- Slither exits with `-1` when it reports findings — that is its normal "findings present"
  exit code, not a crash. The machine-readable result is `artifacts/slither-report.json`
  (inside the git-ignored `artifacts/` directory; regenerate it for review, never commit it).
- Re-run after any contract change; the table below must be refreshed with it.

## Result (2026-10-04)

**19 findings — 0 High, 0 Medium, 12 Low, 7 Informational.** No unresolved high-severity
finding remains, which is the PRD §13/§17 gate.

| # | Detector | Impact | Location | Disposition |
|---|---|---|---|---|
| 1 | `timestamp` | Low | `AirTicketNFT.sol:156,164` | Accepted — `markUsed` opens a 2-hour check-in window; ±15 s block drift cannot change eligibility. |
| 2 | `timestamp` | Low | `FlightInventory.sol:132,138` | Accepted — departure/refund validation at day granularity. |
| 3 | `timestamp` | Low | `TicketSettlement.sol:225,234` | Accepted — cancellation deadline check; unit tests hit the boundary at ±1 s. |
| 4 | `timestamp` | Low | `TicketSettlement.sol:285,294` | Accepted — `calculateRefund` preview uses the same clock as `cancel`. |
| 5-9 | `timestamp` | Low | `TicketMarketplace.sol:283,285,318,339,343,349,358,373,381,384,390,394` | Accepted — listing expiry/`check-in` bound (2 h window) and departure guard; same ±15 s tolerance. |
| 10-12 | `reentrancy-benign` | Low | `TicketSettlement.sol:180,196-198,204-208,225,246-248,335` | Accepted — reads of inventory/NFT state around external calls, inside `nonReentrant` functions ordered checks-effects-interactions; double-action failure-path tests cover the re-entrancy attempt. |
| 13-15 | `low-level-calls` | Informational | `TicketSettlement.sol:251,272`; `TicketMarketplace.sol:318,322` | Accepted by design — explicit `.call{value:}` with success check (`TransferFailed__receiver`) for the pull-payment refund, the per-airline withdrawal, and the atomic royalty/proceeds split. |
| 16-17 | `naming-convention` | Informational | `AirlineRegistry.sol:67` (`_maxRoyaltyBps`, `_maxRefundBps`) | Accepted — Solidity parameter convention for `setLimits(uint16,uint16)`; renaming public API after the UI and tests are locked would churn every caller for no safety gain. |
| 18-19 | `unindexed-event-address` | Informational | `AirTicketNFT.sol:76` (`SettlementUpdated`), `FlightInventory.sol:70` (`AuthorizedPartiesUpdated`) | Accepted — these are wiring/admin events read by direct `parseLog` decoding in the admin audit feed; changing indexed-ness rewrites the event ABI after the feed is built and tested. |
| — | `arbitrary-send-eth` | (suppressed) | `TicketMarketplace.sol:317` | Reviewed and annotated in source with `// slither-disable-next-line arbitrary-send-eth` — see below. |

### The suppressed `arbitrary-send-eth` finding

`buyListing` forwards the airline royalty with `f.airline.call{value: royalty}()`. Slither
flags any `call` that forwards ETH to an address it cannot prove is `msg.sender`. The
annotation sits directly above the call with the trust-boundary rationale; in short:

1. The receiver is **not** caller-controlled: it is `f.airline`, the wallet stored when the
   airline created the flight and only reachable through `AirlineRegistry`'s approved
   operator set.
2. The amount is **not** caller-controlled either: `royalty = price * royaltyBps / 10000`
   with `royaltyBps <= maxRoyaltyBps = 1000` and `price <= 120% of the original fare`, and
   `msg.value` must equal the listing price exactly.
3. The marketplace is a **pass-through**: it never holds ETH beyond the single transaction,
   `nonReentrant` runs over the whole function, state is updated before both transfers
   (checks-effects-interactions), and both success flags are required — a failed payout
   reverts the whole purchase.
4. Tests cover the split math (`royalty + proceeds == price`), wrong-value purchase,
   double-buy, direct-transfer bypass attempts, and pause/eligibility guards.

Suppression therefore documents a reviewed boundary rather than hiding an open issue: an
airline can only be paid its own royalty, by the marketplace, for a correctly priced sale.

## History of fixes made for this phase

| Was | Fix |
|---|---|
| `uninitialized-local` (Medium) — loop counter in `getActiveListings()` | Explicit `uint256 n = 0;` initialisation (`TicketMarketplace.sol`). |
| `unused-return` (Low) — `getFlight(...)` result ignored in `previewSeatReference()` | Result assigned to `uint256 knownId` and used as the unknown-flight guard (`TicketSettlement.sol`). |
| `reentrancy-events` — `ListingCreated`/`ListingCancelled` emitted after `markListed`/`markUnlisted` | Events moved before the external state update (checks-effects-interactions). |
| `arbitrary-send-eth` (High) — royalty payout | Reviewed and annotated as above (`doc/STATIC_ANALYSIS.md`). |

## Gate

- `npm run lint` (Solhint) — 0 errors (warnings are the pre-existing baseline).
- Slither — 0 High / 0 Medium (this document).
- `npm run scan` — no secrets in tracked client code.
- `npm test` / `npm run test:e2e` — success and failure-path coverage per CONVENTIONS §6.
