// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Minimal registry view consumed for the platform pause + caps.
interface IRegistryViews {
    function paused() external view returns (bool);
}

/// @notice Flight views consumed by settlement (struct layout mirrors FlightInventory.Flight).
interface ISettlementInventory {
    struct Flight {
        uint256 flightId;
        address airline;
        string flightCode;
        string origin;
        string destination;
        uint256 departureTime;
        uint256 seatCapacity;
        uint256 seatsAvailable;
        uint256 priceWei;
        uint256 refundDeadline;
        uint16 refundBps;
        uint16 royaltyBps;
        bool salesOpen;
        bool departed;
        bool cancelled;
    }

    function getFlight(uint256 flightId) external view returns (Flight memory);
    function reserveSeat(uint256 flightId) external;
    /// @notice Return one seat to the flight's free pool (re-issue after cancellation).
    /// @param flightId Flight whose seat is released.
    function releaseSeat(uint256 flightId) external;
}

/// @notice Ticket views consumed by settlement (struct/enum mirror AirTicketNFT).
interface ISettlementTicketNFT {
    enum TicketState {
        Issued,
        Listed,
        Cancelled,
        Refunded,
        Used,
        Invalid
    }

    struct Ticket {
        uint256 flightId;
        string seatReference;
        address owner;
        string metadataCID;
        uint256 issuedAt;
        TicketState state;
        uint256 lastTransferAt;
    }

    function mint(
        address to,
        uint256 flightId,
        string calldata seatReference,
        string calldata cid
    ) external returns (uint256);
    /// @notice Move a ticket to its terminal Cancelled state (settlement-only on the NFT).
    /// @param tokenId Ticket being cancelled.
    function invalidateAsCancelled(uint256 tokenId) external;
    function getTicket(uint256 tokenId) external view returns (Ticket memory);
}

