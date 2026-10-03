// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";

/// @notice Minimal flight views consumed by the ticket contract.
interface IFlightInventoryViews {
    function getFlightAirline(uint256 flightId) external view returns (address);
    function getFlightDeparture(uint256 flightId) external view returns (uint256);
    function getFlightRoyalty(uint256 flightId)
        external
        view
        returns (address airline, uint16 royaltyBps);
    function isFlightCancelled(uint256 flightId) external view returns (bool);
}

interface IRegistryPause {
    function paused() external view returns (bool);
}

/// @title AirTicketNFT — restricted ERC-721 ticket representation.
/// @notice Direct transfers are blocked; ownership moves only through `controlledTransfer`
///         (MARKETPLACE_ROLE). R1 terminal ticket state is Cancelled; payout detail travels
///         in the settlement `TicketRefunded` event, never in ticket state.
/// @dev Invalidation (not burn) is used on cancellation so the public verifier can keep
///      reading the terminal record. Pause matrix (locked R1): mint and controlled transfers
///      are blocked while paused; markUsed, invalidate (cancel path) and reads remain.
///      Local Pausable state is intentionally not duplicated: the single pause source is
///      AirlineRegistry, read via `whenPlatformLive`.
contract AirTicketNFT is ERC721, ERC2981, AccessControl {
    /// @notice Check-in opens this far before departure. R1: 2 hours.
    uint256 public constant CHECKIN_WINDOW = 2 hours;

    /// @notice Held by the TicketMarketplace contract for controlled transfers.
    bytes32 public constant MARKETPLACE_ROLE = keccak256("MARKETPLACE_ROLE");

    enum TicketState {
        Issued,
        Listed,
        Cancelled,
        Refunded, // retained for PRD compatibility; never set as state in R1
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

    IRegistryPause public immutable registry;
    IFlightInventoryViews public immutable inventory;

    /// @notice Settlement contract allowed to mint/invalidate (wired post-deploy).
    address public settlement;

    uint256 public nextTokenId = 1;
    mapping(uint256 => Ticket) private tickets;

    /// @notice Reentrancy-style flag proving a transfer runs inside `controlledTransfer`.
    bool private _controlledTransferActive;

    event TicketMinted(uint256 indexed tokenId, uint256 indexed flightId, address indexed owner, string cid);
    event TicketInvalidated(uint256 indexed tokenId);
    event TicketMarkedUsed(uint256 indexed tokenId);
    event TicketTransferred(uint256 indexed tokenId, address indexed from, address indexed to);
    event TicketListed(uint256 indexed tokenId);
    event TicketDelisted(uint256 indexed tokenId);
    event SettlementUpdated(address settlement);

    error PlatformPaused__();
    error ZeroAddress__account();
    error UnknownTicket__id(uint256 tokenId);
    error UnauthorizedSettlement__caller(address caller);
    error EmptyCid__();
    error DirectTransferBlocked__();
    error NotIssued__state(TicketState state);
    error NotListed__state(TicketState state);
    error TerminalState__state(TicketState state);
    error NotFlightAirline__caller(address caller);
    error FlightCancelled__id(uint256 flightId);
    error CheckinClosed__now(uint256 nowTs);

    modifier whenPlatformLive() {
        if (registry.paused()) revert PlatformPaused__();
        _;
    }

    modifier onlySettlement() {
        if (msg.sender != settlement) revert UnauthorizedSettlement__caller(msg.sender);
        _;
    }

    constructor(
        address registry_,
        address inventory_,
        address admin
    ) ERC721("Airline Ticket", "ATICKET") {
        if (registry_ == address(0) || inventory_ == address(0) || admin == address(0)) {
            revert ZeroAddress__account();
        }
        registry = IRegistryPause(registry_);
        inventory = IFlightInventoryViews(inventory_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Wire (or re-wire) the settlement contract allowed to mint/invalidate.
    function setSettlement(address settlement_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (settlement_ == address(0)) revert ZeroAddress__account();
        settlement = settlement_;
        emit SettlementUpdated(settlement_);
    }

    /// @notice Mint one ticket (Phase 1 stub: record + event only; payment logic lands in Phase 2 settlement).
    function mint(
        address to,
        uint256 flightId,
        string calldata seatReference,
        string calldata cid
    ) external onlySettlement whenPlatformLive returns (uint256) {
        if (to == address(0)) revert ZeroAddress__account();
        if (bytes(cid).length == 0) revert EmptyCid__();
        uint256 tokenId = nextTokenId++;
        tickets[tokenId] = Ticket({
            flightId: flightId,
            seatReference: seatReference,
            owner: to,
            metadataCID: cid,
            issuedAt: block.timestamp,
            state: TicketState.Issued,
            lastTransferAt: block.timestamp
        });
        _safeMint(to, tokenId);
        emit TicketMinted(tokenId, flightId, to, cid);
        return tokenId;
    }

    /// @notice Permanently invalidate a ticket as Cancelled (cancel path; remains during pause).
    function invalidateAsCancelled(uint256 tokenId) external onlySettlement {
        Ticket storage t = _getTicket(tokenId);
        if (t.state != TicketState.Issued) revert NotIssued__state(t.state);
        t.state = TicketState.Cancelled;
        t.lastTransferAt = block.timestamp;
        emit TicketInvalidated(tokenId);
    }

    /// @notice Sole writer: airline operator marks its own ticket used from check-in open onward.
    /// @dev Remains available during pause so active tickets resolve safely.
    function markUsed(uint256 tokenId) external {
        Ticket storage t = _getTicket(tokenId);
        if (t.state != TicketState.Issued) revert NotIssued__state(t.state);
        address airline = inventory.getFlightAirline(t.flightId);
        if (airline != msg.sender) revert NotFlightAirline__caller(msg.sender);
        if (inventory.isFlightCancelled(t.flightId)) revert FlightCancelled__id(t.flightId);
        uint256 departure = inventory.getFlightDeparture(t.flightId);
        // Within [departure - 2h, +inf): written without underflow.
        if (block.timestamp + CHECKIN_WINDOW < departure) {
            revert CheckinClosed__now(block.timestamp);
        }
        t.state = TicketState.Used;
        t.lastTransferAt = block.timestamp;
        emit TicketMarkedUsed(tokenId);
    }

    /// @notice Marketplace-controlled ownership move (blocked while paused).
    function controlledTransfer(
        address from,
        address to,
        uint256 tokenId
    ) external onlyRole(MARKETPLACE_ROLE) whenPlatformLive {
        Ticket storage t = _getTicket(tokenId);
        if (
            t.state == TicketState.Cancelled ||
            t.state == TicketState.Refunded ||
            t.state == TicketState.Used ||
            t.state == TicketState.Invalid
        ) revert TerminalState__state(t.state);
        if (to == address(0)) revert ZeroAddress__account();
        _controlledTransferActive = true;
        _transfer(from, to, tokenId);
        _controlledTransferActive = false;
        t.owner = to;
        t.lastTransferAt = block.timestamp;
        emit TicketTransferred(tokenId, from, to);
    }

    /// @notice Move a ticket `Issued` -> `Listed` (marketplace only; blocked while paused).
    /// @dev The listing itself lives in TicketMarketplace; this only mirrors the ticket state
    ///      so the wallet, verifier and `cancel` guard all see one unambiguous badge.
    function markListed(uint256 tokenId) external onlyRole(MARKETPLACE_ROLE) whenPlatformLive {
        Ticket storage t = _getTicket(tokenId);
        if (t.state != TicketState.Issued) revert NotIssued__state(t.state);
        t.state = TicketState.Listed;
        emit TicketListed(tokenId);
    }

    /// @notice Move a ticket `Listed` -> `Issued` (marketplace only).
    /// @dev Deliberately NOT pause-guarded: withdrawing a listing is a restrictive action, so
    ///      a seller can always free an expired or unwanted listing and then cancel/refund
    ///      (same treatment as `cancel` / `markUsed` in the locked pause matrix).
    function markUnlisted(uint256 tokenId) external onlyRole(MARKETPLACE_ROLE) {
        Ticket storage t = _getTicket(tokenId);
        if (t.state != TicketState.Listed) revert NotListed__state(t.state);
        t.state = TicketState.Issued;
        emit TicketDelisted(tokenId);
    }

    /// @notice Display-only royalty mirroring the flight's stored royaltyBps (marketplace math is authoritative).
    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        public
        view
        override
        returns (address, uint256)
    {
        Ticket storage t = _getTicket(tokenId);
        (address airline, uint16 bps) = inventory.getFlightRoyalty(t.flightId);
        return (airline, (salePrice * bps) / 10000);
    }

    function getTicket(uint256 tokenId) external view returns (Ticket memory) {
        return _getTicket(tokenId);
    }

    /// @dev Direct ERC-721 transfers revert; only mint/burn (zero-address legs) and flagged
    ///      controlled transfers pass.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0) && !_controlledTransferActive) {
            revert DirectTransferBlocked__();
        }
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC2981, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _getTicket(uint256 tokenId) private view returns (Ticket storage) {
        if (tokenId == 0 || tokenId >= nextTokenId) revert UnknownTicket__id(tokenId);
        return tickets[tokenId];
    }
}
