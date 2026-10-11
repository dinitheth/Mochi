// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC721 {
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// @title AuctionHouse — minimal English auction for NFTs (escrow + refunds).
/// @notice Demo-grade and unaudited. Do not use with real value.
contract AuctionHouse {
    struct Auction {
        address seller;
        address nft;
        uint256 tokenId;
        uint256 reserve;
        uint256 highestBid;
        address highestBidder;
        uint64 endTime;
        bool settled;
    }

    uint256 public auctionCount;
    mapping(uint256 => Auction) public auctions;

    /// @notice Minimum raise over the current highest bid, in basis points.
    uint256 public constant MIN_INCREMENT_BPS = 500; // 5%

    event AuctionCreated(
        uint256 indexed auctionId, address indexed nft, uint256 indexed tokenId, address seller, uint256 reserve, uint64 endTime
    );
    event BidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount);
    event AuctionSettled(uint256 indexed auctionId, address winner, uint256 amount);
    event AuctionCancelled(uint256 indexed auctionId);

    /// @notice Escrow an NFT and open an auction lasting `durationSecs` seconds.
    function createAuction(address nft, uint256 tokenId, uint256 reserve, uint64 durationSecs)
        external
        returns (uint256 auctionId)
    {
        require(reserve > 0, "zero reserve");
        require(durationSecs >= 60, "too short");
        IERC721(nft).transferFrom(msg.sender, address(this), tokenId);
        auctionId = ++auctionCount;
        auctions[auctionId] = Auction({
            seller: msg.sender,
            nft: nft,
            tokenId: tokenId,
            reserve: reserve,
            highestBid: 0,
            highestBidder: address(0),
            endTime: uint64(block.timestamp) + durationSecs,
            settled: false
        });
        emit AuctionCreated(auctionId, nft, tokenId, msg.sender, reserve, uint64(block.timestamp) + durationSecs);
    }

    /// @notice Bid at least the reserve, or 5% over the current highest bid.
    ///         The previous highest bidder is refunded automatically.
    function bid(uint256 auctionId) external payable {
        Auction storage a = auctions[auctionId];
        require(a.seller != address(0), "no auction");
        require(!a.settled, "settled");
        require(block.timestamp < a.endTime, "ended");
        require(msg.value >= a.reserve, "below reserve");
        if (a.highestBid > 0) {
            require(msg.value * 10000 >= a.highestBid * (10000 + MIN_INCREMENT_BPS), "raise too small");
            (bool refunded, ) = a.highestBidder.call{ value: a.highestBid }("");
            require(refunded, "refund failed");
        }
        a.highestBid = msg.value;
        a.highestBidder = msg.sender;
        emit BidPlaced(auctionId, msg.sender, msg.value);
    }

    /// @notice Settle after expiry. Winner gets the NFT, seller gets the pot.
    ///         With no bids the NFT returns to the seller. Callable by anyone.
    function settle(uint256 auctionId) external {
        Auction storage a = auctions[auctionId];
        require(a.seller != address(0), "no auction");
        require(!a.settled, "settled");
        require(block.timestamp >= a.endTime, "running");
        a.settled = true;
        if (a.highestBidder == address(0)) {
            IERC721(a.nft).transferFrom(address(this), a.seller, a.tokenId);
            emit AuctionSettled(auctionId, a.seller, 0);
        } else {
            (bool paid, ) = a.seller.call{ value: a.highestBid }("");
            require(paid, "payout failed");
            IERC721(a.nft).transferFrom(address(this), a.highestBidder, a.tokenId);
            emit AuctionSettled(auctionId, a.highestBidder, a.highestBid);
        }
    }

    /// @notice Cancel before any bid; the NFT returns to the seller.
    function cancel(uint256 auctionId) external {
        Auction storage a = auctions[auctionId];
        require(a.seller == msg.sender, "not seller");
        require(!a.settled, "settled");
        require(a.highestBidder == address(0), "has bids");
        a.settled = true;
        IERC721(a.nft).transferFrom(address(this), a.seller, a.tokenId);
        emit AuctionCancelled(auctionId);
    }

    function getAuction(uint256 auctionId) external view returns (Auction memory) {
        return auctions[auctionId];
    }
}
