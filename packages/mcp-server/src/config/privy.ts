import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Env } from './env.js';

export interface StoredWallet {
  userId: string;
  walletId: string;
  address: string;
  network: string;
  createdAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

let privyClient: AnyClient | null | undefined;

const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'wallet-state.json');

async function readState(): Promise<Record<string, StoredWallet>> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(raw) as Record<string, StoredWallet>;
  } catch {
    return {};
  }
}

async function writeState(state: Record<string, StoredWallet>): Promise<void> {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** Lazily create the Privy server client. Returns null when not configured. */
export async function getPrivyClient(env: Env): Promise<AnyClient | null> {
  if (!env.privyConfigured) return null;
  if (privyClient !== undefined) return privyClient;
  try {
    const mod = await import('@privy-io/server-auth');
    const PrivyClient = mod.PrivyClient;
    privyClient = new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);
    return privyClient;
  } catch (err) {
    console.error('[privy] failed to init PrivyClient:', err instanceof Error ? err.message : err);
    privyClient = null;
    return null;
  }
}

/** Resolve the local-dev signer account (DEV_PRIVATE_KEY or ephemeral). */
export function getLocalAccount(env: Env) {
  const key = env.DEV_PRIVATE_KEY && env.DEV_PRIVATE_KEY.length > 0 ? (env.DEV_PRIVATE_KEY as `0x${string}`) : null;
  if (key) return privateKeyToAccount(key);
  // Ephemeral key is NOT persisted — only for read-path demos. Persist if needed via DEV_PRIVATE_KEY.
  return privateKeyToAccount(generatePrivateKey());
}

export function getLocalAddress(env: Env): string {
  if (env.DEV_PRIVATE_KEY) return privateKeyToAccount(env.DEV_PRIVATE_KEY as `0x${string}`).address;
  if (env.AGENT_ADDRESS) return env.AGENT_ADDRESS;
  return '';
}

/**
 * Create (or load) an agent wallet for a userId.
 * - With Privy configured: creates a server/embedded Ethereum wallet owned by the app and persists the mapping.
 * - Without Privy: falls back to DEV_PRIVATE_KEY / AGENT_ADDRESS so the demo still works read-only.
 */
export async function createOrLoadWallet(
  env: Env,
  userId: string,
): Promise<{ wallet: StoredWallet; isNew: boolean; mode: 'privy' | 'local' | 'readonly' }> {
  const state = await readState();
  const existing = state[userId];
  if (existing) {
    const mode = existing.walletId.startsWith('local:') ? 'local' : existing.walletId.startsWith('readonly:') ? 'readonly' : 'privy';
    return { wallet: existing, isNew: false, mode: mode as 'privy' | 'local' | 'readonly' };
  }

  const privy = await getPrivyClient(env);
  if (privy) {
    try {
      // @privy-io/server-auth: walletApi.createWallet({ chainType: 'ethereum' })
      const created = await privy.walletApi.createWallet({ chainType: 'ethereum' });
      const wallet: StoredWallet = {
        userId,
        walletId: created.id ?? created.walletId ?? `privy:${Date.now()}`,
        address: created.address as string,
        network: env.MONAD_NETWORK,
        createdAt: new Date().toISOString(),
      };
      state[userId] = wallet;
      await writeState(state);
      return { wallet, isNew: true, mode: 'privy' };
    } catch (err) {
      console.error('[privy] createWallet failed, falling back:', err instanceof Error ? err.message : err);
    }
  }

  if (env.DEV_PRIVATE_KEY) {
    const account = privateKeyToAccount(env.DEV_PRIVATE_KEY as `0x${string}`);
    const wallet: StoredWallet = {
      userId,
      walletId: `local:${account.address}`,
      address: account.address,
      network: env.MONAD_NETWORK,
      createdAt: new Date().toISOString(),
    };
    state[userId] = wallet;
    await writeState(state);
    return { wallet, isNew: true, mode: 'local' };
  }

  if (env.AGENT_ADDRESS) {
    const wallet: StoredWallet = {
      userId,
      walletId: `readonly:${env.AGENT_ADDRESS}`,
      address: env.AGENT_ADDRESS,
      network: env.MONAD_NETWORK,
      createdAt: new Date().toISOString(),
    };
    state[userId] = wallet;
    await writeState(state);
    return { wallet, isNew: true, mode: 'readonly' };
  }

  // Last resort: ephemeral local account (read-only demo).
  const ephemeral = privateKeyToAccount(generatePrivateKey());
  const wallet: StoredWallet = {
    userId,
    walletId: `readonly:${ephemeral.address}`,
    address: ephemeral.address,
    network: env.MONAD_NETWORK,
    createdAt: new Date().toISOString(),
  };
  state[userId] = wallet;
  await writeState(state);
  return { wallet, isNew: true, mode: 'readonly' };
}

