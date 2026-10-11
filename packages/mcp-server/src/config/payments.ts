import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const AUSD_ADDRESS = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' as const;
export type PaymentStatus = 'processing' | 'awaiting-approval' | 'broadcast' | 'confirmed' | 'rejected' | 'failed';

export interface PaymentRecord {
  id: string;
  userId: string;
  invoiceId: string;
  recipientName: string;
  recipientAddress: string;
  token: 'AUSD';
  amount: string;
  reason: string;
  status: PaymentStatus;
  requestId?: string;
  txHash?: string;
  blockNumber?: string;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
  note?: string;
  batchId?: string;
  refundTxHash?: string;
  refundStatus?: 'processing' | 'broadcast' | 'refunded' | 'failed';
}

export type PaymentRequestStatus = 'open' | 'paid' | 'review' | 'expired';
export interface PaymentRequestRecord {
  id: string;
  userId: string;
  invoiceId: string;
  merchantAddress: string;
  token: 'AUSD';
  amount: string;
  reason: string;
  status: PaymentRequestStatus;
  createdAt: string;
  expiresAt: string;
  createdBlock: string;
  txHash?: string;
  payerAddress?: string;
  blockNumber?: string;
  paidAt?: string;
  note?: string;
  refundTxHash?: string;
  refundStatus?: 'processing' | 'broadcast' | 'refunded' | 'failed';
  refundAt?: string;
}

type Store = PaymentRecord[];

export interface PaymentReservationPolicy {
  maxPaymentAUSD: string | null;
  dailyLimitAUSD: string | null;
  allowedRecipients: string[] | null;
}

export function normalizeInvoiceId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._/-]{0,63}$/.test(normalized)) throw new Error('Invoice reference must be 1–64 letters, numbers, dots, underscores, slashes, or hyphens.');
  return normalized;
}

export function createPaymentCloseout(records: PaymentRecord[], from: string, to: string) {
  const asDate = (value: string, label: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD.`);
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${label} is not a valid calendar date.`);
    return date;
  };
  const start = asDate(from, 'fromDate');
  const endDay = asDate(to, 'toDate');
  if (start > endDay) throw new Error('fromDate must be on or before toDate.');
  const endExclusive = new Date(endDay.valueOf() + 86_400_000);
  const periodRecords = records.filter((record) => {
    const activityDate = record.status === 'confirmed' ? (record.confirmedAt ?? record.updatedAt) : record.createdAt;
    const created = new Date(activityDate);
    return created >= start && created < endExclusive;
  });
  const confirmed = periodRecords.filter((record) => record.status === 'confirmed');
  const confirmedTotal = confirmed.reduce((sum, record) => sum + parseAusdAmount(record.amount), 0n);
  const statuses = Object.fromEntries((['processing', 'awaiting-approval', 'broadcast', 'confirmed', 'rejected', 'failed'] as const).map((status) => [status, periodRecords.filter((record) => record.status === status).length]));
  return {
    fromDate: from,
    toDate: to,
    token: 'AUSD' as const,
    confirmedCount: confirmed.length,
    confirmedAmountRaw: confirmedTotal.toString(),
    confirmedAmount: `${confirmedTotal / 1_000_000n}.${(confirmedTotal % 1_000_000n).toString().padStart(6, '0')}`,
    statuses,
    records: periodRecords,
  };
}

