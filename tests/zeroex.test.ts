import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateEnv } from '../packages/mcp-server/src/config/env.js';
import * as monadConfig from '../packages/mcp-server/src/config/monad.js';
import { getZeroExSwapPrice, getZeroExSwapQuote, ZEROEX_ALLOWANCE_HOLDER, ZEROEX_NATIVE_TOKEN } from '../packages/mcp-server/src/integrations/zeroex.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('0x native MON quote handling', () => {
  it('gets a read-only native MON estimate without requesting transaction data', async () => {
    const buyToken = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as const;
    const taker = '0xbcEE35caD52640C02f25Ea9b318737822DA2d10C' as const;
    const amount = 100_000_000_000_000_000n;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      sellToken: ZEROEX_NATIVE_TOKEN,
      buyToken,
      sellAmount: amount.toString(),
      buyAmount: '2500000',
      minBuyAmount: '2487500',
      liquidityAvailable: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const env = validateEnv({ ...process.env, OX_API_KEY: 'test-ox-key' });

    const price = await getZeroExSwapPrice(env, {
      sellToken: ZEROEX_NATIVE_TOKEN,
      buyToken,
      sellAmount: amount,
      taker,
      slippageBps: 50,
    });

    const request = new URL(String(fetchMock.mock.calls[0][0]));
    expect(request.pathname).toBe('/swap/allowance-holder/price');
    expect(request.searchParams.get('sellToken')?.toLowerCase()).toBe(ZEROEX_NATIVE_TOKEN.toLowerCase());
    expect(request.searchParams.get('sellAmount')).toBe(amount.toString());
    expect(price.buyAmount).toBe('2500000');
    expect(price.minBuyAmount).toBe('2487500');
    expect(JSON.stringify(price)).not.toContain('transaction');
  });

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

  it('accepts only the current registry-verified 0x settlement target for a native swap', async () => {
    const buyToken = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as const;
    const taker = '0xbcEE35caD52640C02f25Ea9b318737822DA2d10C' as const;
    const settler = '0x2222222222222222222222222222222222222222' as const;
    const amount = 100_000_000_000_000_000n;
    const readContract = vi.fn().mockResolvedValue(settler);
    vi.spyOn(monadConfig, 'getPublicClient').mockReturnValue({ readContract } as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      allowanceTarget: ZEROEX_ALLOWANCE_HOLDER,
      sellToken: ZEROEX_NATIVE_TOKEN,
      buyToken,
      sellAmount: amount.toString(),
      buyAmount: '2500000',
      minBuyAmount: '2487500',
      liquidityAvailable: true,
      transaction: { to: settler, data: '0x1234567890', value: amount.toString() },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const env = validateEnv({ ...process.env, OX_API_KEY: 'test-ox-key' });

    const quote = await getZeroExSwapQuote(env, {
      sellToken: ZEROEX_NATIVE_TOKEN, buyToken, sellAmount: amount, taker, slippageBps: 50,
    });

    expect(quote.transaction.to).toBe(settler);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'ownerOf', args: [2n] }));
  });

  it('rejects an unverified native-swap target even when 0x names the expected approval contract', async () => {
    const buyToken = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as const;
    const taker = '0xbcEE35caD52640C02f25Ea9b318737822DA2d10C' as const;
    const amount = 100_000_000_000_000_000n;
    vi.spyOn(monadConfig, 'getPublicClient').mockReturnValue({ readContract: vi.fn().mockResolvedValue('0x3333333333333333333333333333333333333333') } as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      allowanceTarget: ZEROEX_ALLOWANCE_HOLDER,
      sellToken: ZEROEX_NATIVE_TOKEN,
      buyToken,
      sellAmount: amount.toString(),
      buyAmount: '2500000',
      minBuyAmount: '2487500',
      liquidityAvailable: true,
      transaction: { to: '0x4444444444444444444444444444444444444444', data: '0x1234567890', value: amount.toString() },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const env = validateEnv({ ...process.env, OX_API_KEY: 'test-ox-key' });

    await expect(getZeroExSwapQuote(env, {
      sellToken: ZEROEX_NATIVE_TOKEN, buyToken, sellAmount: amount, taker, slippageBps: 50,
    })).rejects.toThrow('0x returned a transaction target that Mochi could not verify.');
  });
});
