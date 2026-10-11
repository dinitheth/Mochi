import type { Env } from './env.js';

export interface HyperSyncLog {
  address: string;
  topic0: string | null;
  topic1?: string | null;
  topic2?: string | null;
  topic3?: string | null;
  data: string;
  block_number: number;
  transaction_hash: string;
}

/**
 * Minimal HyperSync client (Envio) for full-history log scans.
 *
 * HyperSync answers in seconds what paginated RPC logs do in minutes, but it
 * needs a token (HYPERSYNC_TOKEN) and a resolvable data-plane host. Any
 * failure returns null so callers fall back to RPC eth_getLogs.
 */
export async function hyperSyncLogs(
  env: Env,
  opts: { address: string | string[]; topics?: string[]; fromBlock: number; toBlock?: number },
): Promise<{ logs: HyperSyncLog[]; nextBlock: number; archiveHeight: number } | null> {
  if (!env.HYPERSYNC_TOKEN) return null;
  const addresses = Array.isArray(opts.address) ? opts.address : [opts.address];
  const body = {
    from_block: opts.fromBlock,
    ...(opts.toBlock !== undefined ? { to_block: opts.toBlock } : {}),
    logs: [{ address: addresses, ...(opts.topics ? { topics: [opts.topics] } : {}) }],
    join_mode: 'JoinNothing',
    field_selection: {
      log: ['address', 'topic0', 'topic1', 'topic2', 'topic3', 'data', 'block_number', 'transaction_hash'],
    },
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(`${env.HYPERSYNC_URL.replace(/\/$/, '')}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.HYPERSYNC_TOKEN}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { logs?: HyperSyncLog[] }; next_block?: number; archive_height?: number };
    return {
      logs: data?.data?.logs ?? [],
      nextBlock: data?.next_block ?? opts.fromBlock,
      archiveHeight: data?.archive_height ?? 0,
    };
  } catch {
    return null;
  }
}
