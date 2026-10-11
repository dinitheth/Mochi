import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface AutoPolicy {
  autoApprove: boolean;
  maxWei: string;
  actions: string[] | null;
  updatedAt: string;
}

const DEFAULTS: AutoPolicy = {
  autoApprove: false,
  maxWei: '100000000000000000',
  actions: null,
  updatedAt: new Date(0).toISOString(),
};

function storePath(): string {
  return join(process.cwd(), '..', 'mcp-server', 'policy.json');
}

async function readStore(): Promise<Record<string, AutoPolicy>> {
  try {
    return JSON.parse(await fs.readFile(storePath(), 'utf8')) as Record<string, AutoPolicy>;
  } catch {
    return {};
  }
}

export async function getPolicy(userId?: string): Promise<AutoPolicy> {
  const store = await readStore();
  const u = (userId ?? 'default').toLowerCase();
  return { ...DEFAULTS, ...(store[u] ?? {}) };
}

export async function setPolicy(
  userId: string | undefined,
  patch: Partial<Pick<AutoPolicy, 'autoApprove' | 'maxWei' | 'actions'>>,
): Promise<AutoPolicy> {
  if (patch.maxWei !== undefined) {
    const v = BigInt(patch.maxWei);
    if (v < 0n) throw new Error('maxWei must be non-negative');
  }
  const store = await readStore();
  const u = (userId ?? 'default').toLowerCase();
  const next: AutoPolicy = { ...DEFAULTS, ...(store[u] ?? {}), ...patch, updatedAt: new Date().toISOString() };
  store[u] = next;
  await fs.writeFile(storePath(), JSON.stringify(store, null, 2), 'utf8');
  return next;
}

export function weiToMon2(wei: string): string {
  const w = BigInt(wei);
  const whole = w / 10n ** 18n;
  const frac = (w % 10n ** 18n).toString().padStart(18, '0').slice(0, 2).padEnd(2, '0');
  return `${whole}.${frac}`;
}

export function monToWei(mon: string): string {
  const [whole, frac = ''] = mon.split('.');
  if (!/^\d+$/.test(whole) || (frac && !/^\d+$/.test(frac))) throw new Error(`Invalid MON amount "${mon}".`);
  return (BigInt(whole) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18) || '0')).toString();
}
