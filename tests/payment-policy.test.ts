import { describe, expect, it } from 'vitest';
import { assertPaymentPolicyAllows, type PaymentPolicy } from '../packages/mcp-server/src/config/payment-policy.js';
import type { PaymentRecord } from '../packages/mcp-server/src/config/payments.js';

const policy: PaymentPolicy = {
  maxPaymentAUSD: '100',
  dailyLimitAUSD: '150',
  allowedRecipients: ['0x1111111111111111111111111111111111111111'],
  allowedTokens: ['AUSD'],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function record(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: 'payment-1', userId: 'user', invoiceId: 'inv-1', recipientName: 'Vendor',
    recipientAddress: '0x1111111111111111111111111111111111111111', token: 'AUSD', amount: '40',
    reason: 'Invoice', status: 'confirmed', createdAt: '2026-10-12T10:00:00.000Z',
    updatedAt: '2026-10-12T10:00:00.000Z', confirmedAt: '2026-10-12T10:00:00.000Z',
    ...overrides,
  };
}

describe('AUSD treasury policy', () => {
  const input = { recipientAddress: '0x1111111111111111111111111111111111111111', token: 'AUSD', now: new Date('2026-10-12T14:00:00.000Z') };

  it('allows a saved and allowlisted recipient within single and daily caps', () => {
    expect(assertPaymentPolicyAllows(policy, { ...input, amount: '50', records: [record()] })).toMatchObject({
      amountRaw: 50_000_000n,
      dailyCommittedRaw: 40_000_000n,
      dailyRemainingRaw: 110_000_000n,
    });
  });

  it('blocks a recipient outside the additional allowlist', () => {
    expect(() => assertPaymentPolicyAllows(policy, { ...input, recipientAddress: '0x2222222222222222222222222222222222222222', amount: '1', records: [] })).toThrow(/allowlist/);
  });

  it('blocks a payment over the per-invoice cap', () => {
    expect(() => assertPaymentPolicyAllows(policy, { ...input, amount: '100.000001', records: [] })).toThrow(/per-payment limit/);
  });

  it('counts unresolved reservations across midnight but only today’s confirmed settlements', () => {
    const oldConfirmed = record({ confirmedAt: '2026-10-11T23:59:00.000Z', updatedAt: '2026-10-11T23:59:00.000Z', amount: '90' });
    const oldPending = record({ status: 'broadcast', createdAt: '2026-10-11T23:59:00.000Z', amount: '110' });
    expect(() => assertPaymentPolicyAllows(policy, { ...input, amount: '50', records: [oldConfirmed, oldPending] })).toThrow(/daily AUSD limit/);
  });

  it('rejects unsupported payment tokens and malformed precision', () => {
    expect(() => assertPaymentPolicyAllows(policy, { ...input, token: 'WMON', amount: '1', records: [] })).toThrow(/AUSD only/);
    expect(() => assertPaymentPolicyAllows(policy, { ...input, amount: '1.0000001', records: [] })).toThrow(/6 decimal places/);
  });
});
