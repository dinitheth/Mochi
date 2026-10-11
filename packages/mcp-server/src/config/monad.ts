import { createPublicClient, defineChain, http, type PublicClient } from 'viem';
import type { Env } from './env.js';

/**
 * Verified against https://docs.monad.xyz/developer-essentials/network-information
 * (mainnet) and .../testnet. Testnet canonical RPC is https://testnet-rpc.monad.xyz.
 */
export const monadMainnet = defineChain({
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.monad.xyz'] },
    public: { http: ['https://rpc.monad.xyz', 'https://rpc1.monad.xyz', 'https://rpc2.monad.xyz'] },
  },
  blockExplorers: {
    default: { name: 'Monadscan', url: 'https://monadscan.com' },
  },
});

export const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://testnet-rpc.monad.xyz'] },
    public: { http: ['https://testnet-rpc.monad.xyz', 'https://rpc-testnet.monadinfra.com'] },
  },
  blockExplorers: {
    default: { name: 'Monadscan Testnet', url: 'https://testnet.monadscan.com' },
  },
  testnet: true,
});

export const NETWORK_META = {
  mainnet: {
    chainId: 143,
    name: 'Monad',
    rpcUrl: 'https://rpc.monad.xyz',
    wsUrl: 'wss://rpc.monad.xyz',
    explorerUrl: 'https://monadscan.com',
    currency: 'MON',
    blockTimeMs: 400,
    finalityMs: 800,
    tps: 10000,
    faucet: null as string | null,
    wmon: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A' as const,
  },
  testnet: {
    chainId: 10143,
    name: 'Monad Testnet',
    rpcUrl: 'https://testnet-rpc.monad.xyz',
    wsUrl: 'wss://testnet-rpc.monad.xyz',
    explorerUrl: 'https://testnet.monadscan.com',
    currency: 'MON',
    blockTimeMs: 400,
    finalityMs: 800,
    tps: 10000,
    faucet: 'https://faucet.monad.xyz',
    wmon: '0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541' as const,
  },
} as const;

export type MonadNetwork = keyof typeof NETWORK_META;

export function getActiveNetwork(env: Env): MonadNetwork {
  return env.MONAD_NETWORK;
}

export function getChain(env: Env) {
  return env.MONAD_NETWORK === 'mainnet' ? monadMainnet : monadTestnet;
}

export function getRpcUrl(env: Env): string {
  if (env.MONAD_NETWORK === 'mainnet') return env.MONAD_MAINNET_RPC_URL;
  return env.MONAD_RPC_URL;
}

export function getExplorerUrl(env: Env): string {
  return NETWORK_META[env.MONAD_NETWORK].explorerUrl;
}

export function explorerTxUrl(env: Env, hash: string): string {
  return `${getExplorerUrl(env)}/tx/${hash}`;
}

export function explorerAddressUrl(env: Env, address: string): string {
  return `${getExplorerUrl(env)}/address/${address}`;
}

let cachedClient: PublicClient | null = null;
let cachedKey = '';

export function getPublicClient(env: Env): PublicClient {
  const rpcUrl = getRpcUrl(env);
  const key = `${env.MONAD_NETWORK}:${rpcUrl}`;
  if (cachedClient && cachedKey === key) return cachedClient;
  cachedClient = createPublicClient({
    chain: getChain(env),
    transport: http(rpcUrl, { batch: true }),
  }) as PublicClient;
  cachedKey = key;
  return cachedClient;
}
