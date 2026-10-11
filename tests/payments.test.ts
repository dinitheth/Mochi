import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaymentCloseout, createPaymentRepository, normalizeInvoiceId, type PaymentRecord } from '../packages/mcp-server/src/config/payments.js';

describe('invoice payment records', () => {
  it('normalizes a human invoice reference and rejects unsafe/empty references', () => {
    expect(normalizeInvoiceId('  INV-104/Q3  ')).toBe('inv-104/q3');
    expect(() => normalizeInvoiceId('')).toThrow(/Invoice reference/);
    expect(() => normalizeInvoiceId('../secrets')).toThrow(/Invoice reference/);
  });

  it('serializes reservations and blocks duplicate processing or confirmed invoices', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mochi-payments-'));
    try {
      const repo = createPaymentRepository(join(dir, 'payments.json'));
      const base = { userId: 'business-1', invoiceId: 'INV-104', recipientName: 'Maya', recipientAddress: '0x1111111111111111111111111111111111111111', token: 'AUSD' as const, amount: '250.00', reason: 'Contractor invoice', status: 'processing' as const };
      const [first, second] = await Promise.all([repo.reserveInvoicePayment(base), repo.reserveInvoicePayment(base)]);
      expect([first, second].filter((result) => result.record).length).toBe(1);
      expect([first, second].filter((result) => result.duplicate).length).toBe(1);
      const record = first.record ?? second.record;
      if (!record) throw new Error('Expected one payment reservation.');
      await repo.updatePayment(record.id, { status: 'confirmed', txHash: '0xabc' });
      expect(await repo.findInvoicePayment('business-1', 'inv-104')).toMatchObject({ status: 'confirmed', txHash: '0xabc' });
      const retry = await repo.reserveInvoicePayment(base);
      expect(retry.record).toBeNull();
      expect(retry.duplicate?.status).toBe('confirmed');
      expect((await repo.listPayments('business-1')).length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('allows an explicit retry after rejected/failed payments only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mochi-payments-'));
    try {
      const repo = createPaymentRepository(join(dir, 'payments.json'));
      const base = { userId: 'user-1', invoiceId: 'INV-9', recipientName: 'Alex', recipientAddress: '0x2222222222222222222222222222222222222222', token: 'AUSD' as const, amount: '5', reason: 'Invoice', status: 'rejected' as const };
      const first = await repo.reserveInvoicePayment(base);
      if (!first.record) throw new Error('Expected first reservation.');
      const retry = await repo.reserveInvoicePayment({ ...base, status: 'processing' });
      expect(retry.record?.invoiceId).toBe('inv-9');
      expect(retry.duplicate).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps broadcast payments reserved until settlement is known', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mochi-payments-'));
    try {
      const repo = createPaymentRepository(join(dir, 'payments.json'));
      const first = await repo.reserveInvoicePayment({ userId: 'user-2', invoiceId: 'INV-12', recipientName: 'Sam', recipientAddress: '0x3333333333333333333333333333333333333333', token: 'AUSD', amount: '10', reason: 'Invoice', status: 'broadcast', txHash: '0xabc' });
      expect(first.record).not.toBeNull();
      const retry = await repo.reserveInvoicePayment({ userId: 'user-2', invoiceId: 'INV-12', recipientName: 'Sam', recipientAddress: '0x3333333333333333333333333333333333333333', token: 'AUSD', amount: '10', reason: 'Invoice', status: 'processing' });
      expect(retry.record).toBeNull();
      expect(retry.duplicate).toMatchObject({ status: 'broadcast', txHash: '0xabc' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('enforces daily caps atomically across concurrent invoice reservations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mochi-payments-'));
    try {
      const repo = createPaymentRepository(join(dir, 'payments.json'));
      const make = (invoiceId: string) => repo.reserveInvoicePayment({ userId: 'business', invoiceId, recipientName: 'Sam', recipientAddress: '0x3333333333333333333333333333333333333333', token: 'AUSD', amount: '7', reason: 'Invoice', status: 'processing' }, { maxPaymentAUSD: null, dailyLimitAUSD: '10', allowedRecipients: null });
      const results = await Promise.allSettled([make('invoice-a'), make('invoice-b')]);
      expect(results.filter((result) => result.status === 'fulfilled' && result.value.record !== null)).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected' && /daily AUSD limit/.test(String(result.reason)))).toHaveLength(1);
      expect(await repo.listPayments('business')).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when payment history is corrupted instead of treating invoices as new', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mochi-payments-'));
    try {
      const file = join(dir, 'payments.json');
      await (await import('node:fs/promises')).writeFile(file, '{broken json', 'utf8');
      const repo = createPaymentRepository(file);
      await expect(repo.reserveInvoicePayment({ userId: 'user', invoiceId: 'INV-13', recipientName: 'Sam', recipientAddress: '0x4444444444444444444444444444444444444444', token: 'AUSD', amount: '1', reason: 'Invoice', status: 'processing' })).rejects.toThrow(/paused to avoid duplicate/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('builds date-bounded closeouts with confirmed-only totals and other states counted separately', () => {
    const record = (invoiceId: string, amount: string, status: PaymentRecord['status'], createdAt: string, confirmedAt?: string) => ({ id: invoiceId, userId: 'user', invoiceId, recipientName: 'Sam', recipientAddress: '0x1111111111111111111111111111111111111111', token: 'AUSD' as const, amount, reason: 'Invoice', status, createdAt, updatedAt: createdAt, ...(confirmedAt ? { confirmedAt } : {}) });
    const result = createPaymentCloseout([
      record('one', '10.25', 'confirmed', '2026-10-11T10:00:00.000Z', '2026-10-12T10:00:00.000Z'),
      record('two', '2.75', 'broadcast', '2026-10-12T11:00:00.000Z'),
      record('three', '100', 'confirmed', '2026-10-13T00:00:00.000Z'),
    ], '2026-10-12', '2026-10-12');
    expect(result.confirmedCount).toBe(1);
    expect(result.confirmedAmount).toBe('10.250000');
    expect(result.statuses.broadcast).toBe(1);
    expect(result.records).toHaveLength(2);
    expect(() => createPaymentCloseout([], '2026-02-30', '2026-03-01')).toThrow(/valid calendar date/);
  });
});
