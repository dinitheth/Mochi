import type { Env } from './env.js';

export interface MockToken {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}

export interface DexConfig {
  kind: 'microswap' | 'zerox';
  /** Default router/pool address. Null when none is configured. */
  router: `0x${string}` | null;
  mockTokens: MockToken[];
}

/** Deployed by `packages/contracts` — see deployments/testnet.json. */
const MICROSWAP_TESTNET_POOL = '0x32a7e7fd328dc09149fc495921dc43ae97c39f6f' as const;

export function getDexConfig(env: Env): DexConfig {
  if (env.MONAD_NETWORK === 'mainnet') {
    return { kind: 'zerox', router: null, mockTokens: [] };
  }
  const pool = (env.MICROSWAP_POOL_ADDRESS || MICROSWAP_TESTNET_POOL) as `0x${string}`;
  return {
    kind: 'microswap',
    router: pool,
    mockTokens: [
      { symbol: 'TTA', address: '0x1A366BBf1635D9bE4640afa24Eb10755cE684C20', decimals: 18 },
      { symbol: 'TTB', address: '0x27827700be5102192e6ccbd1d202f7c8508a6c47', decimals: 18 },
    ],
  };
}

/** Resolve a mock token by symbol or address (testnet only). Null when unknown. */
export function resolveMockToken(env: Env, id: string): MockToken | null {
  const cfg = getDexConfig(env);
  const lower = id.toLowerCase();
  return cfg.mockTokens.find((t) => t.symbol.toLowerCase() === lower || t.address.toLowerCase() === lower) ?? null;
}
