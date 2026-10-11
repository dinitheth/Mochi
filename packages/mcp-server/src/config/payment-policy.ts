import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PaymentRecord } from './payments.js';
import { parseAusdAmount } from './payments.js';

export interface PaymentPolicy {
  /** Maximum size of one invoice payment; null means no configured cap. */
  maxPaymentAUSD: string | null;
  /** Maximum payment exposure per UTC day; null means no configured cap. */
  dailyLimitAUSD: string | null;
  /** Address allowlist; null allows any saved contact. */
  allowedRecipients: string[] | null;
  /** This adapter intentionally supports only AUSD. */
  allowedTokens: ['AUSD'];
  updatedAt: string;
}

const DEFAULT_POLICY: PaymentPolicy = {
  maxPaymentAUSD: null,
  dailyLimitAUSD: null,
  allowedRecipients: null,
  allowedTokens: ['AUSD'],
  updatedAt: new Date(0).toISOString(),
};
type Store = Record<string, PaymentPolicy>;
const POLICY_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'payment-policy.json');
const normalizeUser = (userId?: string) => (userId ?? 'default').toLowerCase();
let writeQueue: Promise<unknown> = Promise.resolve();

async function readStore(): Promise<Store> {
  let contents: string;
  try { contents = await fs.readFile(POLICY_FILE, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Unable to read payment policy; invoice payments are paused: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const parsed = JSON.parse(contents) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid policy map');
    return parsed as Store;
  } catch { throw new Error('Payment policy store is malformed; invoice payments are paused.'); }
}

export async function getPaymentPolicy(userId?: string): Promise<PaymentPolicy> {
  const store = await readStore();
  return { ...DEFAULT_POLICY, ...(store[normalizeUser(userId)] ?? {}) };
}

export async function setPaymentPolicy(
  userId: string | undefined,
  input: Pick<PaymentPolicy, 'maxPaymentAUSD' | 'dailyLimitAUSD' | 'allowedRecipients'>,
): Promise<PaymentPolicy> {
  for (const amount of [input.maxPaymentAUSD, input.dailyLimitAUSD]) {
    if (amount !== null) parseAusdAmount(amount);
  }
  const recipients = input.allowedRecipients === null ? null : [...new Set(input.allowedRecipients.map((address) => address.trim().toLowerCase()))];
  if (recipients?.some((address) => !/^0x[0-9a-f]{40}$/.test(address))) throw new Error('allowedRecipients must contain EVM addresses.');
  const policy: PaymentPolicy = { ...input, allowedRecipients: recipients, allowedTokens: ['AUSD'], updatedAt: new Date().toISOString() };
  const operation = writeQueue.then(async () => {
    const store = await readStore();
    store[normalizeUser(userId)] = policy;
    await fs.mkdir(dirname(POLICY_FILE), { recursive: true });
    const temp = `${POLICY_FILE}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(store, null, 2), 'utf8');
    await fs.rename(temp, POLICY_FILE);
    return policy;
  });
  writeQueue = operation.catch(() => undefined);
  return operation;
}

export function assertPaymentPolicyAllows(
  policy: PaymentPolicy,
  input: { recipientAddress: string; amount: string; token: string; records: PaymentRecord[]; now?: Date },
): { amountRaw: bigint; dailyCommittedRaw: bigint; dailyRemainingRaw: bigint | null } {
  if (input.token !== 'AUSD') throw new Error('Mochi invoice payments currently support AUSD only.');
  if (!policy.allowedTokens.includes(input.token as 'AUSD')) throw new Error(`Payment policy does not allow token ${input.token}.`);
  if (policy.allowedRecipients && !policy.allowedRecipients.includes(input.recipientAddress.toLowerCase())) throw new Error('Recipient is blocked by the payment recipient allowlist.');
  const amountRaw = parseAusdAmount(input.amount);
  const maxPaymentRaw = policy.maxPaymentAUSD === null ? null : parseAusdAmount(policy.maxPaymentAUSD);
  if (maxPaymentRaw !== null && amountRaw > maxPaymentRaw) throw new Error(`Payment exceeds the configured per-payment limit of ${policy.maxPaymentAUSD} AUSD.`);
  const now = input.now ?? new Date();
  const utcDay = now.toISOString().slice(0, 10);
  const committedStatuses = new Set(['processing', 'awaiting-approval', 'broadcast', 'confirmed']);
  const dailyCommittedRaw = input.records.reduce((sum, record) => {
    if (!committedStatuses.has(record.status)) return sum;
    const commitmentDay = record.status === 'confirmed' ? (record.confirmedAt ?? record.updatedAt).slice(0, 10) : record.createdAt.slice(0, 10);
    if (record.status === 'confirmed' && commitmentDay !== utcDay) return sum;
    // Unsettled reservations continue counting across midnight until resolved.
    return sum + parseAusdAmount(record.amount);
  }, 0n);
  const dailyLimitRaw = policy.dailyLimitAUSD === null ? null : parseAusdAmount(policy.dailyLimitAUSD);
  if (dailyLimitRaw !== null && amountRaw + dailyCommittedRaw > dailyLimitRaw) throw new Error(`Payment exceeds the configured daily AUSD limit of ${policy.dailyLimitAUSD}; already committed today: ${formatAUSD(dailyCommittedRaw)} AUSD.`);
  return { amountRaw, dailyCommittedRaw, dailyRemainingRaw: dailyLimitRaw === null ? null : dailyLimitRaw - dailyCommittedRaw };
}

export function formatAUSD(raw: bigint): string {
  return `${raw / 1_000_000n}.${(raw % 1_000_000n).toString().padStart(6, '0')}`;
}