export function paymentInvoiceRisk(
  records: PaymentRecord[],
  input: { invoiceId: string; recipientAddress: string; amount: string; previousRecipientAddresses?: string[] },
): { level: 'low' | 'review'; flags: string[]; priorConfirmedPayments: number } {
  const flags: string[] = [];
  const prior = records.filter((record) => record.status === 'confirmed' && record.recipientAddress.toLowerCase() === input.recipientAddress.toLowerCase());
  if (input.previousRecipientAddresses?.some((address) => address.toLowerCase() !== input.recipientAddress.toLowerCase())) flags.push('The saved recipient address was changed from a previously saved address. Verify the change with the payee using a trusted channel.');
  const key = normalizeInvoiceId(input.invoiceId);
  if (records.some((record) => record.invoiceId === key && ['processing', 'awaiting-approval', 'broadcast', 'confirmed'].includes(record.status))) flags.push('This invoice reference already has a committed payment record.');
  if (prior.length === 0) flags.push('No confirmed payment history exists for this recipient address in Mochi’s local payment records.');
  else {
    const knownAmounts = prior.map((record) => parseAusdAmount(record.amount)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const median = knownAmounts[Math.floor(knownAmounts.length / 2)]!;
    const amount = parseAusdAmount(input.amount);
    if (amount > median * 3n && amount - median >= 10_000_000n) flags.push(`Amount is more than 3× the median prior payment to this recipient (${formatAusdAmount(median)} AUSD).`);
  }
  return { level: flags.length ? 'review' : 'low', flags, priorConfirmedPayments: prior.length };
}

export interface CashflowItem { label: string; date: string; amount: string }
export function forecastAusdCashflow(currentBalance: string, obligations: CashflowItem[], expectedReceipts: CashflowItem[], fromDate: string, toDate: string) {
  const validDay = (value: string) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new Error(`Invalid cashflow date: ${value}. Use a real calendar date in YYYY-MM-DD format.`);
    return value;
  };
  validDay(fromDate); validDay(toDate);
  if (fromDate > toDate) throw new Error('fromDate must be on or before toDate.');
  const dayCount = (Date.parse(`${toDate}T00:00:00.000Z`) - Date.parse(`${fromDate}T00:00:00.000Z`)) / 86_400_000;
  if (dayCount > 90) throw new Error('Cashflow forecasts are limited to a 90-day horizon.');
  const openingRaw = /^\d+(?:\.\d{1,6})?$/.test(currentBalance) ? (() => { const [w, f = ''] = currentBalance.split('.'); return BigInt(w!) * 1_000_000n + BigInt((f + '000000').slice(0, 6)); })() : -1n;
  if (openingRaw < 0n) throw new Error('currentBalance must be a non-negative AUSD amount with at most 6 decimal places.');
  const events = [
    ...obligations.map((item) => ({ ...item, kind: 'outgoing' as const })),
    ...expectedReceipts.map((item) => ({ ...item, kind: 'incoming' as const })),
  ].map((item) => {
    if (!item.label.trim() || item.label.length > 120) throw new Error('Cashflow item labels must contain 1–120 characters.');
    const date = validDay(item.date);
    return { label: item.label.trim(), date, amountRaw: parseAusdAmount(item.amount), kind: item.kind };
  }).filter((item) => item.date >= fromDate && item.date <= toDate).sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'incoming' ? -1 : 1));
  let balance = openingRaw;
  const timeline = events.map((event) => {
    balance += event.kind === 'incoming' ? event.amountRaw : -event.amountRaw;
    return { date: event.date, label: event.label, kind: event.kind, amount: formatAusdAmount(event.amountRaw), projectedBalance: formatSignedAusd(balance), shortfall: balance < 0n };
  });
  const shortfalls = timeline.filter((item) => item.shortfall);
  return { token: 'AUSD' as const, fromDate, toDate, openingBalance: formatAusdAmount(openingRaw), projectedClosingBalance: formatSignedAusd(balance), lowestProjectedBalance: formatSignedAusd(timeline.reduce((lowest, item) => { const raw = parseSignedAusdAmount(item.projectedBalance); return raw < lowest ? raw : lowest; }, openingRaw)), eventCount: events.length, shortfallCount: shortfalls.length, shortfalls, timeline, scope: 'Forecast uses only the balance, obligations, and expected receipts supplied for this request; it is not a bank feed or a prediction of unlisted activity.' };
}

function formatSignedAusd(raw: bigint): string {
  return `${raw < 0n ? '-' : ''}${formatAusdAmount(raw < 0n ? -raw : raw)}`;
}

function parseSignedAusdAmount(amount: string): bigint {
  const negative = amount.startsWith('-');
  const positive = negative ? amount.slice(1) : amount;
  const [whole, fraction = ''] = positive.split('.');
  const raw = BigInt(whole!) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
  return negative ? -raw : raw;
}

