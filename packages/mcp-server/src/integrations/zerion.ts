import type { Env } from '../config/env.js';

export interface ZerionTokenPosition {
  quantity: string | null;
  value: number | null;
  symbol: string | null;
}

function headers(env: Env): Record<string, string> | null {
  if (!env.ZERION_API_KEY) return null;
  return {
    Authorization: `Basic ${Buffer.from(`${env.ZERION_API_KEY}:`).toString('base64')}`,
    accept: 'application/json',
  };
}

/** Find a specific Monad token in Zerion's wallet fungible positions. */
export async function fetchZerionMonadTokenPosition(
  env: Env,
  walletAddress: string,
  tokenAddress: string,
): Promise<ZerionTokenPosition | null> {
  const auth = headers(env);
  if (!auth) return null;
  const params = new URLSearchParams({ 'filter[chain_ids]': 'monad', currency: 'usd', 'page[size]': '100' });
  const response = await fetch(`https://api.zerion.io/v1/wallets/${walletAddress}/positions/?${params.toString()}`, {
    headers: auth,
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 202 || response.status === 402) return null;
  if (!response.ok) throw new Error(`Zerion wallet positions failed (HTTP ${response.status}).`);
  const payload = (await response.json()) as {
    data?: Array<{
      attributes?: {
        quantity?: { numeric?: string; decimals?: number };
        value?: number;
        fungible_info?: { symbol?: string; implementations?: Array<{ chain_id?: string; address?: string }> };
      };
    }>;
  };
  const row = payload.data?.find((position) =>
    position.attributes?.fungible_info?.implementations?.some((implementation) =>
      implementation.chain_id === 'monad' && implementation.address?.toLowerCase() === tokenAddress.toLowerCase(),
    ),
  );
  if (!row?.attributes) return null;
  const quantity = row.attributes.quantity?.numeric;
  const value = row.attributes.value;
  return {
    quantity: typeof quantity === 'string' ? quantity : null,
    value: typeof value === 'number' && Number.isFinite(value) ? value : null,
    symbol: row.attributes.fungible_info?.symbol ?? null,
  };
}
