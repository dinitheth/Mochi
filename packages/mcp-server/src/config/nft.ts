import type { Env } from './env.js';

export interface NftMarketConfig {
  collection: `0x${string}`;
  collectionName: string;
  market: `0x${string}` | null;
  markets: `0x${string}`[];
  auctionHouse: `0x${string}` | null;
}

/** Deployed by `packages/contracts` — see deployments/nft-testnet.json. */
const MOCK_NFT_TESTNET = '0x3440af240213610a945339111567ddedd55384b0' as const;
const MICROMARKET_TESTNET = '0xb2162b9f72a8a33a2c8e7f4c5a00c6e5316907c4' as const;
const MONADMCPMARKET_TESTNET = '0x332059A65Aa2A88405BC214A9D1243f4D23bA8c7' as const;
const AUCTION_HOUSE_TESTNET = '0x1a77918b88E398F77D78EDae870d4406C66eb0B2' as const;

export function getNftMarketConfig(env: Env): NftMarketConfig {
  if (env.MONAD_NETWORK !== 'testnet') {
    return { collection: '0x0000000000000000000000000000000000000000', collectionName: 'none', market: null, markets: [], auctionHouse: null };
  }
  const collection = (env.MOCK_NFT_ADDRESS || MOCK_NFT_TESTNET) as `0x${string}`;
  const market = (env.MICROMARKET_ADDRESS || MONADMCPMARKET_TESTNET) as `0x${string}`;
  const auctionHouse = (env.AUCTION_HOUSE_ADDRESS || AUCTION_HOUSE_TESTNET || '') as string;
  const markets = [market, MICROMARKET_TESTNET as `0x${string}`].filter(
    (m, i, arr) => m && arr.findIndex((x) => x.toLowerCase() === m.toLowerCase()) === i,
  );
  return {
    collection,
    collectionName: 'MonadMCP Demo Punks (MDP)',
    market,
    markets,
    auctionHouse: auctionHouse ? (auctionHouse as `0x${string}`) : null,
  };
}