export function paymentCloseoutCsv(records: PaymentRecord[]): string {
  const columns = ['direction', 'invoiceId', 'partyName', 'partyAddress', 'token', 'amount', 'reason', 'status', 'txHash', 'blockNumber', 'createdAt', 'settledAt', 'refundTxHash', 'refundAt', 'note'] as const;
  const cell = (value: unknown) => {
    let text = String(value ?? '');
    if (/^[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [columns.join(','), ...records.map((record) => [
    'sent', record.invoiceId, record.recipientName, record.recipientAddress, record.token, record.amount, record.reason,
    record.status, record.txHash, record.blockNumber, record.createdAt, record.confirmedAt, record.refundTxHash, undefined, record.note,
  ].map(cell).join(','))].join('\n');
}

export function paymentRequestCloseoutCsv(records: PaymentRequestRecord[]): string {
  const cell = (value: unknown) => {
    let text = String(value ?? '');
    if (/^[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const columns = ['direction', 'invoiceId', 'partyName', 'partyAddress', 'token', 'amount', 'reason', 'status', 'txHash', 'blockNumber', 'createdAt', 'settledAt', 'refundTxHash', 'refundAt', 'note'] as const;
  return [columns.join(','), ...records.map((record) => [
    'received', record.invoiceId, record.payerAddress, record.payerAddress, record.token, record.amount, record.reason,
    record.status, record.txHash, record.blockNumber, record.createdAt, record.paidAt, record.refundTxHash, record.refundAt, record.note,
  ].map(cell).join(','))].join('\n');
}

export function parseAusdAmount(amount: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(amount)) throw new Error('AUSD amount must be a positive decimal with no more than 6 decimal places.');
  const [whole, fraction = ''] = amount.split('.');
  const raw = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
  if (raw <= 0n) throw new Error('AUSD payment amount must be greater than zero.');
  return raw;
}

function formatAusdAmount(raw: bigint): string {
  return `${raw / 1_000_000n}.${(raw % 1_000_000n).toString().padStart(6, '0')}`;
}

export function createPaymentRepository(
  storeFile = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'payments.json'),
  requestStoreFile = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'payment-requests.json'),
) {
  let writeQueue: Promise<unknown> = Promise.resolve();
  let requestWriteQueue: Promise<unknown> = Promise.resolve();
  const readStore = async (): Promise<Store> => {
    let contents: string;
    try {
      contents = await fs.readFile(storeFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Unable to read Mochi payment records; payment operations are paused: ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(contents) as unknown; }
    catch { throw new Error('Mochi payment records are malformed; payment operations are paused to avoid duplicate invoice payments.'); }
    if (!Array.isArray(parsed)) throw new Error('Mochi payment records are malformed; payment operations are paused to avoid duplicate invoice payments.');
    return parsed as Store;
  };
  const mutateStore = async <T>(mutator: (entries: Store) => T | Promise<T>): Promise<T> => {
    const operation = writeQueue.then(async () => {
      const entries = await readStore();
      const result = await mutator(entries);
      await fs.mkdir(dirname(storeFile), { recursive: true });
      const temp = `${storeFile}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, JSON.stringify(entries, null, 2), 'utf8');
      await fs.rename(temp, storeFile);
      return result;
    });
    writeQueue = operation.catch(() => undefined);
    return operation;
  };
  const readRequests = async (): Promise<PaymentRequestRecord[]> => {
    let contents: string;
    try { contents = await fs.readFile(requestStoreFile, 'utf8'); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Unable to read payment requests: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const parsed: unknown = JSON.parse(contents);
      if (!Array.isArray(parsed)) throw new Error('invalid request list');
      return parsed as PaymentRequestRecord[];
    } catch { throw new Error('Payment request store is malformed; request operations are paused.'); }
  };
  const mutateRequests = async <T>(mutator: (entries: PaymentRequestRecord[]) => T | Promise<T>): Promise<T> => {
    const operation = requestWriteQueue.then(async () => {
      const entries = await readRequests();
      const result = await mutator(entries);
      await fs.mkdir(dirname(requestStoreFile), { recursive: true });
      const temp = `${requestStoreFile}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, JSON.stringify(entries, null, 2), 'utf8');
      await fs.rename(temp, requestStoreFile);
      return result;
    });
    requestWriteQueue = operation.catch(() => undefined);
    return operation;
  };
  return {
    async findInvoicePayment(userId: string, invoiceId: string): Promise<PaymentRecord | null> {
      const key = normalizeInvoiceId(invoiceId);
      const entries = await readStore();
      return entries.find((entry) => entry.userId === userId.toLowerCase() && entry.invoiceId === key) ?? null;
    },
    async reserveInvoicePayment(input: Omit<PaymentRecord, 'id' | 'createdAt' | 'updatedAt'>, policy?: PaymentReservationPolicy): Promise<{ record: PaymentRecord | null; duplicate: PaymentRecord | null }> {
      return mutateStore((entries) => {
        const key = normalizeInvoiceId(input.invoiceId);
        const existing = entries.find((entry) => entry.userId === input.userId.toLowerCase() && entry.invoiceId === key);
        if (existing && ['processing', 'awaiting-approval', 'broadcast', 'confirmed'].includes(existing.status)) {
          return { record: null, duplicate: existing };
        }
        if (input.token !== 'AUSD') throw new Error('Mochi invoice payments currently support AUSD only.');
        const amountRaw = parseAusdAmount(input.amount);
        if (policy?.allowedRecipients && !policy.allowedRecipients.includes(input.recipientAddress.toLowerCase())) {
          throw new Error('Recipient is blocked by the payment recipient allowlist.');
        }
        if (policy?.maxPaymentAUSD !== null && policy?.maxPaymentAUSD !== undefined && amountRaw > parseAusdAmount(policy.maxPaymentAUSD)) {
          throw new Error(`Payment exceeds the configured per-payment limit of ${policy.maxPaymentAUSD} AUSD.`);
        }
        if (policy?.dailyLimitAUSD !== null && policy?.dailyLimitAUSD !== undefined) {
          const today = new Date().toISOString().slice(0, 10);
          const committedRaw = entries
            .filter((entry) => entry.userId === input.userId.toLowerCase() && ['processing', 'awaiting-approval', 'broadcast', 'confirmed'].includes(entry.status))
            .filter((entry) => entry.status !== 'confirmed' || (entry.confirmedAt ?? entry.updatedAt).slice(0, 10) === today)
            .reduce((sum, entry) => sum + parseAusdAmount(entry.amount), 0n);
          if (committedRaw + amountRaw > parseAusdAmount(policy.dailyLimitAUSD)) {
            throw new Error(`Payment exceeds the configured daily AUSD limit of ${policy.dailyLimitAUSD}; already committed today: ${formatAusdAmount(committedRaw)} AUSD.`);
          }
        }
        const now = new Date().toISOString();
        const record: PaymentRecord = { ...input, id: randomUUID(), invoiceId: key, createdAt: now, updatedAt: now };
        if (existing) entries[entries.indexOf(existing)] = record;
        else entries.push(record);
        return { record, duplicate: null };
      });
    },
    async updatePayment(id: string, patch: Partial<PaymentRecord>): Promise<PaymentRecord | null> {
      return mutateStore((entries) => {
        const record = entries.find((entry) => entry.id === id);
        if (!record) return null;
        Object.assign(record, patch, { updatedAt: new Date().toISOString() });
        return record;
      });
    },
    async listPayments(userId: string, limit = 50): Promise<PaymentRecord[]> {
      const entries = await readStore();
      return entries.filter((entry) => entry.userId === userId.toLowerCase())
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    },
    async reserveInvoicePayments(inputs: Array<Omit<PaymentRecord, 'id' | 'createdAt' | 'updatedAt'>>, policy?: PaymentReservationPolicy): Promise<{ records: PaymentRecord[]; duplicate: PaymentRecord | null }> {
      return mutateStore((entries) => {
        if (inputs.length === 0) throw new Error('A payout batch must contain at least one invoice.');
        const seen = new Set<string>();
        for (const input of inputs) {
          const key = `${input.userId.toLowerCase()}:${normalizeInvoiceId(input.invoiceId)}`;
          if (seen.has(key)) throw new Error(`Duplicate invoice reference ${input.invoiceId} appears more than once in this payout batch.`);
          seen.add(key);
          const existing = entries.find((entry) => entry.userId === input.userId.toLowerCase() && entry.invoiceId === normalizeInvoiceId(input.invoiceId));
          if (existing && ['processing', 'awaiting-approval', 'broadcast', 'confirmed'].includes(existing.status)) return { records: [], duplicate: existing };
        }
        let batchTotal = 0n;
        for (const input of inputs) {
          if (input.token !== 'AUSD') throw new Error('Mochi invoice payments currently support AUSD only.');
          const raw = parseAusdAmount(input.amount);
          batchTotal += raw;
          if (policy?.allowedRecipients && !policy.allowedRecipients.includes(input.recipientAddress.toLowerCase())) throw new Error(`Recipient ${input.recipientAddress} is blocked by the payment recipient allowlist.`);
          if (policy?.maxPaymentAUSD !== null && policy?.maxPaymentAUSD !== undefined && raw > parseAusdAmount(policy.maxPaymentAUSD)) throw new Error(`Payment to ${input.recipientName} exceeds the configured per-payment limit of ${policy.maxPaymentAUSD} AUSD.`);
        }
        if (policy?.dailyLimitAUSD !== null && policy?.dailyLimitAUSD !== undefined) {
          const today = new Date().toISOString().slice(0, 10);
          const committed = entries.filter((entry) => entry.userId === inputs[0]?.userId.toLowerCase() && ['processing', 'awaiting-approval', 'broadcast', 'confirmed'].includes(entry.status))
            .filter((entry) => entry.status !== 'confirmed' || (entry.confirmedAt ?? entry.updatedAt).slice(0, 10) === today)
            .reduce((sum, entry) => sum + parseAusdAmount(entry.amount), 0n);
          if (committed + batchTotal > parseAusdAmount(policy.dailyLimitAUSD)) throw new Error(`Payout batch exceeds the configured daily AUSD limit of ${policy.dailyLimitAUSD}; already committed today: ${formatAusdAmount(committed)} AUSD.`);
        }
        const now = new Date().toISOString();
        const records = inputs.map((input) => ({ ...input, id: randomUUID(), invoiceId: normalizeInvoiceId(input.invoiceId), createdAt: now, updatedAt: now }));
        for (const record of records) {
          const prior = entries.findIndex((entry) => entry.userId === record.userId.toLowerCase() && entry.invoiceId === record.invoiceId);
          if (prior >= 0) entries[prior] = record;
          else entries.push(record);
        }
        return { records, duplicate: null };
      });
    },
    async createPaymentRequest(input: Omit<PaymentRequestRecord, 'id' | 'createdAt' | 'status'>): Promise<{ record: PaymentRequestRecord | null; duplicate: PaymentRequestRecord | null }> {
      return mutateRequests((entries) => {
        const owner = input.userId.toLowerCase();
        const invoiceId = normalizeInvoiceId(input.invoiceId);
        const existingIndex = entries.findIndex((entry) => entry.userId === owner && entry.invoiceId === invoiceId);
        const existing = existingIndex >= 0 ? entries[existingIndex] : undefined;
        if (existing && (existing.status === 'paid' || existing.status === 'review' || (existing.status === 'open' && Date.parse(existing.expiresAt) > Date.now()))) return { record: null, duplicate: existing };
        const record: PaymentRequestRecord = { ...input, id: randomUUID(), userId: owner, invoiceId, status: 'open', createdAt: new Date().toISOString() };
        if (existingIndex >= 0) entries[existingIndex] = record;
        else entries.push(record);
        return { record, duplicate: null };
      });
    },
    async getPaymentRequest(userId: string, id: string): Promise<PaymentRequestRecord | null> {
      const requests = await readRequests();
      return requests.find((entry) => entry.userId === userId.toLowerCase() && (entry.id === id || entry.invoiceId === normalizeInvoiceId(id))) ?? null;
    },
    async updatePaymentRequest(id: string, patch: Partial<PaymentRequestRecord>): Promise<PaymentRequestRecord | null> {
      return mutateRequests((entries) => {
        const record = entries.find((entry) => entry.id === id);
        if (!record) return null;
        Object.assign(record, patch);
        return record;
      });
    },
    async listPaymentRequests(userId: string, limit = 50): Promise<PaymentRequestRecord[]> {
      return (await readRequests()).filter((entry) => entry.userId === userId.toLowerCase()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    },
  };
}

const repository = createPaymentRepository();
export const findInvoicePayment = repository.findInvoicePayment;
export const reserveInvoicePayment = repository.reserveInvoicePayment;
export const updatePayment = repository.updatePayment;
export const listPayments = repository.listPayments;
export const reserveInvoicePayments = repository.reserveInvoicePayments;
export const createPaymentRequest = repository.createPaymentRequest;
export const getPaymentRequest = repository.getPaymentRequest;
export const updatePaymentRequest = repository.updatePaymentRequest;
export const listPaymentRequests = repository.listPaymentRequests;
