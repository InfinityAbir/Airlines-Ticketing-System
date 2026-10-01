// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Minimal registry view consumed by downstream contracts (single source of truth).
interface IAirlineRegistry {
    function paused() external view returns (bool);
    function isApproved(address wallet) external view returns (bool);
    function maxRoyaltyBps() external view returns (uint16);
    function maxRefundBps() external view returns (uint16);
}

/// @title FlightInventory — airline-owned flight records and seat availability.
/// @notice Approval and caps are read from AirlineRegistry; this contract stores no roles
///         besides its own admin (used only for wiring settlement/marketplace addresses).
/// @dev Pause matrix (locked R1): platform pause blocks create/publish; pauseSales,
///      cancelFlight, markDeparted and reads remain. reserve/release carry no pause guard
///      because pause is enforced at the settlement/marketplace entry points (Phase 2+).
contract FlightInventory is AccessControl, Pausable {
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

    IAirlineRegistry public immutable registry;

    struct CreateFlightParams {
        string flightCode;
        string origin;
        string destination;
        uint256 departureTime;
        uint256 seatCapacity;
        uint256 priceWei;
        uint256 refundDeadline;
        uint16 refundBps;
        uint16 royaltyBps;
    }

    uint256 public nextFlightId = 1;
    mapping(uint256 => Flight) private flights;
    /// @notice Flight-code hash => flightId. Codes are reusable only after cancellation.
    mapping(bytes32 => uint256) public codeToFlightId;

    /// @notice Contracts allowed to call reserve/release (settlement + marketplace).
    address public settlement;
    address public marketplace;

    event FlightCreated(uint256 indexed flightId, address indexed airline, string flightCode);
    event FlightPublished(uint256 indexed flightId);
    event FlightSalesPaused(uint256 indexed flightId);
    event FlightCancelled(uint256 indexed flightId);
    event FlightDeparted(uint256 indexed flightId);
    event SeatReserved(uint256 indexed flightId, uint256 seatsAvailable);
    event SeatReleased(uint256 indexed flightId, uint256 seatsAvailable);
    event AuthorizedPartiesUpdated(address settlement, address marketplace);

    error PlatformPaused__();
    error UnauthorizedAirline__caller(address caller);
    error UnauthorizedCaller__caller(address caller);
    error PastDeparture__time(uint256 departureTime);
    error ZeroCapacity__();
    error InvalidRefundDeadline__deadline(uint256 refundDeadline);
    error RefundRateTooHigh__bps(uint16 refundBps);
    error RoyaltyAboveCap__bps(uint16 royaltyBps);
    error DuplicateFlightCode__code(string flightCode);
    error UnknownFlight__id(uint256 flightId);
    error NotFlightAirline__caller(address caller);
    error NoSeatsAvailable__id(uint256 flightId);
    error InventoryFull__id(uint256 flightId);
    error AlreadyDeparted__id(uint256 flightId);
    error AlreadyCancelled__id(uint256 flightId);
    error ZeroAddress__account();

    modifier whenPlatformLive() {
        if (registry.paused()) revert PlatformPaused__();
        _;
    }

    modifier onlyApprovedAirline() {
        if (!registry.isApproved(msg.sender)) revert UnauthorizedAirline__caller(msg.sender);
        _;
    }

    modifier onlyFlightAirline(uint256 flightId) {
        if (flights[flightId].airline != msg.sender) revert NotFlightAirline__caller(msg.sender);
        _;
    }

    modifier onlyAuthorizedParty() {
        if (msg.sender != settlement && msg.sender != marketplace) {
            revert UnauthorizedCaller__caller(msg.sender);
        }
        _;
    }

    constructor(address registry_, address admin) {
        if (registry_ == address(0) || admin == address(0)) revert ZeroAddress__account();
        registry = IAirlineRegistry(registry_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Wire (or re-wire) the settlement/marketplace callers for reserve/release.
    function setAuthorizedParties(address settlement_, address marketplace_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (settlement_ == address(0) || marketplace_ == address(0)) {
            revert ZeroAddress__account();
        }
        settlement = settlement_;
        marketplace = marketplace_;
        emit AuthorizedPartiesUpdated(settlement_, marketplace_);
    }

    /// @notice Create a flight in Draft state (salesOpen=false). Blocked while paused.
    /// @param p Flight parameters (struct form avoids stack pressure with 9 fields).
    function createFlight(CreateFlightParams calldata p)
        external
        whenPlatformLive
        onlyApprovedAirline
        returns (uint256)
    {
        if (p.departureTime <= block.timestamp) revert PastDeparture__time(p.departureTime);
        if (p.seatCapacity == 0) revert ZeroCapacity__();
        if (p.refundDeadline > p.departureTime) {
            revert InvalidRefundDeadline__deadline(p.refundDeadline);
        }
        if (p.refundBps > registry.maxRefundBps()) revert RefundRateTooHigh__bps(p.refundBps);
        if (p.royaltyBps > registry.maxRoyaltyBps()) revert RoyaltyAboveCap__bps(p.royaltyBps);

        bytes32 codeHash = keccak256(bytes(p.flightCode));
        uint256 existingId = codeToFlightId[codeHash];
        if (existingId != 0 && !flights[existingId].cancelled) {
            revert DuplicateFlightCode__code(p.flightCode);
        }

        uint256 flightId = nextFlightId++;
        Flight storage f = flights[flightId];
        f.flightId = flightId;
        f.airline = msg.sender;
        f.flightCode = p.flightCode;
        f.origin = p.origin;
        f.destination = p.destination;
        f.departureTime = p.departureTime;
        f.seatCapacity = p.seatCapacity;
        f.seatsAvailable = p.seatCapacity;
        f.priceWei = p.priceWei;
        f.refundDeadline = p.refundDeadline;
        f.refundBps = p.refundBps;
        f.royaltyBps = p.royaltyBps;
        // salesOpen, departed, cancelled default to false.
        codeToFlightId[codeHash] = flightId;
        emit FlightCreated(flightId, msg.sender, p.flightCode);
        return flightId;
    }

    /// @notice Open sales for a flight. Blocked while paused.
    function publishFlight(uint256 flightId)
        external
        whenPlatformLive
        onlyFlightAirline(flightId)
    {
        Flight storage f = _getFlight(flightId);
        if (f.departed) revert AlreadyDeparted__id(flightId);
        if (f.cancelled) revert AlreadyCancelled__id(flightId);
        f.salesOpen = true;
        emit FlightPublished(flightId);
    }

    /// @notice Halt sales without cancelling the flight (restrictive action: remains during pause).
    function pauseSales(uint256 flightId) external onlyFlightAirline(flightId) {
        Flight storage f = _getFlight(flightId);
        f.salesOpen = false;
        emit FlightSalesPaused(flightId);
    }

    /// @notice Cancel a flight (restrictive action: remains during pause).
    function cancelFlight(uint256 flightId) external onlyFlightAirline(flightId) {
        Flight storage f = _getFlight(flightId);
        if (f.departed) revert AlreadyDeparted__id(flightId);
        if (f.cancelled) revert AlreadyCancelled__id(flightId);
        f.cancelled = true;
        f.salesOpen = false;
        emit FlightCancelled(flightId);
    }

    /// @notice Mark a flight departed; contract-level guard for later cancel/resale (remains during pause).
    function markDeparted(uint256 flightId) external onlyFlightAirline(flightId) {
        Flight storage f = _getFlight(flightId);
        if (f.cancelled) revert AlreadyCancelled__id(flightId);
        f.departed = true;
        f.salesOpen = false;
        emit FlightDeparted(flightId);
    }

    /// @notice Decrement inventory. Callable only by settlement/marketplace (Phase 2+ entry points enforce pause).
    function reserveSeat(uint256 flightId) external onlyAuthorizedParty {
        Flight storage f = _getFlight(flightId);
        if (!f.salesOpen || f.cancelled || f.departed) revert NoSeatsAvailable__id(flightId);
        if (f.seatsAvailable == 0) revert NoSeatsAvailable__id(flightId);
        f.seatsAvailable -= 1;
        emit SeatReserved(flightId, f.seatsAvailable);
    }

    /// @notice Return one seat to inventory (R1 cancellation policy, FR-23).
    function releaseSeat(uint256 flightId) external onlyAuthorizedParty {
        Flight storage f = _getFlight(flightId);
        if (f.seatsAvailable >= f.seatCapacity) revert InventoryFull__id(flightId);
        f.seatsAvailable += 1;
        emit SeatReleased(flightId, f.seatsAvailable);
    }

    // ---- Reads (always available, including while paused) ----

    function getFlight(uint256 flightId) external view returns (Flight memory) {
        return _getFlight(flightId);
    }

    function isFlightAirline(uint256 flightId, address account) external view returns (bool) {
        if (flightId == 0 || flightId >= nextFlightId) return false;
        return flights[flightId].airline == account;
    }

    function getFlightAirline(uint256 flightId) external view returns (address) {
        return _getFlight(flightId).airline;
    }

    function getFlightDeparture(uint256 flightId) external view returns (uint256) {
        return _getFlight(flightId).departureTime;
    }

    function getFlightRoyalty(uint256 flightId)
        external
        view
        returns (address airline, uint16 royaltyBps)
    {
        Flight storage f = _getFlight(flightId);
        return (f.airline, f.royaltyBps);
    }

    function isFlightCancelled(uint256 flightId) external view returns (bool) {
        return _getFlight(flightId).cancelled;
    }

    function _getFlight(uint256 flightId) private view returns (Flight storage) {
        if (flightId == 0 || flightId >= nextFlightId) revert UnknownFlight__id(flightId);
        return flights[flightId];
    }
}
