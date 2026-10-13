import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaymentRepository, forecastAusdCashflow, paymentCloseoutCsv, paymentInvoiceRisk, paymentRequestCloseoutCsv, type PaymentRecord } from '../packages/mcp-server/src/config/payments.js';

const address = '0x1111111111111111111111111111111111111111';
function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return { id: 'p1', userId: 'shop', invoiceId: 'inv-1', recipientName: 'Supplier', recipientAddress: address, token: 'AUSD', amount: '25.00', reason: 'Stock', status: 'confirmed', createdAt: '2026-10-12T10:00:00.000Z', updatedAt: '2026-10-12T10:00:00.000Z', confirmedAt: '2026-10-12T10:00:00.000Z', ...overrides };
}

describe('merchant payment operations', () => {
  it('creates payment requests idempotently and persists settlement/refund state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mochi-requests-'));
    try {
      const repo = createPaymentRepository(join(dir, 'payments.json'), join(dir, 'requests.json'));
      const request = { userId: 'Shop', invoiceId: 'ORDER-42', merchantAddress: address, token: 'AUSD' as const, amount: '12.50', reason: 'Lunch', expiresAt: new Date(Date.now() + 60_000).toISOString(), createdBlock: '10' };
      const created = await repo.createPaymentRequest(request);
      expect(created.record).toMatchObject({ invoiceId: 'order-42', status: 'open', userId: 'shop' });
      expect((await repo.createPaymentRequest(request)).duplicate?.id).toBe(created.record?.id);
      const paid = await repo.updatePaymentRequest(created.record!.id, { status: 'paid', txHash: '0xabc', payerAddress: address, paidAt: '2026-10-12T12:00:00.000Z' });
      expect(paid).toMatchObject({ status: 'paid', txHash: '0xabc', payerAddress: address });
      await repo.updatePaymentRequest(created.record!.id, { refundStatus: 'refunded', refundTxHash: '0xdef' });
      expect(await repo.getPaymentRequest('shop', 'order-42')).toMatchObject({ refundStatus: 'refunded', refundTxHash: '0xdef' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reserves a batch atomically and rejects one duplicate or over-cap batch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mochi-batch-'));
    try {
      const repo = createPaymentRepository(join(dir, 'payments.json'), join(dir, 'requests.json'));
      const base = { userId: 'shop', recipientName: 'Vendor', recipientAddress: address, token: 'AUSD' as const, reason: 'Payout', status: 'processing' as const };
      const inputs = [{ ...base, invoiceId: 'one', amount: '6' }, { ...base, invoiceId: 'two', amount: '6' }];
      const policy = { maxPaymentAUSD: '10', dailyLimitAUSD: '15', allowedRecipients: null };
      const result = await repo.reserveInvoicePayments(inputs, policy);
      expect(result.records).toHaveLength(2);
      expect(await repo.reserveInvoicePayments([{ ...base, invoiceId: 'one', amount: '1' }], policy)).toMatchObject({ records: [], duplicate: { invoiceId: 'one' } });
      await repo.updatePayment(result.records[0]!.id, { status: 'failed' });
      const retry = await repo.reserveInvoicePayments([{ ...inputs[0]!, amount: '7' }], policy);
      expect(retry.records).toHaveLength(1);
      expect(await repo.listPayments('shop')).toHaveLength(2);
      await expect(repo.reserveInvoicePayments([{ ...base, invoiceId: 'four', amount: '5' }], policy)).rejects.toThrow(/daily AUSD limit/);
      expect(await repo.listPayments('shop')).toHaveLength(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('flags first-time recipients, changed recipient addresses, and unusual invoice sizes', () => {
    expect(paymentInvoiceRisk([], { invoiceId: 'INV-1', recipientAddress: address, amount: '10' }).flags[0]).toMatch(/No confirmed payment history/);
    const history = [payment({ amount: '20' }), payment({ id: 'p2', invoiceId: 'inv-2', amount: '25' }), payment({ id: 'p3', invoiceId: 'inv-3', amount: '30' })];
    expect(paymentInvoiceRisk(history, { invoiceId: 'inv-new', recipientAddress: address, amount: '100', previousRecipientAddresses: ['0x2222222222222222222222222222222222222222'] })).toMatchObject({ level: 'review', priorConfirmedPayments: 3 });
    expect(paymentInvoiceRisk(history, { invoiceId: 'inv-small', recipientAddress: address, amount: '22' }).level).toBe('low');
  });

  it('forecasts AUSD shortfalls in date order and labels the forecast as user supplied', () => {
    const result = forecastAusdCashflow('20', [{ label: 'Rent', date: '2026-10-13', amount: '30' }], [{ label: 'Customer payment', date: '2026-10-14', amount: '15' }], '2026-10-12', '2026-10-20');
    expect(result).toMatchObject({ openingBalance: '20.000000', projectedClosingBalance: '5.000000', lowestProjectedBalance: '-10.000000', shortfallCount: 1 });
    expect(result.scope).toMatch(/supplied/);
    expect(() => forecastAusdCashflow('1', [], [], '2026-02-30', '2026-03-01')).toThrow(/Invalid cashflow date/);
    expect(() => forecastAusdCashflow('1', [], [], '2026-01-01', '2026-05-01')).toThrow(/90-day/);
  });

  it('exports incoming and outgoing closeouts with formula-safe CSV cells', () => {
    const outgoing = payment({ invoiceId: '=HYPERLINK("x")' });
    const sentCsv = paymentCloseoutCsv([outgoing]);
    expect(sentCsv.split('\n')[0]).toContain('direction,invoiceId,partyName');
    expect(sentCsv).toContain("'=HYPERLINK(");
    const receivedCsv = paymentRequestCloseoutCsv([{ id: 'r', userId: 'shop', invoiceId: 'order-9', merchantAddress: address, payerAddress: address, token: 'AUSD', amount: '1', reason: 'Sale', status: 'paid', createdAt: '2026-10-12T10:00:00Z', paidAt: '2026-10-12T10:02:00Z', expiresAt: '2026-10-13T00:00:00Z', createdBlock: '1' }]);
    expect(receivedCsv.split('\n')[0]).toBe(sentCsv.split('\n')[0]);
    expect(receivedCsv).toContain('received');
  });
});
