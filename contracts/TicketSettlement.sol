// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Minimal registry view consumed for the platform pause + caps.
interface IRegistryViews {
    function paused() external view returns (bool);
}

/// @title TicketSettlement — purchase, cancellation, refund, airline revenue (R1 skeleton).
/// @notice Phase 1 wires addresses, role gates, pause behavior, and event/error shapes only.
///         Full `purchase(flightId, cid)` lands in Phase 2; full `cancel` + `withdrawAirlineBalance`
///         land in Phase 3. No money moves in this skeleton.
/// @dev Local Pausable is inherited for defense-in-depth; blocked entry points (Phase 2+)
///      will revert when EITHER the local pause OR the registry platform pause is active,
//        so behavior stays identical to the single-source matrix.
contract TicketSettlement is Pausable {
    IRegistryViews public immutable registry;
    address public immutable inventory;
    address public immutable ticketNFT;
    address public immutable admin;

    // Events for the Phase 2/3 implementations (declared now so dashboards can rely on shapes).
    event PurchaseCompleted(uint256 indexed flightId, uint256 indexed tokenId, address indexed buyer, string cid);
    event TicketCancelled(uint256 indexed tokenId, address indexed owner);
    event TicketRefunded(uint256 indexed tokenId, uint256 refund, uint256 retained);
    event AirlineWithdrawn(address indexed airline, uint256 amount);

    error PlatformPaused__();
    error NotAdmin__caller(address caller);
    error NotImplemented__phase(uint8 phase);

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
}
