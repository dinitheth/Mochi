import type { Env } from './env.js';

/**
 * Minimal HyperRPC client (Envio).
 *
 * HyperRPC is READ-ONLY and supports a small method set (chain/block/tx/
 * receipt/logs/traces) — it can never replace the full RPC for eth_call,
 * balances or gas estimation. Use it as a fast path for what it covers.
 * Calls are throttled client-side to respect token rate limits.
 */
let lastCallAt = 0;
const MIN_INTERVAL_MS = 300;

async function throttle(): Promise<void> {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

export function hyperRpcUrl(env: Env): string | null {
  return env.HYPER_RPC_URL && env.HYPER_RPC_URL.length > 0 ? env.HYPER_RPC_URL : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function hyperRpcCall(env: Env, method: string, params: unknown[] = []): Promise<any | null> {
  const url = hyperRpcUrl(env);
  if (!url) return null;
  await throttle();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: unknown; error?: unknown };
    if (data.error !== undefined && data.error !== null) return null;
    return data.result ?? null;
  } catch {
    return null;
  }
}

/** Fast-path receipt lookup. Null on any failure (caller falls back to full RPC). */
export async function hyperRpcReceipt(env: Env, txHash: string): Promise<{
  status?: string;
  blockNumber?: string;
  gasUsed?: string;
} | null> {
  return hyperRpcCall(env, 'eth_getTransactionReceipt', [txHash]);
}

/** Fast-path log scan over HyperRPC (eth_getLogs). Null on any failure. */
export async function hyperRpcLogs(
  env: Env,
  opts: { address?: string | string[]; topics?: Array<string | null>; fromBlock?: string; toBlock?: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[] | null> {
  const filter: Record<string, unknown> = {};
  if (opts.address) filter.address = opts.address;
  if (opts.topics) filter.topics = opts.topics;
  if (opts.fromBlock) filter.fromBlock = opts.fromBlock;
  if (opts.toBlock) filter.toBlock = opts.toBlock;
  const res = await hyperRpcCall(env, 'eth_getLogs', [filter]);
  return Array.isArray(res) ? res : null;
}
