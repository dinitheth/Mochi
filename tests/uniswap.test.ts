import { describe, expect, it } from 'vitest';
import { validateEnv } from '../packages/mcp-server/src/config/env.js';
import { getUniswapQuote, parseUniswapQuote } from '../packages/mcp-server/src/integrations/uniswap.js';

const wallet = '0x1111111111111111111111111111111111111111' as const;
const tokenIn = '0x2222222222222222222222222222222222222222' as const;
const tokenOut = '0x3333333333333333333333333333333333333333' as const;
const router = '0xa6ce4f10d83dbddac17e68e1837ca9ce6a1b596e';

function quotePayload(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    routing: 'CLASSIC',
    quote: {
      input: { token: tokenIn, amount: '1000000' },
      output: { token: tokenOut, amount: '2000000', minimumAmount: '1990000' },
    },
    swapTransaction: { to: router, from: wallet, data: '0x12345678', value: '0', chainId: 143, gasLimit: '300000' },
    ...overrides,
  };
}

describe('Uniswap quote validation', () => {
  it('accepts a mainnet exact-input v4 quote bound to the requested wallet and router', () => {
    const result = parseUniswapQuote(quotePayload(), wallet);
    expect(result.minimumOutputAmount).toBe('1990000');
    expect(result.transaction.chainId).toBe(143);
    expect(result.transaction.to.toLowerCase()).toBe(router);
  });

  it('rejects non-classic routes that would require a different signing flow', () => {
    expect(() => parseUniswapQuote(quotePayload({ routing: 'DUTCH_V3' }), wallet)).toThrow(/only a direct Uniswap AMM swap/);
  });

  it('rejects unverified transaction targets and mismatched senders', () => {
    expect(() => parseUniswapQuote(quotePayload({ swapTransaction: { to: tokenOut, from: wallet, data: '0x12345678', chainId: 143 } }), wallet)).toThrow(/router allowlist/);
    expect(() => parseUniswapQuote(quotePayload({ swapTransaction: { to: router, from: tokenOut, data: '0x12345678', chainId: 143 } }), wallet)).toThrow(/sender/);
  });

  it('rejects a Permit2 route instead of signing an unsupported typed-data message', () => {
    expect(() => parseUniswapQuote(quotePayload({ permitData: { domain: {} } }), wallet)).toThrow(/Permit2 signature flow/);
  });

  it('pins the API request to Monad mainnet, v4, and the requested pair', async () => {
    const env = validateEnv({ ...process.env, MONAD_NETWORK: 'mainnet', UNISWAP_API_KEY: 'test-key' });
    let sent: Record<string, unknown> | undefined;
    const fakeFetch: typeof fetch = async (_input, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(quotePayload()), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const result = await getUniswapQuote(env, { tokenIn, tokenOut, amountIn: 1_000_000n, swapper: wallet, slippageTolerance: 0.5 }, fakeFetch);
    expect(sent).toMatchObject({ tokenIn, tokenOut, tokenInChainId: 143, tokenOutChainId: 143, amount: '1000000', protocols: ['V4'] });
    expect(result.outputAmount).toBe('2000000');
  });

  it('refuses to use Uniswap on testnet in this mainnet adapter', async () => {
    const env = validateEnv({ ...process.env, MONAD_NETWORK: 'testnet', UNISWAP_API_KEY: 'test-key' });
    await expect(getUniswapQuote(env, { tokenIn, tokenOut, amountIn: 1n, swapper: wallet, slippageTolerance: 0.5 }, fetch)).rejects.toThrow(/mainnet only/);
  });
});