/// @title TicketSettlement — purchase, cancellation, refund, airline revenue (R1).
/// @notice `purchase(flightId, cid)` (exact-value payment, one seat per transaction, auto
///         `S-<n>` seat, CID record, per-airline revenue credit), the `calculateRefund(tokenId)`
///         preview view, `cancel(tokenId)` (policy refund to the ticket owner) and
///         `withdrawAirlineBalance()` (per-airline pull) are implemented.
/// @dev Accounting model: `purchase` credits the full fare to `airlineBalances[airline]`;
///      `cancel` debits the refunded portion, so the airline nets `price - refund`
///      (ARCHITECTURE.md §4.4). The refundable portion of every live ticket is mirrored in
///      `refundReserve[airline]` and stays locked while the ticket is cancellable, so the
///      contract can always fund a refund (withdrawals pay `balance - reserve` only).
///      Seat numbers are allocated from a per-flight pool: first-come `S-1, S-2, …`, and
///      numbers vacated by a cancellation are re-issued before new numbers, so a seat number
///      is never duplicated and never exceeds the flight's capacity.
///      Local Pausable is inherited for defense-in-depth; blocked entry points revert when
///      EITHER the local pause OR the registry platform pause is active. `cancel` and
///      `withdrawAirlineBalance` are deliberately not pause-guarded (ARCHITECTURE.md §9).
contract TicketSettlement is Pausable, ReentrancyGuard {
    using Strings for uint256;

    /// @notice Shortest accepted metadata CID (deterministic mock CIDs are 44 chars).
    uint256 public constant MIN_CID_LENGTH = 8;
    /// @notice Longest accepted metadata CID.
    uint256 public constant MAX_CID_LENGTH = 128;

    IRegistryViews public immutable registry;
    address public immutable inventory;
    address public immutable ticketNFT;
    address public immutable admin;

    /// @notice Accrued test-ETH per airline (full fare at purchase; refund debited at cancel).
    mapping(address => uint256) public airlineBalances;
    /// @notice Refundable portion of that airline's live tickets; withheld from withdrawal so
    ///         a later cancellation is always fundable (released when the ticket cancels).
    mapping(address => uint256) public refundReserve;
    /// @notice Highest seat number ever issued per flight.
    mapping(uint256 => uint256) public seatsIssued;
    /// @notice Seat numbers vacated by cancellation and awaiting re-issue.
    mapping(uint256 => uint256[]) private vacatedSeats;
    /// @notice tokenId -> seat number (kept as a number so a cancellation can free it exactly).
    mapping(uint256 => uint256) public seatNumberByToken;

    // Events (declared with the Phase 2/3 implementations so dashboards can rely on shapes).
    event PurchaseCompleted(uint256 indexed flightId, uint256 indexed tokenId, address indexed buyer, string cid);
    event TicketCancelled(uint256 indexed tokenId, address indexed owner);
    event TicketRefunded(uint256 indexed tokenId, uint256 refund, uint256 retained);
    event AirlineWithdrawn(address indexed airline, uint256 amount);

    error PlatformPaused__();
    error NotAdmin__caller(address caller);
    error SalesOpen__closed(uint256 flightId);
    error FlightCancelled__id(uint256 flightId);
    error FlightDeparted__id(uint256 flightId);
    error NoSeatsAvailable__id(uint256 flightId);
    error PaymentMismatch__value(uint256 expected, uint256 sent);
    error EmptyCid__();
    error InvalidCid__();
    error NotTicketOwner__caller(address caller);
    error NotIssued__state(uint8 state);
    error RefundDeadlinePassed__deadline(uint256 deadline);
    error RefundNotCovered__();
    error NothingToWithdraw__();
    error TransferFailed__receiver(address receiver);

    modifier whenPlatformLive() {
        if (paused() || registry.paused()) revert PlatformPaused__();
        _;
    }

    constructor(
        address registry_,
        address inventory_,
        address ticketNFT_,
        address admin_
    ) {
        require(
            registry_ != address(0) &&
                inventory_ != address(0) &&
                ticketNFT_ != address(0) &&
                admin_ != address(0),
            "zero address"
        );
        registry = IRegistryViews(registry_);
        inventory = inventory_;
        ticketNFT = ticketNFT_;
        admin = admin_;
    }

    /// @notice Local emergency pause (admin only; registry platform pause is the primary source).
    function pause() external {
        if (msg.sender != admin) revert NotAdmin__caller(msg.sender);
        _pause();
    }

    /// @notice Lift the local emergency pause (admin only).
    function unpause() external {
        if (msg.sender != admin) revert NotAdmin__caller(msg.sender);
        _unpause();
    }

    /// @notice Buy exactly one seat of a published flight and mint the ticket NFT (FR-12/13).
    /// @dev Validation order: CID shape → flight state → exact payment → seat availability.
    ///      Atomicity: any failure reverts the whole transaction, so a failed payment never
    ///      mints a ticket or decrements inventory. The CID was uploaded off-chain before
    ///      this call; a reverted purchase leaves that CID as harmless orphaned metadata.
    /// @param flightId Flight to book.
    /// @param cid Off-chain metadata CID recorded on the ticket (alphanumeric, 8–128 chars).
    /// @return tokenId The minted ticket.
    function purchase(uint256 flightId, string calldata cid)
        external
        payable
        whenPlatformLive
        nonReentrant
        returns (uint256 tokenId)
    {
        _validateCid(cid);
        ISettlementInventory.Flight memory f = ISettlementInventory(inventory).getFlight(flightId);

        if (f.cancelled) revert FlightCancelled__id(flightId);
        if (f.departed) revert FlightDeparted__id(flightId);
        if (!f.salesOpen) revert SalesOpen__closed(flightId);
        if (msg.value != f.priceWei) revert PaymentMismatch__value(f.priceWei, msg.value);
        if (f.seatsAvailable == 0) revert NoSeatsAvailable__id(flightId);

        ISettlementInventory(inventory).reserveSeat(flightId);
        uint256 seatNo = _allocateSeat(flightId);
        tokenId = ISettlementTicketNFT(ticketNFT).mint(
            msg.sender,
            flightId,
            string.concat("S-", seatNo.toString()),
            cid
        );
        seatNumberByToken[tokenId] = seatNo;
        airlineBalances[f.airline] += msg.value;
        // Escrow the refundable part of this fare: it stays withheld from withdrawal until
        // the ticket cancels (or expires un-cancelled), so a refund is always fundable.
        refundReserve[f.airline] += (msg.value * f.refundBps) / 10000;

        emit PurchaseCompleted(flightId, tokenId, msg.sender, cid);
    }

    /// @notice Cancel an owned `Issued` ticket before the refund deadline and receive the
    ///         policy refund (FR-21/22/23).
    /// @dev Guard order: owner → `Issued` state (rejects `Listed`, `Used`, `Cancelled`,
    ///      `Invalid`, `Refunded`) → flight not departed → at or before `refundDeadline`.
    ///      Available while the platform is paused so active tickets can always be resolved
    ///      (ARCHITECTURE.md §9). Effects happen before the refund transfer: the airline's
    ///      revenue and its matching escrow are debited, the ticket is invalidated to the
    ///      single terminal `Cancelled`, the seat returns to inventory and its number is
    ///      re-queued; then the refund is paid to the ticket owner (`nonReentrant` + CEI).
    ///      Emits `TicketCancelled` and `TicketRefunded(tokenId, refund, retained)`; the
    ///      transaction hash comes from the wallet receipt, never from this contract (D-16).
    /// @param tokenId Ticket to cancel.
    function cancel(uint256 tokenId) external nonReentrant {
        ISettlementTicketNFT.Ticket memory t = ISettlementTicketNFT(ticketNFT).getTicket(tokenId);
        if (t.owner != msg.sender) revert NotTicketOwner__caller(msg.sender);
        if (t.state != ISettlementTicketNFT.TicketState.Issued) {
            revert NotIssued__state(uint8(t.state));
        }

        ISettlementInventory.Flight memory f = ISettlementInventory(inventory).getFlight(t.flightId);
        if (f.departed) revert FlightDeparted__id(t.flightId);
        if (block.timestamp > f.refundDeadline) revert RefundDeadlinePassed__deadline(f.refundDeadline);

        uint256 price = f.priceWei;
        uint256 refund = (price * f.refundBps) / 10000;
        uint256 retained = price - refund;
        if (airlineBalances[f.airline] < refund || refundReserve[f.airline] < refund) {
            revert RefundNotCovered__();
        }

        // Effects (revenue debit + escrow release keep `balance >= reserve` invariant).
        airlineBalances[f.airline] -= refund;
        refundReserve[f.airline] -= refund;
        ISettlementTicketNFT(ticketNFT).invalidateAsCancelled(tokenId);
        ISettlementInventory(inventory).releaseSeat(t.flightId);
        vacatedSeats[t.flightId].push(seatNumberByToken[tokenId]);

        if (refund > 0) {
            (bool ok, ) = msg.sender.call{value: refund}("");
            if (!ok) revert TransferFailed__receiver(msg.sender);
        }

        emit TicketCancelled(tokenId, msg.sender);
        emit TicketRefunded(tokenId, refund, retained);
    }

    /// @notice Pull this airline's accrued revenue (D-11: per-airline, pull-only, never
    ///         cross-airline — the caller can only ever move its own `airlineBalances`).
    /// @dev Pays `airlineBalances[caller] - refundReserve[caller]`: the refundable portion of
    ///      live tickets stays in the contract so those cancellations remain fundable. Not
    ///      pause-guarded — it moves an airline's own revenue and touches no ticket state.
    function withdrawAirlineBalance() external nonReentrant {
        uint256 accrued = airlineBalances[msg.sender];
        uint256 reserved = refundReserve[msg.sender];
        if (accrued < reserved) revert RefundNotCovered__();
        uint256 amount = accrued - reserved;
        if (amount == 0) revert NothingToWithdraw__();

        airlineBalances[msg.sender] = reserved;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed__receiver(msg.sender);

        emit AirlineWithdrawn(msg.sender, amount);
    }

    /// @notice Refund preview for an issued ticket; matches the `cancel` formula exactly.
    /// @dev Returns `(0, price)` when cancellation is not currently eligible: ticket is not
    ///      `Issued`, the refund deadline has passed (allowed at or before `refundDeadline`),
    ///      or the flight has departed. Reads stay available while paused.
    /// @param tokenId Ticket to price.
    /// @return refund Wei that would be returned to the traveler.
    /// @return retained Wei the airline would keep.
    function calculateRefund(uint256 tokenId)
        external
        view
        returns (uint256 refund, uint256 retained)
    {
        ISettlementTicketNFT.Ticket memory t = ISettlementTicketNFT(ticketNFT).getTicket(tokenId);
        ISettlementInventory.Flight memory f = ISettlementInventory(inventory).getFlight(t.flightId);
        uint256 price = f.priceWei;

        bool eligible = t.state == ISettlementTicketNFT.TicketState.Issued &&
            block.timestamp <= f.refundDeadline &&
            !f.departed;
        if (!eligible) return (0, price);

        refund = (price * f.refundBps) / 10000;
        retained = price - refund;
    }

    /// @notice Seat reference the next purchase would receive (checkout preview, no side effects).
    /// @param flightId Flight whose next seat number is previewed.
    function previewSeatReference(uint256 flightId) external view returns (string memory) {
        ISettlementInventory(inventory).getFlight(flightId); // unknown flight reverts here
        return string.concat("S-", _nextSeatNumber(flightId).toString());
    }

    // ---- Internal ----

    /// @dev CID policy: non-empty, 8–128 alphanumeric characters (CIDv0 `Qm…` / CIDv1 `bafy…`
    ///      and the deterministic mock CID both fit). Rejects malformed caller input before
    ///      any state change.
    function _validateCid(string calldata cid) private pure {
        bytes memory raw = bytes(cid);
        if (raw.length == 0) revert EmptyCid__();
        if (raw.length < MIN_CID_LENGTH || raw.length > MAX_CID_LENGTH) revert InvalidCid__();
        for (uint256 i = 0; i < raw.length; i++) {
            uint8 c = uint8(raw[i]);
            bool alphanumeric = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
            if (!alphanumeric) revert InvalidCid__();
        }
    }

    /// @dev Re-uses a vacated seat number when one exists, otherwise issues the next number.
    function _allocateSeat(uint256 flightId) private returns (uint256) {
        uint256[] storage freeSeats = vacatedSeats[flightId];
        if (freeSeats.length > 0) {
            uint256 seatNo = freeSeats[freeSeats.length - 1];
            freeSeats.pop();
            return seatNo;
        }
        seatsIssued[flightId] += 1;
        return seatsIssued[flightId];
    }

    /// @dev Next number `_allocateSeat` would hand out (peek, no state change).
    function _nextSeatNumber(uint256 flightId) private view returns (uint256) {
        uint256[] storage freeSeats = vacatedSeats[flightId];
        if (freeSeats.length > 0) return freeSeats[freeSeats.length - 1];
        return seatsIssued[flightId] + 1;
    }
}
