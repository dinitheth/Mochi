import { getAddress, isAddress } from 'viem';
import type { Env } from '../config/env.js';

/** Canonical 0x AllowanceHolder for Monad (chain 143), per the 0x contract docs. */
export const ZEROEX_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734' as const;
/** 0x standard native-token sentinel used for MON on Monad. */
export const ZEROEX_NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as const;

export interface ZeroExSwapQuote {
  allowanceTarget: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  minBuyAmount: string;
  liquidityAvailable: boolean;
  issues?: {
    allowance?: { spender?: string; actual?: string | null } | null;
    balance?: { token?: string; actual?: string; expected?: string } | null;
    simulationIncomplete?: boolean;
  };
  transaction: {
    to: string;
    data: string;
    value?: string;
    gas?: string;
    gasPrice?: string;
  };
  route?: {
    fills?: Array<{ source?: string; proportionBps?: string | null }>;
  };
}

function requireUnsignedInteger(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`0x returned an invalid ${field}.`);
  }
  return value;
}

function requireAddress(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new Error(`0x returned an invalid ${field} address.`);
  }
  return getAddress(value);
}

/**
 * Request a firm, exact-input swap quote from 0x's Monad AllowanceHolder API.
 * We intentionally do not accept an arbitrary router or Permit2 mode here.
 */
export async function getZeroExSwapQuote(
  env: Env,
  input: {
    sellToken: `0x${string}`;
    buyToken: `0x${string}`;
    sellAmount: bigint;
    taker: `0x${string}`;
    slippageBps: number;
  },
): Promise<ZeroExSwapQuote> {
  if (!env.OX_API_KEY) throw new Error('Set OX_API_KEY to enable 0x swaps on Monad mainnet.');

  const params = new URLSearchParams({
    chainId: '143',
    sellToken: input.sellToken,
    buyToken: input.buyToken,
    sellAmount: input.sellAmount.toString(),
    taker: input.taker,
    slippageBps: String(input.slippageBps),
  });

  const response = await fetch(`https://api.0x.org/swap/allowance-holder/quote?${params}`, {
    headers: { '0x-api-key': env.OX_API_KEY, '0x-version': 'v2', accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const detail = typeof payload?.reason === 'string' ? payload.reason :
      typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`;
    throw new Error(`0x quote failed: ${detail}`);
  }
  if (!payload || typeof payload !== 'object') throw new Error('0x returned an empty quote.');
  if (payload.liquidityAvailable !== true) throw new Error('0x reports no available liquidity for this token pair.');

  const tx = payload.transaction as Record<string, unknown> | undefined;
  if (!tx || typeof tx !== 'object') throw new Error('0x quote did not include a transaction.');
  const allowanceTarget = requireAddress(payload.allowanceTarget, 'allowance target');
  if (allowanceTarget.toLowerCase() !== ZEROEX_ALLOWANCE_HOLDER.toLowerCase()) {
    throw new Error('0x returned an unexpected approval target; no transaction was sent.');
  }
  const issues = payload.issues as ZeroExSwapQuote['issues'];
  const issueSpender = issues?.allowance?.spender;
  if (issueSpender && requireAddress(issueSpender, 'allowance spender').toLowerCase() !== ZEROEX_ALLOWANCE_HOLDER.toLowerCase()) {
    throw new Error('0x returned an unexpected allowance spender; no transaction was sent.');
  }
  const transaction = {
    to: requireAddress(tx.to, 'transaction target'),
    data: typeof tx.data === 'string' && /^0x[0-9a-fA-F]+$/.test(tx.data) ? tx.data : '',
    ...(tx.value !== undefined ? { value: requireUnsignedInteger(tx.value, 'transaction value') } : {}),
    ...(tx.gas !== undefined ? { gas: requireUnsignedInteger(tx.gas, 'transaction gas') } : {}),
    ...(tx.gasPrice !== undefined ? { gasPrice: requireUnsignedInteger(tx.gasPrice, 'transaction gas price') } : {}),
  };
  if (!transaction.data || transaction.data.length < 10) throw new Error('0x returned empty or malformed transaction calldata.');
  // ERC-20 AllowanceHolder quotes execute at the same target they approve.
  // This adapter does not accept native-MON sell-token quotes (which may use Settler).
  if (transaction.to.toLowerCase() !== ZEROEX_ALLOWANCE_HOLDER.toLowerCase()) {
    throw new Error('0x returned an unexpected transaction target for the AllowanceHolder flow.');
  }

  const sellToken = requireAddress(payload.sellToken, 'sell token');
  const buyToken = requireAddress(payload.buyToken, 'buy token');
  if (sellToken.toLowerCase() !== input.sellToken.toLowerCase() || buyToken.toLowerCase() !== input.buyToken.toLowerCase()) {
    throw new Error('0x quote token pair did not match the requested pair.');
  }
  const sellAmount = requireUnsignedInteger(payload.sellAmount, 'sell amount');
  if (sellAmount !== input.sellAmount.toString()) throw new Error('0x quote amount did not match the requested amount.');

  return {
    allowanceTarget,
    sellToken,
    buyToken,
    sellAmount,
    buyAmount: requireUnsignedInteger(payload.buyAmount, 'buy amount'),
    minBuyAmount: requireUnsignedInteger(payload.minBuyAmount, 'minimum buy amount'),
    liquidityAvailable: true,
    ...(issues ? { issues } : {}),
    transaction,
    ...(payload.route && typeof payload.route === 'object' ? { route: payload.route as ZeroExSwapQuote['route'] } : {}),
  };
}
