# Mochi Demo Indexer (Envio HyperIndex)

Indexes `MicroSwap`, `MicroMarket`, `AuctionHouse`, `MockNFT` and `MockERC20`
on Monad testnet (10143) into a hosted GraphQL API. Powers collection floors,
auction boards, bid history and volume charts without polling the chain.

> Requires Node 22+, pnpm and (for local runs) Docker Desktop + WSL.
> The deployer wallet holds no secrets here — only public contract addresses.

```bash
cd packages/indexer
pnpm install
cp .env.example .env   # set ENVIO_API_TOKEN for local runs
pnpm codegen           # regenerate handler types after config/schema edits
pnpm dev               # local indexer + Hasura at http://localhost:8080
```

Deploy to Envio Cloud from this directory (`envio deploy`), then point the
MCP server at the hosted GraphQL endpoint. Example queries driving our tools:

```graphql
# Cheapest active listing (nft_research_collections floor)
query {
  NftListed(where: { active: { _eq: true } }, order_by: { price: asc }, limit: 5) {
    nft tokenId price seller { id }
  }
}

# Live auctions with current lead (auction board)
query {
  Auction(where: { settled: { _eq: false } }, order_by: { endTime: asc }) {
    auctionId nft tokenId reserve highestBid highestBidder endTime
  }
}

# Swap tape (volume charts)
query {
  Swap(order_by: { blockNumber: desc }, limit: 50) {
    sender tokenIn amountIn amountOut blockNumber
  }
}
```
