import { MicroMarket } from "generated";

const listingId = (nft: string, tokenId: bigint) => `${nft}-${tokenId.toString()}`;

MicroMarket.Listed.handler(async ({ event, context }) => {
  context.NftListed.set({
    id: listingId(event.params.nft, event.params.tokenId),
    nft: event.params.nft,
    tokenId: event.params.tokenId,
    seller: event.params.seller,
    price: event.params.price,
    active: true,
  });
});

MicroMarket.Sale.handler(async ({ event, context }) => {
  context.NftSale.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    nft: event.params.nft,
    tokenId: event.params.tokenId,
    buyer: event.params.buyer,
    price: event.params.price,
    blockNumber: BigInt(event.block.number),
  });
  const existing = await context.NftListed.get(listingId(event.params.nft, event.params.tokenId));
  context.NftListed.set({
    id: listingId(event.params.nft, event.params.tokenId),
    nft: event.params.nft,
    tokenId: event.params.tokenId,
    seller: existing?.seller ?? "",
    price: event.params.price,
    active: false,
  });
});

MicroMarket.Cancelled.handler(async ({ event, context }) => {
  const existing = await context.NftListed.get(listingId(event.params.nft, event.params.tokenId));
  if (existing) {
    context.NftListed.set({ ...existing, active: false });
  }
});