export async function getStoredWallet(userId: string): Promise<StoredWallet | null> {
  const state = await readState();
  return state[userId] ?? null;
}

export async function getDefaultWallet(_env: Env): Promise<StoredWallet | null> {
  const state = await readState();
  const keys = Object.keys(state);
  if (keys.length === 0) return null;
  return state[keys[0]];
}

export async function importWalletRecord(
  userId: string,
  address: string,
  walletId: string,
  network: string,
): Promise<StoredWallet> {
  const state = await readState();
  const wallet: StoredWallet = { userId, walletId, address, network, createdAt: new Date().toISOString() };
  state[userId] = wallet;
  await writeState(state);
  return wallet;
}

/**
 * Send a transaction through Privy (when available) or throw a helpful error
 * telling the operator to set DEV_PRIVATE_KEY for local signing.
 * Omit `to` for contract deployment (creation transaction).
 */
export async function privySendTransaction(
  env: Env,
  wallet: StoredWallet,
  tx: { to?: `0x${string}`; value?: bigint; data?: `0x${string}` },
): Promise<`0x${string}`> {
  const privy = await getPrivyClient(env);
  if (privy && !wallet.walletId.startsWith('local:') && !wallet.walletId.startsWith('readonly:')) {
    // Exact shape per @privy-io/server-auth 1.x:
    //   walletApi.ethereum.sendTransaction({ walletId, caip2, transaction }) -> { hash, caip2 }
    const caip2 = `eip155:${env.MONAD_NETWORK === 'mainnet' ? 143 : 10143}`;
    const payload = {
      walletId: wallet.walletId,
      caip2,
      transaction: {
        ...(tx.to ? { to: tx.to } : {}),
        ...(tx.value !== undefined ? { value: `0x${tx.value.toString(16)}` } : {}),
        ...(tx.data ? { data: tx.data } : {}),
      },
    };
    // The Privy API can be slow/flaky from some networks: retry timeout-type
    // failures a few times with backoff before giving up.
    const delaysMs = [2000, 5000, 10000];
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
      try {
        const res = (await privy.walletApi.ethereum.sendTransaction(payload)) as { hash?: string };
        if (!res?.hash || typeof res.hash !== 'string') {
          throw new Error('Privy returned no transaction hash.');
        }
        return res.hash as `0x${string}`;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        const retryable = /timeout|aborted|econnreset|etimedout|enotfound|eai_again|socket|network|fetch failed/i.test(msg);
        if (!retryable || attempt === delaysMs.length) break;
        console.error(`[privy] send attempt ${attempt + 1} failed (${msg}); retrying in ${delaysMs[attempt]}ms…`);
        await new Promise((r) => setTimeout(r, delaysMs[attempt]));
      }
    }
    throw new Error(
      `Privy signing failed${lastErr instanceof Error ? `: ${lastErr.message}` : ''}. ` +
        'Ensure the wallet exists in your Privy app and the server wallet / authorization-key policy allows it.',
    );
  }

  if (wallet.walletId.startsWith('local:') && env.DEV_PRIVATE_KEY) {
    const { createWalletClient, http } = await import('viem');
    const { monadTestnet, monadMainnet, getRpcUrl } = await import('./monad.js');
    const account = privateKeyToAccount(env.DEV_PRIVATE_KEY as `0x${string}`);
    const chain = env.MONAD_NETWORK === 'mainnet' ? monadMainnet : monadTestnet;
    const client = createWalletClient({ account, chain, transport: http(getRpcUrl(env)) });
    if (!tx.to) {
      if (!tx.data) throw new Error('Deployment needs creation bytecode in `data`.');
      return client.deployContract({ abi: [], bytecode: tx.data, args: [] }) as unknown as `0x${string}`;
    }
    return client.sendTransaction({ to: tx.to, value: tx.value ?? 0n, ...(tx.data ? { data: tx.data } : {}) });
  }

  throw new Error(
    'No signer available. Set PRIVY_APP_ID/PRIVY_APP_SECRET (production) or DEV_PRIVATE_KEY (local dev) to enable transaction signing.',
  );
}
