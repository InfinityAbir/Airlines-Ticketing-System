// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Minimal registry view consumed for the platform pause.
interface IMarketRegistryViews {
    function paused() external view returns (bool);
}

/// @title TicketMarketplace — approved resale and royalty distribution (R1 skeleton).
/// @notice Phase 1 wires addresses, locked R1 constants, pause behavior, and event/error
///         shapes only. Full `list` / `cancelListing` / `buyListing` land in Phase 4.
/// @dev Local Pausable is inherited for defense-in-depth; blocked entry points (Phase 4)
///      will revert when EITHER the local pause OR the registry platform pause is active.
contract TicketMarketplace is Pausable {
    /// @notice Resale price cap, basis points relative to the original fare. R1: 12000 (120%).
    uint256 public constant RESALE_CAP_BPS = 12000;
    /// @notice Basis-points denominator.
    uint256 public constant BPS_DENOMINATOR = 10000;
    /// @notice Default listing duration. R1: 24 hours (capped at departure minus check-in).
    uint256 public constant DEFAULT_LISTING_DURATION = 24 hours;

    struct Listing {
        uint256 listingId;
        uint256 tokenId;
        address seller;
        uint256 priceWei;
        bool active;
        uint256 createdAt;
        uint256 expiresAt;
    }

    IMarketRegistryViews public immutable registry;
    address public immutable inventory;
    address public immutable ticketNFT;
    address public immutable admin;

    uint256 public nextListingId = 1;
    mapping(uint256 => Listing) private listings;

    // Events for the Phase 4 implementation (declared now so dashboards can rely on shapes).
    event ListingCreated(uint256 indexed listingId, uint256 indexed tokenId, address indexed seller, uint256 priceWei, uint256 expiresAt);
    event ListingCancelled(uint256 indexed listingId);
    event ListingSold(uint256 indexed listingId, uint256 indexed tokenId, address indexed buyer, uint256 priceWei, uint256 royalty, uint256 sellerProceeds);

    error PlatformPaused__();
    error NotAdmin__caller(address caller);
    error UnknownListing__id(uint256 listingId);

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
        registry = IMarketRegistryViews(registry_);
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

    function getListing(uint256 listingId) external view returns (Listing memory) {
        if (listingId == 0 || listingId >= nextListingId) revert UnknownListing__id(listingId);
        return listings[listingId];
    }
}
