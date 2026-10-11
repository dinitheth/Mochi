import type { Env } from '../config/env.js';

export interface MonadScreenToken {
  token_address: string;
  token_symbol?: string;
  token_name?: string;
  price_usd?: number;
  market_cap_usd?: number;
  liquidity_usd?: number;
  volume_usd?: number;
  buy_volume?: number;
  sell_volume?: number;
  price_change?: number;
  netflow_usd?: number;
}

export interface MonadFlowMetrics {
  public_figure_net_flow_usd?: number | null;
  public_figure_avg_flow_usd?: number | null;
  public_figure_wallet_count?: number | null;
  top_pnl_net_flow_usd?: number | null;
  top_pnl_avg_flow_usd?: number | null;
  top_pnl_wallet_count?: number | null;
  whale_net_flow_usd?: number | null;
  whale_avg_flow_usd?: number | null;
  whale_wallet_count?: number | null;
  smart_trader_net_flow_usd?: number | null;
  smart_trader_avg_flow_usd?: number | null;
  smart_trader_wallet_count?: number | null;
  exchange_net_flow_usd?: number | null;
  exchange_avg_flow_usd?: number | null;
  exchange_wallet_count?: number | null;
  fresh_wallets_net_flow_usd?: number | null;
  fresh_wallets_avg_flow_usd?: number | null;
  fresh_wallets_wallet_count?: number | null;
}

/** Read Nansen Token God Mode flow metrics for one Monad token. */
export async function fetchMonadTokenFlows(env: Env, tokenAddress: string): Promise<{ metrics: MonadFlowMetrics | null; warnings: string[] }> {
  if (!env.NANSEN_API_KEY) throw new Error('NANSEN_API_KEY is not configured.');
  const response = await fetch('https://api.nansen.ai/api/v1/tgm/flow-intelligence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.NANSEN_API_KEY },
    body: JSON.stringify({ chain: 'monad', token_address: tokenAddress, timeframe: '1d' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Nansen flow intelligence failed (HTTP ${response.status}).`);
  const payload = (await response.json()) as { data?: unknown; warnings?: unknown };
  const row = Array.isArray(payload.data) ? payload.data[0] : undefined;
  const warnings = Array.isArray(payload.warnings) ? payload.warnings.filter((value): value is string => typeof value === 'string') : [];
  if (!row || typeof row !== 'object') return { metrics: null, warnings };
  const item = row as Record<string, unknown>;
  const metrics: MonadFlowMetrics = {};
  for (const key of [
    'public_figure_net_flow_usd', 'public_figure_avg_flow_usd', 'public_figure_wallet_count',
    'top_pnl_net_flow_usd', 'top_pnl_avg_flow_usd', 'top_pnl_wallet_count',
    'whale_net_flow_usd', 'whale_avg_flow_usd', 'whale_wallet_count',
    'smart_trader_net_flow_usd', 'smart_trader_avg_flow_usd', 'smart_trader_wallet_count',
    'exchange_net_flow_usd', 'exchange_avg_flow_usd', 'exchange_wallet_count',
    'fresh_wallets_net_flow_usd', 'fresh_wallets_avg_flow_usd', 'fresh_wallets_wallet_count',
  ] as const) {
    const value = item[key];
    if (typeof value === 'number' && Number.isFinite(value)) metrics[key] = value;
    else if (value === null) metrics[key] = null;
  }
  return { metrics, warnings };
}

/** Fetch a small, bounded Monad token screen using Nansen's current API auth format. */
export async function fetchMonadTokenScreen(env: Env, limit: number): Promise<MonadScreenToken[]> {
  if (!env.NANSEN_API_KEY) throw new Error('NANSEN_API_KEY is not configured.');
  const response = await fetch('https://api.nansen.ai/api/v1/token-screener', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apiKey: env.NANSEN_API_KEY },
    body: JSON.stringify({ chains: ['monad'], timeframe: '24h', pagination: { page: 1, per_page: limit } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Nansen token screen failed (HTTP ${response.status}).`);
  const payload = (await response.json()) as { data?: unknown; tokens?: unknown; results?: unknown };
  const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.tokens) ? payload.tokens : Array.isArray(payload.results) ? payload.results : [];
  return rows.flatMap((row): MonadScreenToken[] => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    const address = item.token_address ?? item.address;
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) return [];
    const number = (...keys: string[]): number | undefined => {
      for (const key of keys) {
        const value = item[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
      }
      return undefined;
    };
    const string = (...keys: string[]): string | undefined => {
      for (const key of keys) if (typeof item[key] === 'string') return item[key] as string;
      return undefined;
    };
    return [{
      token_address: address,
      token_symbol: string('token_symbol', 'symbol'),
      token_name: string('token_name', 'name'),
      price_usd: number('price_usd', 'price'),
      market_cap_usd: number('market_cap_usd', 'market_cap'),
      liquidity_usd: number('liquidity_usd', 'liquidity'),
      volume_usd: number('volume_usd', 'volume'),
      price_change: number('price_change_24h', 'price_change'),
      buy_volume: number('buy_volume'),
      sell_volume: number('sell_volume'),
      netflow_usd: number('netflow_usd', 'netflow', 'net_flow'),
    }];
  }).slice(0, limit);
}
