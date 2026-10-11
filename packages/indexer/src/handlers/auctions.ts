import { AuctionHouse, MockNFT } from "generated";

AuctionHouse.AuctionCreated.handler(async ({ event, context }) => {
  context.Auction.set({
    id: event.params.auctionId.toString(),
    auctionId: event.params.auctionId,
    nft: event.params.nft,
    tokenId: event.params.tokenId,
    seller: event.params.seller,
    reserve: event.params.reserve,
    highestBid: 0n,
    highestBidder: "0x0000000000000000000000000000000000000000",
    endTime: BigInt(event.params.endTime),
    settled: false,
  });
});

AuctionHouse.BidPlaced.handler(async ({ event, context }) => {
  context.Bid.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    auctionId: event.params.auctionId,
    bidder: event.params.bidder,
    amount: event.params.amount,
    blockNumber: BigInt(event.block.number),
  });
  const auction = await context.Auction.get(event.params.auctionId.toString());
  if (auction) {
    context.Auction.set({ ...auction, highestBid: event.params.amount, highestBidder: event.params.bidder });
  }
});

AuctionHouse.AuctionSettled.handler(async ({ event, context }) => {
  const auction = await context.Auction.get(event.params.auctionId.toString());
  if (auction) {
    context.Auction.set({ ...auction, settled: true });
  }
});

MockNFT.Transfer.handler(async ({ event, context }) => {
  context.NftTransfer.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    nft: event.srcAddress,
    from: event.params.from,
    to: event.params.to,
    tokenId: event.params.tokenId,
    blockNumber: BigInt(event.block.number),
  });
});
