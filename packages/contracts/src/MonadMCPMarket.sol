// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC721 {
    function transferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IERC2981 {
    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        external
        view
        returns (address receiver, uint256 royaltyAmount);
}

/// @title MonadMCPMarket — fixed-price listings + offers with royalty support.
/// @notice Listing/buy interface is identical to MicroMarket so existing
///         tooling works unchanged. Demo-grade and unaudited.
contract MonadMCPMarket {
    struct Listing {
        address seller;
        uint256 price;
        bool active;
    }

    struct Offer {
        address buyer;
        uint256 amount;
        uint64 expiry;
        bool active;
    }

    mapping(address => mapping(uint256 => Listing)) public listings;
    // nft => tokenId => offerId => Offer
    mapping(address => mapping(uint256 => mapping(uint256 => Offer))) public offers;
    mapping(address => mapping(uint256 => uint256)) public offerCount;

    event Listed(address indexed nft, uint256 indexed tokenId, address indexed seller, uint256 price);
    event Sale(address indexed nft, uint256 indexed tokenId, address indexed buyer, uint256 price);
    event Cancelled(address indexed nft, uint256 indexed tokenId);
    event OfferMade(address indexed nft, uint256 indexed tokenId, uint256 indexed offerId, address buyer, uint256 amount, uint64 expiry);
    event OfferAccepted(address indexed nft, uint256 indexed tokenId, uint256 indexed offerId, uint256 amount);
    event OfferCancelled(address indexed nft, uint256 indexed tokenId, uint256 indexed offerId);

    bytes4 private constant _IERC2981 = 0x2bc74b75;

    function list(address nft, uint256 tokenId, uint256 price) external {
        require(price > 0, "zero price");
        IERC721(nft).transferFrom(msg.sender, address(this), tokenId);
        listings[nft][tokenId] = Listing({ seller: msg.sender, price: price, active: true });
        emit Listed(nft, tokenId, msg.sender, price);
    }

    function buy(address nft, uint256 tokenId) external payable {
        Listing memory l = listings[nft][tokenId];
        require(l.active, "not listed");
        require(msg.value >= l.price, "underpaid");
        listings[nft][tokenId].active = false;
        _payout(nft, tokenId, l.seller, l.price);
        IERC721(nft).transferFrom(address(this), msg.sender, tokenId);
        if (msg.value > l.price) {
            (bool refunded, ) = msg.sender.call{ value: msg.value - l.price }("");
            require(refunded, "refund failed");
        }
        emit Sale(nft, tokenId, msg.sender, l.price);
    }

    function cancel(address nft, uint256 tokenId) external {
        Listing memory l = listings[nft][tokenId];
        require(l.active, "not listed");
        require(l.seller == msg.sender, "not seller");
        delete listings[nft][tokenId];
        IERC721(nft).transferFrom(address(this), msg.sender, tokenId);
        emit Cancelled(nft, tokenId);
    }

    /// @notice Make a binding offer, escrowing MON. Refunded on outbid-free cancel or seller action.
    function makeOffer(address nft, uint256 tokenId, uint64 expirySecs) external payable returns (uint256 offerId) {
        require(msg.value > 0, "zero offer");
        require(expirySecs == 0 || expirySecs >= 60, "bad expiry");
        offerId = ++offerCount[nft][tokenId];
        offers[nft][tokenId][offerId] = Offer({
            buyer: msg.sender,
            amount: msg.value,
            expiry: expirySecs == 0 ? type(uint64).max : uint64(block.timestamp) + expirySecs,
            active: true
        });
        emit OfferMade(nft, tokenId, offerId, msg.sender, msg.value, expirySecs == 0 ? type(uint64).max : uint64(block.timestamp) + expirySecs);
    }

    /// @notice Seller accepts an offer. Escrowed listing (if any) is superseded.
    function acceptOffer(address nft, uint256 tokenId, uint256 offerId) external {
        Listing memory l = listings[nft][tokenId];
        Offer memory o = offers[nft][tokenId][offerId];
        require(o.active, "offer inactive");
        require(block.timestamp <= o.expiry, "offer expired");
        bool isSeller = (l.active && l.seller == msg.sender) ||
            (!l.active && IERC721(nft).ownerOf(tokenId) == msg.sender);
        require(isSeller, "not seller");
        offers[nft][tokenId][offerId].active = false;
        if (l.active) {
            listings[nft][tokenId].active = false;
        } else {
            IERC721(nft).transferFrom(msg.sender, address(this), tokenId);
        }
        _payout(nft, tokenId, msg.sender, o.amount);
        IERC721(nft).transferFrom(address(this), o.buyer, tokenId);
        emit OfferAccepted(nft, tokenId, offerId, o.amount);
        emit Sale(nft, tokenId, o.buyer, o.amount);
    }

    /// @notice Bidder reclaims an offer (after expiry, or anytime if never the path to sale).
    function cancelOffer(address nft, uint256 tokenId, uint256 offerId) external {
        Offer memory o = offers[nft][tokenId][offerId];
        require(o.active, "offer inactive");
        require(o.buyer == msg.sender, "not buyer");
        offers[nft][tokenId][offerId].active = false;
        (bool refunded, ) = o.buyer.call{ value: o.amount }("");
        require(refunded, "refund failed");
        emit OfferCancelled(nft, tokenId, offerId);
    }

    function getListing(address nft, uint256 tokenId)
        external
        view
        returns (address seller, uint256 price, bool active)
    {
        Listing memory l = listings[nft][tokenId];
        return (l.seller, l.price, l.active);
    }

    function getOffer(address nft, uint256 tokenId, uint256 offerId)
        external
        view
        returns (address buyer, uint256 amount, uint64 expiry, bool active)
    {
        Offer memory o = offers[nft][tokenId][offerId];
        return (o.buyer, o.amount, o.expiry, o.active);
    }

    /// @notice Pay the seller minus any EIP-2981 royalty the collection declares.
    function _payout(address nft, uint256 tokenId, address seller, uint256 total) internal {
        uint256 rest = total;
        if (_supportsRoyalty(nft)) {
            try IERC2981(nft).royaltyInfo(tokenId, total) returns (address receiver, uint256 amount) {
                if (receiver != address(0) && amount > 0 && amount < total) {
                    rest -= amount;
                    (bool rPaid, ) = receiver.call{ value: amount }("");
                    require(rPaid, "royalty failed");
                }
            } catch {
                // Non-compliant royalty impl — seller takes all.
            }
        }
        (bool paid, ) = seller.call{ value: rest }("");
        require(paid, "payout failed");
    }

    function _supportsRoyalty(address nft) internal view returns (bool) {
        (bool ok, bytes memory out) = nft.staticcall(abi.encodeWithSignature("supportsInterface(bytes4)", _IERC2981));
        return ok && out.length == 32 && abi.decode(out, (bool));
    }
}
