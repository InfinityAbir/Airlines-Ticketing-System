// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @title AirlineRegistry — platform administration and airline authorization.
/// @notice Canonical pause source for the prototype. Holds no ticket or money logic.
/// @dev R1 (Phase 1): approve/deactivate/reactivate airlines, platform limits, pause.
///      Governance actions (approvals, limits) intentionally remain available while paused.
contract AirlineRegistry is AccessControl, Pausable {
    /// @notice Operator role for approved airlines (managed solely through this contract).
    bytes32 public constant AIRLINE_ROLE = keccak256("AIRLINE_ROLE");

    /// @notice Maximum resale royalty, basis points (10000 = 100%). R1 default: 1000 (10%).
    uint16 public maxRoyaltyBps = 1000;
    /// @notice Maximum refund rate, basis points. R1 default: 10000 (100%).
    uint16 public maxRefundBps = 10000;

    /// @notice Whether a wallet is currently an approved airline operator.
    mapping(address => bool) public airlineApproved;

    event AirlineApproved(address indexed wallet);
    event AirlineDeactivated(address indexed wallet);
    event AirlineReactivated(address indexed wallet);
    event LimitsUpdated(uint16 maxRoyaltyBps, uint16 maxRefundBps);

    error ZeroAddress__wallet();
    error AlreadyApproved__wallet(address wallet);
    error NotApproved__wallet(address wallet);
    error RoyaltyCapTooHigh__bps(uint16 bps);
    error RefundCapTooHigh__bps(uint16 bps);

    /// @param admin Platform administrator receiving DEFAULT_ADMIN_ROLE.
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress__wallet();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Approve an airline operator wallet (grants AIRLINE_ROLE).
    function approveAirline(address wallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (wallet == address(0)) revert ZeroAddress__wallet();
        if (airlineApproved[wallet]) revert AlreadyApproved__wallet(wallet);
        airlineApproved[wallet] = true;
        _grantRole(AIRLINE_ROLE, wallet);
        emit AirlineApproved(wallet);
    }

    /// @notice Deactivate an airline operator wallet (revokes AIRLINE_ROLE).
    function deactivateAirline(address wallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!airlineApproved[wallet]) revert NotApproved__wallet(wallet);
        airlineApproved[wallet] = false;
        _revokeRole(AIRLINE_ROLE, wallet);
        emit AirlineDeactivated(wallet);
    }

    /// @notice Reactivate a previously deactivated airline operator wallet.
    function reactivateAirline(address wallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (wallet == address(0)) revert ZeroAddress__wallet();
        if (airlineApproved[wallet]) revert AlreadyApproved__wallet(wallet);
        airlineApproved[wallet] = true;
        _grantRole(AIRLINE_ROLE, wallet);
        emit AirlineReactivated(wallet);
    }

    /// @notice Update platform-wide rate caps.
    function setLimits(uint16 _maxRoyaltyBps, uint16 _maxRefundBps)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (_maxRoyaltyBps > 10000) revert RoyaltyCapTooHigh__bps(_maxRoyaltyBps);
        if (_maxRefundBps > 10000) revert RefundCapTooHigh__bps(_maxRefundBps);
        maxRoyaltyBps = _maxRoyaltyBps;
        maxRefundBps = _maxRefundBps;
        emit LimitsUpdated(_maxRoyaltyBps, _maxRefundBps);
    }

    /// @notice Emergency pause (blocks user flows; governance and safe resolutions remain).
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Lift the emergency pause.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Read helper used by downstream contracts and the frontend.
    function isApproved(address wallet) external view returns (bool) {
        return airlineApproved[wallet];
    }
}
