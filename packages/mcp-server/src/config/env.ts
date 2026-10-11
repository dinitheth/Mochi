import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import dotenv from 'dotenv';

// 1. Normal lookup: process.cwd()/.env (covers Codex/Claude launches with cwd set).
dotenv.config();
// 2. Fallback: repo-root .env resolved relative to this module, so the server
// finds its keys no matter which working directory it was spawned from
// (e.g. an agent hand-rolling its own MCP client via shell).
// src/config/env.ts -> ../../../../.env ; dist/config/env.js -> ../../../../.env
try {
  const here = dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: resolve(here, '..', '..', '..', '..', '.env') });
} catch {
  /* dotenv never overrides already-set vars, so this is purely additive */
}

const envSchema = z.object({
  PRIVY_APP_ID: z.string().default(''),
  PRIVY_APP_SECRET: z.string().default(''),
  DEV_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().or(z.literal('')),
  AGENT_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().or(z.literal('')),
  MONAD_NETWORK: z.enum(['mainnet', 'testnet']).default('testnet'),
  MONAD_RPC_URL: z.string().url().default('https://testnet-rpc.monad.xyz'),
  MONAD_MAINNET_RPC_URL: z.string().url().default('https://rpc.monad.xyz'),
  SPENDING_LIMIT_WEI: z.string().default('1000000000000000000'),
  APPROVAL_WEBHOOK_URL: z.string().default('http://localhost:3001/api/approvals'),
  APPROVAL_API_TOKEN: z.string().default(''),
  APPROVAL_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(3002),
  NANSEN_API_KEY: z.string().default(''),
  ZERION_API_KEY: z.string().default(''),
  OX_API_KEY: z.string().default(''),
  OPENSEA_API_KEY: z.string().default(''),
  MICROSWAP_POOL_ADDRESS: z.string().default(''),
  MOCK_NFT_ADDRESS: z.string().default(''),
  MICROMARKET_ADDRESS: z.string().default(''),
  AUCTION_HOUSE_ADDRESS: z.string().default(''),
  LENDING_POOL_ADDRESS: z.string().default(''),
  HYPER_RPC_URL: z.string().default(''),
  HYPERSYNC_URL: z.string().default('https://monad-testnet.hypersync.xyz'),
  HYPERSYNC_TOKEN: z.string().default(''),
});

export type Env = z.infer<typeof envSchema> & {
  /** true when Privy server credentials are present */
  privyConfigured: boolean;
  /** bigint view of the spending limit */
  spendingLimitWei: bigint;
};

export function validateEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.parse({
    PRIVY_APP_ID: raw.PRIVY_APP_ID,
    PRIVY_APP_SECRET: raw.PRIVY_APP_SECRET,
    DEV_PRIVATE_KEY: raw.DEV_PRIVATE_KEY,
    AGENT_ADDRESS: raw.AGENT_ADDRESS,
    MONAD_NETWORK: raw.MONAD_NETWORK,
    MONAD_RPC_URL: raw.MONAD_RPC_URL,
    MONAD_MAINNET_RPC_URL: raw.MONAD_MAINNET_RPC_URL,
    SPENDING_LIMIT_WEI: raw.SPENDING_LIMIT_WEI,
    APPROVAL_WEBHOOK_URL: raw.APPROVAL_WEBHOOK_URL,
    APPROVAL_API_TOKEN: raw.APPROVAL_API_TOKEN,
    APPROVAL_POLL_TIMEOUT_MS: raw.APPROVAL_POLL_TIMEOUT_MS,
    MCP_TRANSPORT: raw.MCP_TRANSPORT,
    MCP_HTTP_PORT: raw.MCP_HTTP_PORT,
    NANSEN_API_KEY: raw.NANSEN_API_KEY,
    ZERION_API_KEY: raw.ZERION_API_KEY,
    OX_API_KEY: raw.OX_API_KEY,
    OPENSEA_API_KEY: raw.OPENSEA_API_KEY,
    MICROSWAP_POOL_ADDRESS: raw.MICROSWAP_POOL_ADDRESS,
    MOCK_NFT_ADDRESS: raw.MOCK_NFT_ADDRESS,
    MICROMARKET_ADDRESS: raw.MICROMARKET_ADDRESS,
    AUCTION_HOUSE_ADDRESS: raw.AUCTION_HOUSE_ADDRESS,
    LENDING_POOL_ADDRESS: raw.LENDING_POOL_ADDRESS,
    HYPER_RPC_URL: raw.HYPER_RPC_URL,
    HYPERSYNC_URL: raw.HYPERSYNC_URL,
    HYPERSYNC_TOKEN: raw.HYPERSYNC_TOKEN,
  });

  const privyConfigured =
    parsed.PRIVY_APP_ID.length > 0 &&
    !parsed.PRIVY_APP_ID.startsWith('your_') &&
    parsed.PRIVY_APP_SECRET.length > 0 &&
    !parsed.PRIVY_APP_SECRET.startsWith('your_');

  let spendingLimitWei = 1000000000000000000n;
  try {
    spendingLimitWei = BigInt(parsed.SPENDING_LIMIT_WEI);
  } catch {
    spendingLimitWei = 1000000000000000000n;
  }

  return { ...parsed, privyConfigured, spendingLimitWei };
}
