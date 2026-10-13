import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateEnv } from '../packages/mcp-server/src/config/env.js';
import { listOpenSeaMonadListings } from '../packages/mcp-server/src/integrations/opensea.js';

const contract = '0xaeaa920165fd7ce58a0e0772ffc97f06626572cd';

function listing(tokenId: string, priceMON: string, orderHashByte: string) {
  return {
    chain: 'monad',
    status: 'ACTIVE',
    order_hash: `0x${orderHashByte.repeat(64)}`,
    protocol_address: '0x0000000000000068f116a894984e2db1123eb395',
    asset: { contract, identifier: tokenId },
    price: { current: { currency: 'MON', decimals: 18, value: String(BigInt(priceMON) * 10n ** 18n) } },
  };
}

describe('OpenSea Monad listing cards', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns distinct NFTs, keeps the cheapest order per token, and corrects stale metadata IDs', async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname.endsWith('/best')) {
        return new Response(JSON.stringify({
          listings: [listing('688', '499', '1'), listing('688', '498', '2'), listing('504', '495', '3')],
        }), { status: 200 });
      }
      if (url.pathname.endsWith('/stats')) {
        return new Response(JSON.stringify({ total: { floor_price: 494.99, floor_price_symbol: 'MON' } }), { status: 200 });
      }
      const tokenId = url.pathname.split('/').at(-1);
      const metadataName = tokenId === '688' ? 'sealuminati #689' : 'sealuminati #504';
      return new Response(JSON.stringify({ nft: {
        name: metadataName,
        collection: 'Sealuminati',
        display_image_url: `https://images.example/${tokenId}.png`,
      } }), { status: 200 });
    };
    vi.stubGlobal('fetch', fakeFetch);

    const env = validateEnv({ ...process.env, MONAD_NETWORK: 'mainnet', OPENSEA_API_KEY: 'test-key' });
    const listings = await listOpenSeaMonadListings(env, 'sealuminati', 5);

    expect(listings).toHaveLength(2);
    expect(listings.map((item) => item.tokenId)).toEqual(['504', '688']);
    expect(listings.map((item) => item.priceRaw)).toEqual([
      String(495n * 10n ** 18n),
      String(498n * 10n ** 18n),
    ]);
    expect(listings[1]).toMatchObject({
      name: 'sealuminati #688',
      imageUrl: 'https://images.example/688.png',
      floorPrice: 494.99,
      floorCurrency: 'MON',
      orderHash: `0x${'2'.repeat(64)}`,
    });
    expect(calls.filter((path) => path.endsWith('/best'))).toHaveLength(1);
  });

  it('excludes unsupported listing currencies from the native MON purchase feed', async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/best')) {
        return new Response(JSON.stringify({ listings: [
          { ...listing('1', '5', '1'), price: { current: { currency: 'USDC', decimals: 6, value: '5000000' } } },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ total: { floor_price: 4, floor_price_symbol: 'MON' } }), { status: 200 });
    };
    vi.stubGlobal('fetch', fakeFetch);

    const env = validateEnv({ ...process.env, MONAD_NETWORK: 'mainnet', OPENSEA_API_KEY: 'test-key' });
    await expect(listOpenSeaMonadListings(env, 'sealuminati', 5)).resolves.toEqual([]);
  });
});
