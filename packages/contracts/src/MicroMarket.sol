// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC721 {
    function transferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title MicroMarket — minimal fixed-price NFT marketplace (escrow + buy).
/// @notice Demo-grade and unaudited. Do not use with real value.
contract MicroMarket {
    struct Listing {
        address seller;
        uint256 price;
        bool active;
    }

    mapping(address => mapping(uint256 => Listing)) public listings;

    event Listed(address indexed nft, uint256 indexed tokenId, address indexed seller, uint256 price);
    event Sale(address indexed nft, uint256 indexed tokenId, address indexed buyer, uint256 price);
    event Cancelled(address indexed nft, uint256 indexed tokenId);

    /// @notice List an NFT at a fixed MON price. Caller must own it and have
    ///         approved this market (or use setApprovalForAll).
    function list(address nft, uint256 tokenId, uint256 price) external {
        require(price > 0, "zero price");
        IERC721(nft).transferFrom(msg.sender, address(this), tokenId);
        listings[nft][tokenId] = Listing({ seller: msg.sender, price: price, active: true });
        emit Listed(nft, tokenId, msg.sender, price);
    }

    /// @notice Buy a listed NFT. Overpayment is refunded.
    function buy(address nft, uint256 tokenId) external payable {
        Listing memory l = listings[nft][tokenId];
        require(l.active, "not listed");
        require(msg.value >= l.price, "underpaid");
        listings[nft][tokenId].active = false;
        (bool paid, ) = l.seller.call{ value: l.price }("");
        require(paid, "payout failed");
        IERC721(nft).transferFrom(address(this), msg.sender, tokenId);
        if (msg.value > l.price) {
            (bool refunded, ) = msg.sender.call{ value: msg.value - l.price }("");
            require(refunded, "refund failed");
        }
        emit Sale(nft, tokenId, msg.sender, l.price);
    }

    /// @notice Cancel a listing; escrowed NFT returns to the seller.
    function cancel(address nft, uint256 tokenId) external {
        Listing memory l = listings[nft][tokenId];
        require(l.active, "not listed");
        require(l.seller == msg.sender, "not seller");
        delete listings[nft][tokenId];
        IERC721(nft).transferFrom(address(this), msg.sender, tokenId);
        emit Cancelled(nft, tokenId);
    }

    function getListing(address nft, uint256 tokenId)
        external
        view
        returns (address seller, uint256 price, bool active)
    {
        Listing memory l = listings[nft][tokenId];
        return (l.seller, l.price, l.active);
    }
}
