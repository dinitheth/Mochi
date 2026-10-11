import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AutoPolicy {
  /** Master switch. Default false — human approval required. */
  autoApprove: boolean;
  /** Max single-transaction value (wei, decimal string) auto-approved. */
  maxWei: string;
  /** Null = all actions eligible; otherwise only listed action names. */
  actions: string[] | null;
  updatedAt: string;
}

const DEFAULTS: AutoPolicy = {
  autoApprove: false,
  maxWei: '100000000000000000',
  actions: null,
  updatedAt: new Date(0).toISOString(),
};

type Store = Record<string, AutoPolicy>;

function storePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'policy.json');
}

async function readStore(): Promise<Store> {
  try {
    return JSON.parse(await fs.readFile(storePath(), 'utf8')) as Store;
  } catch {
    return {};
  }
}

export function normalizeUser(userId?: string): string {
  return (userId ?? 'default').toLowerCase();
}

export async function getPolicy(userId?: string): Promise<AutoPolicy> {
  const store = await readStore();
  return { ...DEFAULTS, ...(store[normalizeUser(userId)] ?? {}) };
}

export async function setPolicy(
  userId: string | undefined,
  patch: Partial<Pick<AutoPolicy, 'autoApprove' | 'maxWei' | 'actions'>>,
): Promise<AutoPolicy> {
  if (patch.maxWei !== undefined) {
    try {
      const v = BigInt(patch.maxWei);
      if (v < 0n) throw new Error('negative');
    } catch {
      throw new Error(`Invalid maxWei "${patch.maxWei}" — must be a non-negative integer wei string.`);
    }
  }
  const store = await readStore();
  const u = normalizeUser(userId);
  const next: AutoPolicy = {
    ...DEFAULTS,
    ...(store[u] ?? {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  store[u] = next;
  await fs.writeFile(storePath(), JSON.stringify(store, null, 2), 'utf8');
  return next;
}

/** True when this action may skip human approval under the user's policy. */
export function policyAllows(policy: AutoPolicy, action: string, valueWei: bigint): boolean {
  if (!policy.autoApprove) return false;
  if (policy.actions !== null && !policy.actions.includes(action)) return false;
  try {
    return valueWei <= BigInt(policy.maxWei);
  } catch {
    return false;
  }
}
