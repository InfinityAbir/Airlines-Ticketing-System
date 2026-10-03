// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Minimal registry view consumed for the platform pause + royalty cap.
interface IMarketRegistryViews {
    function paused() external view returns (bool);
    function maxRoyaltyBps() external view returns (uint16);
}

/// @notice Flight views consumed by the marketplace (struct layout mirrors FlightInventory.Flight).
interface IMarketInventoryViews {
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
}

/// @notice Ticket views/ops consumed by the marketplace (mirrors AirTicketNFT).
interface IMarketTicketNFT {
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

    function getTicket(uint256 tokenId) external view returns (Ticket memory);
    /// @notice Marketplace-only `Issued` -> `Listed` state flip.
    function markListed(uint256 tokenId) external;
    /// @notice Marketplace-only `Listed` -> `Issued` state flip.
    function markUnlisted(uint256 tokenId) external;
    /// @notice Marketplace-only ownership move (MARKETPLACE_ROLE on AirTicketNFT).
    function controlledTransfer(address from, address to, uint256 tokenId) external;
}

/// @title TicketMarketplace — approved resale and airline royalty distribution.
/// @notice `list(tokenId, priceWei, expiresAt)` opens one listing per ticket, `cancelListing`
///         withdraws it, and `buyListing(listingId)` settles a resale atomically: payment is
///         split into airline royalty + seller proceeds, ownership moves through the
///         marketplace-controlled transfer, and the ticket returns to `Issued` for its new owner.
/// @dev R1 guards (ARCHITECTURE §4.5): one active listing per ticket; owner only; ticket must be
///      `Issued`; flight not departed/cancelled and at or before the refund deadline; platform
///      royalty cap respected; `priceWei <= originalPrice * 12000 / 10000`; `expiresAt` at or
///      before `departureTime - 2 hours` and strictly in the future. The listing expiry default
///      (24h, capped by that bound) is computed by the caller and validated here — see
///      `previewResale`, which also exposes `checkinBound` and `defaultExpiry`.
///      Rounding rule (documented integer division): `royalty = price * royaltyBps / 10000`
///      rounds DOWN and the seller receives `price - royalty`, so seller + royalty == price
///      exactly — a resale event always accounts for 100% of the payment.
///      Pause matrix: `list` and `buyListing` revert while paused; `cancelListing` and all
///      reads stay available so a seller can always withdraw a listing.
///      Sibling rule (ARCHITECTURE §5.4): this contract never calls TicketSettlement; royalty is
///      paid straight to the airline's wallet and never enters `airlineBalances`.
contract TicketMarketplace is Pausable, ReentrancyGuard {
    /// @notice Resale price cap, basis points relative to the original fare. R1: 12000 (120%).
    uint256 public constant RESALE_CAP_BPS = 12000;
    /// @notice Basis-points denominator.
    uint256 public constant BPS_DENOMINATOR = 10000;
    /// @notice Default listing duration. R1: 24 hours (capped at departure minus check-in).
    uint256 public constant DEFAULT_LISTING_DURATION = 24 hours;
    /// @notice Check-in opens this far before departure. R1: 2 hours (mirrors AirTicketNFT).
    uint256 public constant CHECKIN_WINDOW = 2 hours;

    struct Listing {
        uint256 listingId;
        uint256 tokenId;
        address seller;
        uint256 priceWei;
        bool active;
        uint256 createdAt;
        uint256 expiresAt;
    }

    /// @notice Everything the UI needs to price a resale before it signs (FR-30, DESIGN §6).
    struct ResalePreview {
        address airline;
        uint16 royaltyBps;
        uint256 originalPriceWei;
        uint256 maxPriceWei;
        uint256 checkinBound;
        uint256 defaultExpiry;
        uint256 royalty;
        uint256 sellerProceeds;
    }

    IMarketRegistryViews public immutable registry;
    address public immutable inventory;
    address public immutable ticketNFT;
    address public immutable admin;

    uint256 public nextListingId = 1;
    mapping(uint256 => Listing) private listings;
    /// @notice tokenId -> active listing id (0 = none). Enforces one active listing per ticket.
    mapping(uint256 => uint256) public activeListingByToken;

    event ListingCreated(
        uint256 indexed listingId,
        uint256 indexed tokenId,
        address indexed seller,
        uint256 priceWei,
        uint256 expiresAt
    );
    event ListingCancelled(uint256 indexed listingId);
    event ListingSold(
        uint256 indexed listingId,
        uint256 indexed tokenId,
        address indexed buyer,
        uint256 priceWei,
        uint256 royalty,
        uint256 sellerProceeds
    );

    error PlatformPaused__();
    error NotAdmin__caller(address caller);
    error UnknownListing__id(uint256 listingId);
    error ListingNotActive__id(uint256 listingId);
    error ListingExpired__expiresAt(uint256 expiresAt);
    error NotTicketOwner__caller(address caller);
    error NotSeller__caller(address caller);
    error AlreadyListed__tokenId(uint256 tokenId);
    error InvalidState__state(uint8 state);
    error SellerMismatch__seller(address seller);
    error FlightCancelled__id(uint256 flightId);
    error FlightDeparted__id(uint256 flightId);
    error RefundDeadlinePassed__deadline(uint256 deadline);
    error RoyaltyAboveCap__bps(uint16 bps);
    error ZeroPrice__();
    error ResaleCapExceeded__price(uint256 maxPriceWei, uint256 priceWei);
    error ExpiryPastCheckin__expiresAt(uint256 expiresAt, uint256 checkinBound);
    error ExpiryInPast__expiresAt(uint256 expiresAt);
    error PaymentMismatch__value(uint256 expected, uint256 sent);
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
        registry = IMarketRegistryViews(registry_);
        inventory = inventory_;
        ticketNFT = ticketNFT_;
        admin = admin_;
    }

    // ---- Emergency controls ----

    /// @notice Local emergency pause (admin only; registry platform pause is the primary source).
    /// @dev Restores the Phase 1 surface: `list` / `buyListing` revert when EITHER the local
    ///      pause OR the registry platform pause is active; `cancelListing` is deliberately not
    ///      pause-guarded so a seller can always withdraw a listing.
    function pause() external {
        if (msg.sender != admin) revert NotAdmin__caller(msg.sender);
        _pause();
    }

    /// @notice Lift the local emergency pause (admin only).
    function unpause() external {
        if (msg.sender != admin) revert NotAdmin__caller(msg.sender);
        _unpause();
    }

    // ---- Listing lifecycle ----

    /// @notice Offer an owned, eligible ticket for resale (FR-27/28).
    /// @dev Guard order: price shape → ticket owner → ticket state → flight policy → platform
    ///      royalty cap → 120% price cap → expiry window. Effects: the listing is recorded and
    ///      the ticket flips to `Listed`, which is what makes `cancel`/`markUsed` reject it
    ///      until the listing is withdrawn or sold.
    /// @param tokenId Ticket to list (must be owned by the caller in state `Issued`).
    /// @param priceWei Asking price in wei; must be non-zero and at most 120% of the original fare.
    /// @param expiresAt Unix seconds the listing stops being buyable; must be in the future and
    ///        no later than `departureTime - 2 hours`. Use `previewResale().defaultExpiry` for
    ///        the standard 24-hour window.
    /// @return listingId Identifier used by `cancelListing` / `buyListing`.
    function list(uint256 tokenId, uint256 priceWei, uint256 expiresAt)
        external
        whenPlatformLive
        returns (uint256 listingId)
    {
        if (priceWei == 0) revert ZeroPrice__();

        IMarketTicketNFT.Ticket memory t = IMarketTicketNFT(ticketNFT).getTicket(tokenId);
        if (t.owner != msg.sender) revert NotTicketOwner__caller(msg.sender);
        if (t.state == IMarketTicketNFT.TicketState.Listed || activeListingByToken[tokenId] != 0) {
            revert AlreadyListed__tokenId(tokenId);
        }
        if (t.state != IMarketTicketNFT.TicketState.Issued) {
            revert InvalidState__state(uint8(t.state));
        }

        IMarketInventoryViews.Flight memory f = IMarketInventoryViews(inventory).getFlight(t.flightId);
        _checkResaleEligibility(f);

        uint256 maxPriceWei = (f.priceWei * RESALE_CAP_BPS) / BPS_DENOMINATOR;
        if (priceWei > maxPriceWei) revert ResaleCapExceeded__price(maxPriceWei, priceWei);
        _checkExpiry(f.departureTime, expiresAt);

        listingId = nextListingId++;
        Listing storage listing = listings[listingId];
        listing.listingId = listingId;
        listing.tokenId = tokenId;
        listing.seller = msg.sender;
        listing.priceWei = priceWei;
        listing.active = true;
        listing.createdAt = block.timestamp;
        listing.expiresAt = expiresAt;
        activeListingByToken[tokenId] = listingId;

        IMarketTicketNFT(ticketNFT).markListed(tokenId);
        emit ListingCreated(listingId, tokenId, msg.sender, priceWei, expiresAt);
    }

    /// @notice Withdraw an active listing and return the ticket to `Issued`.
    /// @dev Seller-only and deliberately NOT pause-guarded: withdrawing moves no ETH and always
    ///      leaves the ticket in a safer state, so it stays available during an emergency pause.
    /// @param listingId Listing to close.
    function cancelListing(uint256 listingId) external {
        Listing storage listing = _activeListing(listingId);
        if (listing.seller != msg.sender) revert NotSeller__caller(msg.sender);

        uint256 tokenId = listing.tokenId;
        listing.active = false;
        delete activeListingByToken[tokenId];

        IMarketTicketNFT(ticketNFT).markUnlisted(tokenId);
        emit ListingCancelled(listingId);
    }

    /// @notice Buy an active listing: pay the asking price, receive the ticket (FR-29/30).
    /// @dev Validation order: listing exists and is active → not expired → ticket still `Listed`
    ///      and still owned by the recorded seller → flight policy (cancelled/departed/deadline)
    ///      → royalty cap → exact payment. Effects first: the listing closes, ownership moves
    ///      through `controlledTransfer` and the ticket returns to `Issued`; then the payment is
    ///      split (royalty to the airline, remainder to the seller) and the event records both
    ///      halves. Any failure reverts the whole transaction, so a failed payment never moves
    ///      the ticket or the funds.
    /// @param listingId Listing to buy; send exactly its `priceWei` as value.
    function buyListing(uint256 listingId) external payable whenPlatformLive nonReentrant {
        Listing storage listing = _activeListing(listingId);
        if (block.timestamp > listing.expiresAt) revert ListingExpired__expiresAt(listing.expiresAt);

        uint256 tokenId = listing.tokenId;
        address seller = listing.seller;
        uint256 priceWei = listing.priceWei;

        IMarketTicketNFT.Ticket memory t = IMarketTicketNFT(ticketNFT).getTicket(tokenId);
        if (t.state != IMarketTicketNFT.TicketState.Listed) {
            revert InvalidState__state(uint8(t.state));
        }
        if (t.owner != seller) revert SellerMismatch__seller(seller);

        IMarketInventoryViews.Flight memory f = IMarketInventoryViews(inventory).getFlight(t.flightId);
        _checkResaleEligibility(f);
        if (msg.value != priceWei) revert PaymentMismatch__value(priceWei, msg.value);

        uint256 royalty = (priceWei * f.royaltyBps) / BPS_DENOMINATOR;
        uint256 sellerProceeds = priceWei - royalty;

        // Effects — listing closed and ticket moved before any ETH leaves the contract.
        listing.active = false;
        delete activeListingByToken[tokenId];
        IMarketTicketNFT(ticketNFT).controlledTransfer(seller, msg.sender, tokenId);
        IMarketTicketNFT(ticketNFT).markUnlisted(tokenId);

        // Interactions — split payment; royalty floors, seller takes the remainder (sum == price).
        if (royalty > 0) {
            (bool royaltyOk, ) = f.airline.call{value: royalty}("");
            if (!royaltyOk) revert TransferFailed__receiver(f.airline);
        }
        if (sellerProceeds > 0) {
            (bool sellerOk, ) = seller.call{value: sellerProceeds}("");
            if (!sellerOk) revert TransferFailed__receiver(seller);
        }

        emit ListingSold(listingId, tokenId, msg.sender, priceWei, royalty, sellerProceeds);
    }

    // ---- Views (always available, including while paused) ----

    function getListing(uint256 listingId) external view returns (Listing memory) {
        if (listingId == 0 || listingId >= nextListingId) revert UnknownListing__id(listingId);
        return listings[listingId];
    }

    /// @notice Active, unexpired listings — the public marketplace catalogue (no indexer in R1).
    /// @dev Expired listings are excluded because they can no longer be bought; the seller still
    ///      sees them as `Listed` in the wallet and withdraws them with `cancelListing`.
    function getActiveListings() external view returns (Listing[] memory items) {
        uint256 count;
        for (uint256 id = 1; id < nextListingId; id++) {
            Listing storage listing = listings[id];
            if (listing.active && block.timestamp <= listing.expiresAt) count++;
        }
        items = new Listing[](count);
        uint256 n;
        for (uint256 id = 1; id < nextListingId; id++) {
            Listing storage listing = listings[id];
            if (listing.active && block.timestamp <= listing.expiresAt) items[n++] = listing;
        }
    }

    /// @notice Resale pricing preview; the split math is identical to `buyListing`.
    /// @dev Display-only: it deliberately does not run eligibility guards (those are reported by
    ///      the mutating call), it only prices the trade and reports the listing window.
    /// @param tokenId Ticket being priced.
    /// @param priceWei Candidate asking price (may exceed the cap — `maxPriceWei` is returned too).
    function previewResale(uint256 tokenId, uint256 priceWei)
        external
        view
        returns (ResalePreview memory p)
    {
        IMarketTicketNFT.Ticket memory t = IMarketTicketNFT(ticketNFT).getTicket(tokenId);
        IMarketInventoryViews.Flight memory f = IMarketInventoryViews(inventory).getFlight(t.flightId);

        p.airline = f.airline;
        p.royaltyBps = f.royaltyBps;
        p.originalPriceWei = f.priceWei;
        p.maxPriceWei = (f.priceWei * RESALE_CAP_BPS) / BPS_DENOMINATOR;
        p.checkinBound =
            f.departureTime > CHECKIN_WINDOW ? f.departureTime - CHECKIN_WINDOW : 0;
        uint256 nowPlusDefault = block.timestamp + DEFAULT_LISTING_DURATION;
        p.defaultExpiry = nowPlusDefault < p.checkinBound ? nowPlusDefault : p.checkinBound;
        p.royalty = (priceWei * f.royaltyBps) / BPS_DENOMINATOR;
        p.sellerProceeds = priceWei - p.royalty;
    }

    // ---- Internal ----

    /// @dev Shared resale eligibility (used by `list` and `buyListing` so both agree exactly).
    function _checkResaleEligibility(IMarketInventoryViews.Flight memory f) private view {
        if (f.cancelled) revert FlightCancelled__id(f.flightId);
        if (f.departed) revert FlightDeparted__id(f.flightId);
        if (block.timestamp > f.refundDeadline) revert RefundDeadlinePassed__deadline(f.refundDeadline);
        uint16 cap = registry.maxRoyaltyBps();
        if (f.royaltyBps > cap) revert RoyaltyAboveCap__bps(f.royaltyBps);
    }

    /// @dev Expiry rule: strictly in the future and at or before `departureTime - 2 hours`.
    function _checkExpiry(uint256 departureTime, uint256 expiresAt) private view {
        uint256 bound =
            departureTime > CHECKIN_WINDOW ? departureTime - CHECKIN_WINDOW : 0;
        if (expiresAt > bound) revert ExpiryPastCheckin__expiresAt(expiresAt, bound);
        if (expiresAt <= block.timestamp) revert ExpiryInPast__expiresAt(expiresAt);
    }

    /// @dev Load an existing, still-active listing (unknown id and closed id revert distinctly).
    function _activeListing(uint256 listingId) private view returns (Listing storage listing) {
        if (listingId == 0 || listingId >= nextListingId) revert UnknownListing__id(listingId);
        listing = listings[listingId];
        if (!listing.active) revert ListingNotActive__id(listingId);
    }
}
