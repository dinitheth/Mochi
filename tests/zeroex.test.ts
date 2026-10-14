import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateEnv } from '../packages/mcp-server/src/config/env.js';
import { getZeroExSwapQuote, ZEROEX_ALLOWANCE_HOLDER, ZEROEX_NATIVE_TOKEN } from '../packages/mcp-server/src/integrations/zeroex.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('0x native MON quote handling', () => {
  it('requests MON with the native-token sentinel and keeps the exact payable amount', async () => {
    const buyToken = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as const;
    const taker = '0xbcEE35caD52640C02f25Ea9b318737822DA2d10C' as const;
    const amount = 100_000_000_000_000_000n;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      allowanceTarget: ZEROEX_ALLOWANCE_HOLDER,
      sellToken: ZEROEX_NATIVE_TOKEN,
      buyToken,
      sellAmount: amount.toString(),
      buyAmount: '2500000',
      minBuyAmount: '2487500',
      liquidityAvailable: true,
      transaction: { to: ZEROEX_ALLOWANCE_HOLDER, data: '0x1234567890', value: amount.toString() },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const env = validateEnv({ ...process.env, OX_API_KEY: 'test-ox-key' });

    const quote = await getZeroExSwapQuote(env, {
      sellToken: ZEROEX_NATIVE_TOKEN,
      buyToken,
      sellAmount: amount,
      taker,
      slippageBps: 50,
    });

    const request = new URL(String(fetchMock.mock.calls[0][0]));
    expect(request.searchParams.get('sellToken')?.toLowerCase()).toBe(ZEROEX_NATIVE_TOKEN.toLowerCase());
    expect(request.searchParams.get('sellAmount')).toBe(amount.toString());
    expect(quote.transaction.value).toBe(amount.toString());
  });
});
