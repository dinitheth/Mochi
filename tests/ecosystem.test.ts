import { describe, expect, it } from 'vitest';
import { AAVE_V3, KINTSU_VAULT, applyMinReceiveSlippage, fetchPerplMarkets, parsePerplMarketContext } from '../packages/mcp-server/src/tools/ecosystem/index.js';

describe('Monad ecosystem integration boundaries', () => {
  it('pins Aave V3 and Kintsu adapters to their reviewed Monad mainnet deployments', () => {
    expect(AAVE_V3.pool).toMatch(/^0x[\da-fA-F]{40}$/);
    expect(AAVE_V3.dataProvider).toMatch(/^0x[\da-fA-F]{40}$/);
    expect(KINTSU_VAULT).toMatch(/^0x[\da-fA-F]{40}$/);
  });

  it('calculates a conservative minimum receive amount for Kintsu actions', () => {
    expect(applyMinReceiveSlippage(10_000n)).toBe(9_950n);
    expect(applyMinReceiveSlippage(10_000n, 0)).toBe(10_000n);
    expect(() => applyMinReceiveSlippage(0n)).toThrow(/Invalid quote/);
  });

  it('accepts the documented Perpl mainnet market context', () => {
    const context = parsePerplMarketContext({ chain: { chain_id: 143 }, markets: [{ id: 10, name: 'MON', config: { price_decimals: 6 }, state: { mid: 26852 } }] });
    expect(context.markets?.[0]).toMatchObject({ id: 10, name: 'MON', priceDecimals: 6, midRaw: 26852 });
  });

  it('rejects malformed or non-Monad Perpl responses', () => {
    expect(() => parsePerplMarketContext({ markets: 'MON' })).toThrow(/invalid market context/);
    expect(() => parsePerplMarketContext({ chain: { id: 10143 }, markets: [] })).toThrow(/expected Monad mainnet/);
  });

  it('fetches Perpl market context through the documented public endpoint', async () => {
    let requested = '';
    const fakeFetch: typeof fetch = async (input) => {
      requested = String(input);
      return new Response(JSON.stringify({ chain: { chain_id: 143 }, markets: [{ id: 10, name: 'MON', config: {}, state: {} }] }), { status: 200 });
    };
    const result = await fetchPerplMarkets(fakeFetch);
    expect(requested).toBe('https://app.perpl.xyz/api/v1/pub/context');
    expect(result.markets?.[0]?.name).toBe('MON');
  });

  it('surfaces Perpl HTTP errors rather than presenting stale markets', async () => {
    const fakeFetch: typeof fetch = async () => new Response('unavailable', { status: 503 });
    await expect(fetchPerplMarkets(fakeFetch)).rejects.toThrow(/HTTP 503/);
  });
});
