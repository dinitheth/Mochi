import { getAddress, isAddress } from 'viem';
import type { Env } from '../config/env.js';

const API = 'https://trade-api.gateway.uniswap.org/v1';
const MONAD_CHAIN_ID = 143;
export const UNISWAP_APPROVAL_PROXY = '0x0000000085E102724e78eCd2F45DC9cA239Affad' as const;
const SWAP_TARGETS = new Set([
  UNISWAP_APPROVAL_PROXY.toLowerCase(),
  '0xa6ce4f10d83dbdda c17e68e1837ca9ce6a1b596e'.replaceAll(' ', ''),
  '0x0d97dc33264bfc1c226207428a79b26757fb9dc3',
]);

export interface UniswapQuoteInput {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  swapper: `0x${string}`;
  slippageTolerance: number;
}

export interface ApiTransaction {
  to: `0x${string}`;
  from: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  gas?: bigint;
  chainId: number;
}

export interface UniswapQuote {
  quote: Record<string, unknown>;
  routing: string;
  outputAmount: string;
  minimumOutputAmount: string;
  transaction: ApiTransaction;
  requestId?: string;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Uniswap returned an invalid ${field}.`);
  return value as Record<string, unknown>;
}

function address(value: unknown, field: string): `0x${string}` {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error(`Uniswap returned an invalid ${field} address.`);
  return getAddress(value);
}

function uint(value: unknown, field: string): bigint {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) {
    throw new Error(`Uniswap returned an invalid ${field}.`);
  }
  return BigInt(value);
}

function parseTransaction(value: unknown, swapper: `0x${string}`, allowedTargets: Set<string> | null = SWAP_TARGETS): ApiTransaction {
  const tx = record(value, 'transaction');
  const to = address(tx.to, 'transaction target');
  if (allowedTargets && !allowedTargets.has(to.toLowerCase())) throw new Error(`Uniswap returned unverified transaction target ${to}; Mochi refused to use it because it is outside the verified Monad router allowlist.`);
  const from = address(tx.from, 'transaction sender');
  if (from.toLowerCase() !== swapper.toLowerCase()) throw new Error('Uniswap transaction sender does not match the connected wallet.');
  const chainId = Number(tx.chainId);
  if (chainId !== MONAD_CHAIN_ID) throw new Error(`Uniswap transaction uses chain ${chainId}; expected Monad mainnet (143).`);
  if (typeof tx.data !== 'string' || !/^0x[0-9a-fA-F]{8,}$/.test(tx.data)) throw new Error('Uniswap returned malformed transaction calldata.');
  return {
    to,
    from,
    data: tx.data as `0x${string}`,
    value: uint(tx.value ?? '0', 'transaction value'),
    ...(tx.gasLimit !== undefined ? { gas: uint(tx.gasLimit, 'gas limit') } : {}),
    chainId,
  };
}

async function post(env: Env, endpoint: string, body: unknown, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  if (!env.UNISWAP_API_KEY) throw new Error('Set UNISWAP_API_KEY to enable the Uniswap Trading API.');
  const response = await fetcher(`${API}/${endpoint}`, {
    method: 'POST',
    headers: {
      'x-api-key': env.UNISWAP_API_KEY,
      'x-permit2-disabled': 'true',
      'x-universal-router-version': '2.1.2',
      'x-agent-info': JSON.stringify({ decision_origin: 'human_mediated', integration_name: 'Mochi', version: '1.0.0' }),
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && typeof payload === 'object'
      ? String((payload as Record<string, unknown>).detail ?? (payload as Record<string, unknown>).message ?? `HTTP ${response.status}`)
      : `HTTP ${response.status}`;
    throw new Error(`Uniswap ${endpoint} failed: ${detail}`);
  }
  return record(payload, `${endpoint} response`);
}

export function parseUniswapQuote(payload: Record<string, unknown>, swapper: `0x${string}`): UniswapQuote {
  const quote = record(payload.quote, 'quote');
  const routing = String(payload.routing ?? '');
  // This adapter deliberately stays on Uniswap AMM v4. UniswapX orders need
  // off-chain order signing and are a separate flow with different guarantees.
  if (routing !== 'CLASSIC') throw new Error(`Uniswap returned ${routing || 'an unknown route'}; Mochi currently permits only a direct Uniswap AMM swap.`);
  if (payload.permitData !== null && payload.permitData !== undefined) throw new Error('Uniswap returned a Permit2 signature flow; Mochi only supports the explicit on-chain approval flow.');
  const input = record(quote.input, 'quote input');
  const output = record(quote.output, 'quote output');
  const tx = parseTransaction(payload.swapTransaction, swapper);
  const quotedInput = uint(input.amount, 'input amount');
  if (quotedInput <= 0n) throw new Error('Uniswap quote input must be greater than zero.');
  const outputAmount = uint(output.amount, 'output amount');
  const minimumOutputAmount = uint(output.minimumAmount, 'minimum output amount');
  if (outputAmount <= 0n || minimumOutputAmount <= 0n || minimumOutputAmount > outputAmount) {
    throw new Error('Uniswap returned invalid output amounts.');
  }
  return {
    quote,
    routing,
    outputAmount: outputAmount.toString(),
    minimumOutputAmount: minimumOutputAmount.toString(),
    transaction: tx,
    ...(typeof payload.requestId === 'string' ? { requestId: payload.requestId } : {}),
  };
}

export async function getUniswapQuote(
  env: Env,
  input: UniswapQuoteInput,
  fetcher: typeof fetch = fetch,
): Promise<UniswapQuote> {
  if (env.MONAD_NETWORK !== 'mainnet') throw new Error('Uniswap Trading API integration is enabled for Monad mainnet only.');
  if (input.amountIn <= 0n) throw new Error('Swap amount must be greater than zero.');
  if (input.tokenIn.toLowerCase() === input.tokenOut.toLowerCase()) throw new Error('Input and output tokens must differ.');
  if (!Number.isFinite(input.slippageTolerance) || input.slippageTolerance < 0 || input.slippageTolerance > 5) {
    throw new Error('Slippage tolerance must be between 0 and 5 percent.');
  }
  const payload = await post(env, 'quote', {
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    tokenInChainId: MONAD_CHAIN_ID,
    tokenOutChainId: MONAD_CHAIN_ID,
    type: 'EXACT_INPUT',
    amount: input.amountIn.toString(),
    swapper: input.swapper,
    slippageTolerance: input.slippageTolerance,
    protocols: ['V4'],
  }, fetcher);
  const result = parseUniswapQuote(payload, input.swapper);
  const quotedInput = uint(record(result.quote.input, 'quote input').amount, 'input amount');
  if (quotedInput !== input.amountIn) throw new Error('Uniswap quote amount does not match the requested input.');
  if (String(record(result.quote.input, 'quote input').token).toLowerCase() !== input.tokenIn.toLowerCase() ||
      String(record(result.quote.output, 'quote output').token).toLowerCase() !== input.tokenOut.toLowerCase()) {
    throw new Error('Uniswap quote token pair does not match the requested pair.');
  }
  return result;
}

export async function buildUniswapSwapTransaction(
  env: Env,
  quote: UniswapQuote,
  swapper: `0x${string}`,
  fetcher: typeof fetch = fetch,
): Promise<ApiTransaction> {
  const payload = await post(env, 'swap', {
    quote: quote.quote,
    permitData: null,
    safetyMode: 'SAFE',
    simulateTransaction: true,
    refreshGasPrice: true,
  }, fetcher);
  return parseTransaction(record(payload.swap, 'swap transaction'), swapper);
}

export async function getUniswapApproval(
  env: Env,
  input: { token: `0x${string}`; tokenOut: `0x${string}`; amount: bigint; wallet: `0x${string}` },
  fetcher: typeof fetch = fetch,
): Promise<{ approval: ApiTransaction | null; cancel: ApiTransaction | null }> {
  const payload = await post(env, 'check_approval', {
    walletAddress: input.wallet,
    token: input.token,
    amount: input.amount.toString(),
    chainId: MONAD_CHAIN_ID,
    tokenOut: input.tokenOut,
    tokenOutChainId: MONAD_CHAIN_ID,
  }, fetcher);
  const convert = (raw: unknown, field: string): ApiTransaction | null => {
    if (raw === null || raw === undefined) return null;
    const tx = parseTransaction(raw, input.wallet, null);
    if (tx.to.toLowerCase() !== input.token.toLowerCase()) throw new Error(`Uniswap ${field} transaction does not target the input token.`);
    if (tx.data.slice(0, 10).toLowerCase() !== '0x095ea7b3') throw new Error(`Uniswap ${field} transaction is not an ERC-20 approval.`);
    return tx;
  };
  return { approval: convert(payload.approval, 'approval'), cancel: convert(payload.cancel, 'approval reset') };
}
