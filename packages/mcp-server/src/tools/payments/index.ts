import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { encodeFunctionData, formatEther, formatUnits, parseAbiItem } from 'viem';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import { explorerAddressUrl, explorerTxUrl, getPublicClient } from '../../config/monad.js';
import { listContacts, normalizeUser } from '../../config/contacts.js';
import { AUSD_ADDRESS, createPaymentCloseout, createPaymentRequest, findInvoicePayment, forecastAusdCashflow, getPaymentRequest, listPaymentRequests, listPayments, normalizeInvoiceId, parseAusdAmount, paymentCloseoutCsv, paymentInvoiceRisk, paymentRequestCloseoutCsv, reserveInvoicePayment, reserveInvoicePayments, updatePayment, updatePaymentRequest } from '../../config/payments.js';
import { assertPaymentPolicyAllows, formatAUSD, getPaymentPolicy, setPaymentPolicy } from '../../config/payment-policy.js';
import { privySendTransaction } from '../../config/privy.js';
import { approvalGate } from '../../middleware/approval-gate.js';
import { auditLog } from '../../middleware/audit-log.js';
import { simulateTx } from '../../middleware/simulate.js';
import { addTool, assertAddress, resolveWallet, textResult } from '../shared.js';

const TRANSFER_ABI = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const;
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const WALLET_ACTIVITY_TOKENS = [
  { symbol: 'AUSD', address: AUSD_ADDRESS, decimals: 6 },
  { symbol: 'WMON', address: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', decimals: 18 },
] as const;
const PAYMENT_REQUEST_HOURS_MAX = 168;

async function resolvePaymentContact(userId: string | undefined, recipient: string) {
  const contacts = await listContacts(userId);
  const matched = contacts.find((contact) => contact.name.toLowerCase() === recipient.trim().toLowerCase() || contact.address.toLowerCase() === recipient.trim().toLowerCase());
  if (!matched) throw new Error(`Payment recipient "${recipient}" is not in this user's saved contacts. Save and verify the payee with contacts_save before preparing an invoice payment.`);
  return matched;
}

export function registerPaymentTools(server: McpServer, env: Env): void {
  addTool(server, 'payments_get_policy', 'Read this account’s AUSD treasury rules, including per-payment and daily limits and any additional recipient allowlist.', {
    userId: z.string().optional(),
  }, async ({ userId }: { userId?: string }) => {
    try {
      const policy = await getPaymentPolicy(userId);
      return textResult({ ok: true, policy, summary: `AUSD payments allow saved contacts${policy.allowedRecipients ? ` and ${policy.allowedRecipients.length} allowlisted address(es)` : ''}; per-payment cap: ${policy.maxPaymentAUSD ?? 'not set'} AUSD; daily cap: ${policy.dailyLimitAUSD ?? 'not set'} AUSD.` });
    } catch (err) { return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
  });

  addTool(server, 'payments_set_policy', 'Configure hard AUSD invoice-payment limits and an optional EVM recipient allowlist. Every payee must still exist in saved contacts; rules are checked again atomically when a payment is reserved.', {
    maxPaymentAUSD: z.string().nullable().describe('Maximum amount per invoice payment, or null for no configured per-payment cap'),
    dailyLimitAUSD: z.string().nullable().describe('Maximum committed AUSD per UTC day, or null for no configured daily cap'),
    allowedRecipients: z.array(z.string()).nullable().describe('Optional EVM address allowlist; null permits any saved contact'),
    userId: z.string().optional(),
  }, async ({ maxPaymentAUSD, dailyLimitAUSD, allowedRecipients, userId }: { maxPaymentAUSD: string | null; dailyLimitAUSD: string | null; allowedRecipients: string[] | null; userId?: string }) => {
    try {
      const policy = await setPaymentPolicy(userId, { maxPaymentAUSD, dailyLimitAUSD, allowedRecipients });
      return textResult({ ok: true, policy, summary: `Treasury policy saved. AUSD only; per-payment cap ${maxPaymentAUSD ?? 'none'} AUSD; daily cap ${dailyLimitAUSD ?? 'none'} AUSD; ${allowedRecipients === null ? 'any saved contact may be paid' : `${policy.allowedRecipients?.length ?? 0} recipient address(es) allowlisted`}.` });
    } catch (err) { return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
  });

  addTool(server, 'payments_prepare_invoice', 'Prepare and validate an AUSD invoice payment without sending it. Checks recipient resolution, invoice reference duplication, wallet balance, and transaction simulation.', {
    invoiceId: z.string().describe('Invoice reference used to prevent duplicate payments'),
    recipient: z.string().describe('Name or exact address of a saved, verified contact'),
    amount: z.string().describe('AUSD amount, e.g. "250.00"'),
    reason: z.string().min(1).max(240).describe('Payment purpose or invoice description'),
    userId: z.string().optional(),
  }, async ({ invoiceId, recipient, amount, reason, userId }: { invoiceId: string; recipient: string; amount: string; reason: string; userId?: string }) => {
    try {
      if (env.MONAD_NETWORK !== 'mainnet') throw new Error('Agora AUSD payments are Monad mainnet only.');
      const id = normalizeInvoiceId(invoiceId);
      const duplicate = await findInvoicePayment(normalizeUser(userId), id);
      if (duplicate && ['processing', 'awaiting-approval', 'broadcast', 'confirmed'].includes(duplicate.status)) {
        return textResult({ ok: false, duplicate: true, existingStatus: duplicate.status, txHash: duplicate.txHash ?? null, error: `Invoice ${id} already has a ${duplicate.status} payment record.` });
      }
      const payee = await resolvePaymentContact(userId, recipient);
      const to = payee.address as `0x${string}`;
      const policy = await getPaymentPolicy(userId);
      const records = await listPayments(normalizeUser(userId), Number.MAX_SAFE_INTEGER);
      const policyCheck = assertPaymentPolicyAllows(policy, { recipientAddress: to, amount, token: 'AUSD', records });
      const riskCheck = paymentInvoiceRisk(records, { invoiceId: id, recipientAddress: to, amount, previousRecipientAddresses: payee.addressHistory?.map((entry) => entry.address) });
      const wallet = await resolveWallet(env, userId);
      const client = getPublicClient(env);
      if (await client.getChainId() !== 143) throw new Error('Configured RPC is not Monad mainnet (143).');
      const tokenCode = await client.getBytecode({ address: AUSD_ADDRESS });
      if (!tokenCode || tokenCode === '0x') throw new Error('Agora AUSD contract is not deployed at the documented Monad address on the configured RPC.');
      const amountRaw = parseAusdAmount(amount);
      const [balance, symbol] = await Promise.all([
        client.readContract({ address: AUSD_ADDRESS, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const, functionName: 'balanceOf', args: [wallet.address as `0x${string}`] }),
        client.readContract({ address: AUSD_ADDRESS, abi: [{ type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }] as const, functionName: 'symbol' }),
      ]);
      if (balance < amountRaw) throw new Error(`Insufficient AUSD balance. Available: ${formatUnits(balance, 6)} AUSD.`);
      const data = encodeFunctionData({ abi: TRANSFER_ABI, functionName: 'transfer', args: [to, amountRaw] });
      const simulation = await simulateTx(env, { from: wallet.address, to: AUSD_ADDRESS, value: 0n, data });
      if (!simulation.ok) throw new Error(`Payment simulation failed: ${simulation.reason}`);
      return textResult({
        ok: true, ready: true, invoiceId: id, token: String(symbol), tokenAddress: AUSD_ADDRESS,
        amount, amountRaw: amountRaw.toString(), from: wallet.address, recipient, recipientAddress: to,
        recipientExplorerUrl: explorerAddressUrl(env, to), estimatedFeeMON: formatEther(simulation.feeWei),
        treasuryPolicy: { maxPaymentAUSD: policy.maxPaymentAUSD, dailyLimitAUSD: policy.dailyLimitAUSD, dailyCommittedAUSD: formatAUSD(policyCheck.dailyCommittedRaw), dailyRemainingBeforePaymentAUSD: policyCheck.dailyRemainingRaw === null ? null : formatAUSD(policyCheck.dailyRemainingRaw) },
        network: 'Monad mainnet (143)', reason, riskCheck,
        summary: `Prepared invoice ${id}: ${amount} AUSD to ${recipient} (${to}). Estimated gas: ${formatEther(simulation.feeWei)} MON. No transaction was sent. Use payments_send_invoice after reviewing the details.`,
      });
    } catch (err) {
      return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  addTool(server, 'payments_send_invoice', 'Send a single AUSD invoice payment on Monad after mandatory human approval. Checks duplicate invoice references, recipient, balance, simulates, records the transaction, and verifies settlement.', {
    invoiceId: z.string().describe('Unique invoice reference within this user account'),
    recipient: z.string().describe('Name or exact address of a saved, verified contact'),
    amount: z.string().describe('AUSD amount, e.g. "250.00"'),
    reason: z.string().min(1).max(240).describe('Payment purpose or invoice description'),
    userId: z.string().optional(),
  }, async ({ invoiceId, recipient, amount, reason, userId }: { invoiceId: string; recipient: string; amount: string; reason: string; userId?: string }) => {
    let recordId: string | undefined;
    let submittedHash: string | undefined;
    let terminalFailure = false;
    try {
      if (env.MONAD_NETWORK !== 'mainnet') throw new Error('Agora AUSD payments are Monad mainnet only.');
      const id = normalizeInvoiceId(invoiceId);
      const owner = normalizeUser(userId);
      const duplicate = await findInvoicePayment(owner, id);
      if (duplicate && ['processing', 'awaiting-approval', 'broadcast', 'confirmed'].includes(duplicate.status)) {
        return textResult({ ok: false, duplicate: true, existingStatus: duplicate.status, txHash: duplicate.txHash ?? null, summary: `Payment blocked: invoice ${id} already has a ${duplicate.status} record${duplicate.txHash ? ` (${duplicate.txHash})` : ''}.` });
      }
      const payee = await resolvePaymentContact(userId, recipient);
      const to = payee.address as `0x${string}`;
      const policy = await getPaymentPolicy(userId);
      const policyRecords = await listPayments(owner, Number.MAX_SAFE_INTEGER);
      const policyCheck = assertPaymentPolicyAllows(policy, { recipientAddress: to, amount, token: 'AUSD', records: policyRecords });
      const riskCheck = paymentInvoiceRisk(policyRecords, { invoiceId: id, recipientAddress: to, amount, previousRecipientAddresses: payee.addressHistory?.map((entry) => entry.address) });
      const wallet = await resolveWallet(env, userId);
      const client = getPublicClient(env);
      if (await client.getChainId() !== 143) throw new Error('Configured RPC is not Monad mainnet (143).');
      const tokenCode = await client.getBytecode({ address: AUSD_ADDRESS });
      if (!tokenCode || tokenCode === '0x') throw new Error('Agora AUSD contract is not deployed at the documented Monad address on the configured RPC.');
      const amountRaw = parseAusdAmount(amount);
      const balance = await client.readContract({ address: AUSD_ADDRESS, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const, functionName: 'balanceOf', args: [wallet.address as `0x${string}`] });
      if (balance < amountRaw) throw new Error(`Insufficient AUSD balance. Available: ${formatUnits(balance, 6)} AUSD.`);
      const data = encodeFunctionData({ abi: TRANSFER_ABI, functionName: 'transfer', args: [to, amountRaw] });
      const simulation = await simulateTx(env, { from: wallet.address, to: AUSD_ADDRESS, value: 0n, data });
      if (!simulation.ok) throw new Error(`Payment simulation failed: ${simulation.reason}`);

      const reservation = await reserveInvoicePayment({ userId: owner, invoiceId: id, recipientName: payee.name, recipientAddress: to, token: 'AUSD', amount, reason, status: 'processing' }, policy);
      if (reservation.duplicate) return textResult({ ok: false, duplicate: true, existingStatus: reservation.duplicate.status, txHash: reservation.duplicate.txHash ?? null, summary: `Payment blocked: invoice ${id} already has a ${reservation.duplicate.status} record.` });
      if (!reservation.record) throw new Error('Could not reserve invoice reference.');
      recordId = reservation.record.id;

      const gate = await approvalGate({
        action: 'payments_send_invoice',
        details: { invoiceId: id, from: wallet.address, recipient: payee.name, recipientAddress: to, token: 'AUSD', tokenAddress: AUSD_ADDRESS, amount, amountRaw: amountRaw.toString(), reason, simulatedFeeMON: formatEther(simulation.feeWei), chainId: 143, riskCheck, treasuryPolicy: { maxPaymentAUSD: policy.maxPaymentAUSD, dailyLimitAUSD: policy.dailyLimitAUSD, dailyCommittedAUSD: formatAUSD(policyCheck.dailyCommittedRaw) } },
        valueWei: 0n, env, forceApproval: true, reason: `Pay invoice ${id}: ${amount} AUSD to ${recipient}`, userId,
      });
      if (gate.decision !== 'approved') {
        await updatePayment(recordId, { status: 'rejected', requestId: gate.requestId ?? undefined, note: gate.message });
        await auditLog({ tool: 'payments_send_invoice', userId, result: 'rejected', params: { invoiceId: id, recipientAddress: to, amount, requestId: gate.requestId } });
        return textResult({ ok: false, approvalRequired: true, requestId: gate.requestId, invoiceId: id, summary: `Invoice payment was not sent. ${gate.message}` });
      }

      await updatePayment(recordId, { status: 'awaiting-approval', requestId: gate.requestId ?? undefined });
      const hash = await privySendTransaction(env, wallet, { to: AUSD_ADDRESS, value: 0n, data });
      submittedHash = hash;
      await updatePayment(recordId, { status: 'broadcast', txHash: hash });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        terminalFailure = true;
        await updatePayment(recordId, { status: 'failed', txHash: hash, note: 'The chain returned a reverted receipt.' });
        throw new Error(`AUSD payment reverted on-chain: ${hash}`);
      }
      await updatePayment(recordId, { status: 'confirmed', txHash: hash, blockNumber: receipt.blockNumber.toString(), confirmedAt: new Date().toISOString() });
      await auditLog({ tool: 'payments_send_invoice', userId, result: 'ok', txHash: hash, intent: reason, params: { invoiceId: id, recipientAddress: to, amount, token: 'AUSD' } });
      return textResult({ ok: true, status: 'confirmed', invoiceId: id, token: 'AUSD', amount, from: wallet.address, recipient, recipientAddress: to, txHash: hash, explorerUrl: explorerTxUrl(env, hash), blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), summary: `Invoice ${id} paid: ${amount} AUSD to ${recipient}. Confirmed in block ${receipt.blockNumber}. Receipt: ${explorerTxUrl(env, hash)}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (recordId) await updatePayment(recordId, {
        status: submittedHash && !terminalFailure ? 'broadcast' : 'failed',
        ...(submittedHash ? { txHash: submittedHash } : {}),
        note: message,
      });
      await auditLog({ tool: 'payments_send_invoice', userId, result: 'error', error: message, params: { invoiceId, recordId } });
      return textResult({ ok: false, status: submittedHash && !terminalFailure ? 'broadcast' : 'failed', txHash: submittedHash ?? null, error: message, summary: submittedHash && !terminalFailure ? `Transaction ${submittedHash} was broadcast but its receipt is not yet confirmed. Invoice retry remains blocked to prevent a duplicate payment; check payments_history or the transaction explorer. ${message}` : `Invoice payment did not complete: ${message}` });
    }
  });

  addTool(server, 'payments_history', 'List this user’s AUSD invoice payment records with status, invoice reference, recipient, and transaction links.', {
    limit: z.number().int().min(1).max(100).default(25),
    userId: z.string().optional(),
  }, async ({ limit, userId }: { limit: number; userId?: string }) => {
    const records = await listPayments(normalizeUser(userId), limit);
    return textResult({ ok: true, count: records.length, payments: records.map((entry) => ({ ...entry, explorerUrl: entry.txHash ? explorerTxUrl(env, entry.txHash) : null })), summary: records.length ? `${records.length} payment records. Check each status and explorer receipt for settlement.` : 'No invoice payments are recorded yet.' });
  });

  addTool(server, 'payments_closeout', 'Summarize AUSD invoice payments over a date range for reconciliation. Totals include confirmed payments only; outstanding, rejected, and failed records are shown separately.', {
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Inclusive start date, YYYY-MM-DD'),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Inclusive end date, YYYY-MM-DD'),
    format: z.enum(['json', 'csv']).default('json').describe('Return a spreadsheet-safe CSV export or structured JSON'),
    userId: z.string().optional(),
  }, async ({ fromDate, toDate, format, userId }: { fromDate: string; toDate: string; format: 'json' | 'csv'; userId?: string }) => {
    try {
      const [records, requests] = await Promise.all([
        listPayments(normalizeUser(userId), Number.MAX_SAFE_INTEGER),
        listPaymentRequests(normalizeUser(userId), Number.MAX_SAFE_INTEGER),
      ]);
      const closeout = createPaymentCloseout(records, fromDate, toDate);
      const asDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
      const endExclusive = new Date(asDate(toDate).valueOf() + 86_400_000);
      const inRange = (value?: string) => {
        if (!value) return false;
        const date = new Date(value);
        return date >= asDate(fromDate) && date < endExclusive;
      };
      const incomingRecords = requests.filter((request) => inRange(request.paidAt) || inRange(request.refundAt) || (request.status !== 'paid' && inRange(request.createdAt)));
      const incomingPaid = incomingRecords.filter((request) => request.status === 'paid' && inRange(request.paidAt));
      const refunded = incomingRecords.filter((request) => request.refundStatus === 'refunded' && inRange(request.refundAt));
      const incomingTotalRaw = incomingPaid.reduce((sum, request) => sum + parseAusdAmount(request.amount), 0n);
      const refundTotalRaw = refunded.reduce((sum, request) => sum + parseAusdAmount(request.amount), 0n);
      const netTotalRaw = incomingTotalRaw - refundTotalRaw;
      const formatSignedAUSD = (raw: bigint) => `${raw < 0n ? '-' : ''}${formatAUSD(raw < 0n ? -raw : raw)}`;
      const incomingStatuses = Object.fromEntries((['open', 'paid', 'review', 'expired'] as const).map((status) => [status, incomingRecords.filter((request) => request.status === status).length]));
      const outgoingCsv = paymentCloseoutCsv(closeout.records).split('\n').slice(1);
      const incomingCsv = paymentRequestCloseoutCsv(incomingRecords).split('\n').slice(1);
      const csv = ['direction,invoiceId,partyName,partyAddress,token,amount,reason,status,txHash,blockNumber,createdAt,settledAt,refundTxHash,refundAt,note', ...outgoingCsv, ...incomingCsv].join('\n');
      return textResult({ ok: true, ...closeout, incoming: { confirmedCount: incomingPaid.length, grossConfirmedAmountRaw: incomingTotalRaw.toString(), grossConfirmedAmount: formatAUSD(incomingTotalRaw), refundCount: refunded.length, refundedAmountRaw: refundTotalRaw.toString(), refundedAmount: formatAUSD(refundTotalRaw), netAmount: formatSignedAUSD(netTotalRaw), statuses: incomingStatuses, records: incomingRecords.map((request) => ({ ...request, explorerUrl: request.txHash ? explorerTxUrl(env, request.txHash) : null, refundExplorerUrl: request.refundTxHash ? explorerTxUrl(env, request.refundTxHash) : null })) }, csv: format === 'csv' ? csv : undefined, records: closeout.records.map((record) => ({ ...record, explorerUrl: record.txHash ? explorerTxUrl(env, record.txHash) : null })), scope: 'Mochi payment and request records only; exact incoming request matches are included, unmatched blockchain payments and fiat settlement are not; CSV is an export, not a direct accounting-platform sync', summary: `${closeout.confirmedCount} confirmed AUSD payouts totaling ${closeout.confirmedAmount} AUSD. Incoming merchant receipts: ${formatAUSD(incomingTotalRaw)} gross, ${formatAUSD(refundTotalRaw)} refunded, ${formatSignedAUSD(netTotalRaw)} net from ${fromDate} through ${toDate}. Unconfirmed or review statuses are listed separately.${format === 'csv' ? ' Spreadsheet-safe combined in/out CSV is included.' : ''}` });
    } catch (err) { return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
  });

  addTool(server, 'payments_create_request', 'Create an AUSD payment request for a Monad customer. Returns an EIP-681 wallet payment URI and a chat-widget payload. The request is matched against on-chain AUSD transfers; ambiguous matching is sent to manual review.', {
    invoiceId: z.string().describe('Unique human invoice/reference within this merchant account'),
    amount: z.string().describe('AUSD amount, up to 6 decimal places'),
    reason: z.string().min(1).max(240).describe('What the customer is paying for'),
    expiresInHours: z.number().int().min(1).max(PAYMENT_REQUEST_HOURS_MAX).default(72),
    userId: z.string().optional(),
  }, async ({ invoiceId, amount, reason, expiresInHours, userId }: { invoiceId: string; amount: string; reason: string; expiresInHours: number; userId?: string }) => {
    try {
      if (env.MONAD_NETWORK !== 'mainnet') throw new Error('AUSD payment collection requests are Monad mainnet only.');
      const wallet = await resolveWallet(env, userId);
      assertAddress(wallet.address, 'merchant wallet');
      const invoice = normalizeInvoiceId(invoiceId);
      const amountRaw = parseAusdAmount(amount);
      const client = getPublicClient(env);
      if (await client.getChainId() !== 143) throw new Error('Configured RPC is not Monad mainnet (143).');
      const code = await client.getBytecode({ address: AUSD_ADDRESS });
      if (!code || code === '0x') throw new Error('AUSD token contract is not deployed at the configured Monad mainnet address.');
      const createdBlock = await client.getBlockNumber();
      const expiresAt = new Date(Date.now() + expiresInHours * 3_600_000).toISOString();
      const paymentUri = `ethereum:${AUSD_ADDRESS}@143/transfer?address=${wallet.address}&uint256=${amountRaw}`;
      const qrDataUrl = await QRCode.toDataURL(paymentUri, { errorCorrectionLevel: 'M', margin: 2, width: 240 });
      const stored = await createPaymentRequest({ userId: normalizeUser(userId), invoiceId: invoice, merchantAddress: wallet.address.toLowerCase(), token: 'AUSD', amount, reason: reason.trim(), expiresAt, createdBlock: createdBlock.toString() });
      if (stored.duplicate) return textResult({ ok: false, duplicate: true, request: stored.duplicate, summary: `Invoice ${invoice} already has a ${stored.duplicate.status} payment request.` });
      if (!stored.record) throw new Error('Could not create the payment request.');
      await auditLog({ tool: 'payments_create_request', userId, result: 'ok', intent: `Request ${amount} AUSD for ${reason.trim()}`, params: { invoiceId: invoice, merchantAddress: wallet.address, amount, expiresAt, requestId: stored.record.id } });
      return textResult({ ok: true, request: stored.record, paymentUri, paymentLink: paymentUri, qrDataUrl, widgetData: { invoiceId: invoice, amount, token: 'AUSD', merchantAddress: wallet.address, reason: reason.trim(), paymentUri, qrDataUrl, expiresAt, requestId: stored.record.id }, matching: 'Unique exact-amount AUSD transfer after the request block can be confirmed automatically. If more than one request/transfer can match, Mochi flags it for manual review.', summary: `Created payment request ${invoice} for ${amount} AUSD to ${wallet.address}. It expires ${expiresAt}. Share the QR or payment URI, then call payments_check_request to verify settlement. No blockchain transaction was sent.` });
    } catch (err) { return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
  });

  addTool(server, 'payments_check_request', 'Check a merchant payment request against Monad mainnet AUSD Transfer events. Mochi only marks a request paid when it finds one unambiguous exact-amount transfer; ambiguous/partial cases remain for human review.', {
    requestId: z.string().describe('Mochi payment request ID or invoice reference'),
    userId: z.string().optional(),
  }, async ({ requestId, userId }: { requestId: string; userId?: string }) => {
    try {
      if (env.MONAD_NETWORK !== 'mainnet') throw new Error('Payment request monitoring is Monad mainnet only.');
      const owner = normalizeUser(userId);
      const request = await getPaymentRequest(owner, requestId);
      if (!request) throw new Error('Payment request not found for this account.');
      if (request.status === 'paid') return textResult({ ok: true, status: 'paid', request, explorerUrl: request.txHash ? explorerTxUrl(env, request.txHash) : null, summary: `Invoice ${request.invoiceId} is paid. Verify the receipt at ${request.txHash ? explorerTxUrl(env, request.txHash) : 'the transaction explorer'}.` });
      if (Date.now() >= Date.parse(request.expiresAt)) {
        const expired = await updatePaymentRequest(request.id, { status: 'expired', note: 'Request expired before an unambiguous exact payment was observed.' });
        await auditLog({ tool: 'payments_check_request', userId, result: 'ok', intent: `Payment request ${request.invoiceId} expired`, params: { requestId: request.id, status: 'expired' } });
        return textResult({ ok: true, status: 'expired', request: expired, summary: `Payment request ${request.invoiceId} expired. No unique exact-amount transfer was confirmed by Mochi.` });
      }
      const client = getPublicClient(env);
      if (await client.getChainId() !== 143) throw new Error('Configured RPC is not Monad mainnet (143).');
      const latestHead = await client.getBlockNumber();
      const latest = latestHead > 2n ? latestHead - 2n : latestHead;
      if (BigInt(request.createdBlock) > latest) return textResult({ ok: true, status: 'open', request, safeBlock: latest.toString(), summary: `Invoice ${request.invoiceId} is waiting for two additional Monad blocks before Mochi checks for settlement.` });
      const maxRange = 100_000n;
      const fromBlock = BigInt(request.createdBlock) > latest - (latest > maxRange ? maxRange : latest) ? BigInt(request.createdBlock) : latest > maxRange ? latest - maxRange : 0n;
      const scanComplete = fromBlock <= BigInt(request.createdBlock);
      const logs = await client.getLogs({ address: AUSD_ADDRESS, event: TRANSFER_EVENT, args: { to: request.merchantAddress as `0x${string}` }, fromBlock, toBlock: latest });
      const exact = logs.filter((log) => log.args.value === parseAusdAmount(request.amount));
      const matchingRequests = (await listPaymentRequests(owner, 1000)).filter((item) => ['open', 'review'].includes(item.status) && Date.parse(item.expiresAt) > Date.now() && item.id !== request.id && item.merchantAddress.toLowerCase() === request.merchantAddress.toLowerCase() && parseAusdAmount(item.amount) === parseAusdAmount(request.amount) && BigInt(item.createdBlock) <= latest && BigInt(item.createdBlock) <= (exact[0]?.blockNumber ?? -1n));
      if (exact.length === 1 && matchingRequests.length === 0) {
        const log = exact[0]!;
        const updated = await updatePaymentRequest(request.id, { status: 'paid', txHash: log.transactionHash ?? undefined, payerAddress: log.args.from, blockNumber: log.blockNumber?.toString(), paidAt: new Date().toISOString(), note: undefined });
        await auditLog({ tool: 'payments_check_request', userId, result: 'ok', txHash: log.transactionHash ?? undefined, intent: `Confirmed payment for invoice ${request.invoiceId}`, params: { requestId: request.id, payerAddress: log.args.from, amount: request.amount } });
        return textResult({ ok: true, status: 'paid', request: updated, explorerUrl: log.transactionHash ? explorerTxUrl(env, log.transactionHash) : null, match: { payerAddress: log.args.from, amount: request.amount, blockNumber: log.blockNumber?.toString() ?? null }, summary: `Payment confirmed: invoice ${request.invoiceId} received exactly ${request.amount} AUSD from ${log.args.from}. Receipt: ${log.transactionHash ? explorerTxUrl(env, log.transactionHash) : 'transaction link unavailable'}` });
      }
      if (exact.length > 1 || matchingRequests.length > 0) {
        const updated = await updatePaymentRequest(request.id, { status: 'review', note: 'More than one exact transfer or open invoice can match this request; automatic attribution was withheld.' });
        await auditLog({ tool: 'payments_check_request', userId, result: 'ok', intent: `Payment request ${request.invoiceId} needs manual match review`, params: { requestId: request.id, candidateCount: exact.length, conflictingInvoiceCount: matchingRequests.length } });
        return textResult({ ok: true, status: 'review', request: updated, candidates: exact.map((log) => ({ from: log.args.from, txHash: log.transactionHash, blockNumber: log.blockNumber?.toString(), explorerUrl: log.transactionHash ? explorerTxUrl(env, log.transactionHash) : null })), conflictingInvoices: matchingRequests.map((item) => item.invoiceId), summary: `Mochi found potentially matching transfers for ${request.invoiceId}, but cannot safely attribute them automatically. Review the payer, amount, time, and explorer links before marking it paid.` });
      }
      const candidates = logs.slice(-20).map((log) => ({ from: log.args.from, amountRaw: log.args.value?.toString(), txHash: log.transactionHash, blockNumber: log.blockNumber?.toString() }));
      return textResult({ ok: true, status: request.status, request, scannedBlocks: { from: fromBlock.toString(), to: latest.toString(), complete: scanComplete }, nearbyIncomingTransfers: candidates, summary: exact.length === 0 ? `No exact ${request.amount} AUSD payment was found for invoice ${request.invoiceId} in the scanned range. ${scanComplete ? 'The request block is included.' : 'The request is older than this RPC scan window; use an indexer or inspect the explorer before treating it as unpaid.'} Any partial or excess transfer needs manual matching.` : `Payment request ${request.invoiceId} needs manual review.` });
    } catch (err) { return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
  });

  addTool(server, 'payments_inbox', 'Show merchant payment requests and settlement/refund state. Open requests are not proof of payment; use payments_check_request to inspect Monad events before confirming one.', {
    limit: z.number().int().min(1).max(100).default(25), userId: z.string().optional(),
  }, async ({ limit, userId }: { limit: number; userId?: string }) => {
    try {
      const requests = await listPaymentRequests(normalizeUser(userId), limit);
      const rows = requests.map((request) => ({ ...request, explorerUrl: request.txHash ? explorerTxUrl(env, request.txHash) : null, refundExplorerUrl: request.refundTxHash ? explorerTxUrl(env, request.refundTxHash) : null }));
      const open = requests.filter((request) => request.status === 'open').length;
      const review = requests.filter((request) => request.status === 'review').length;
      const paid = requests.filter((request) => request.status === 'paid').length;
      return textResult({ ok: true, count: rows.length, openCount: open, reviewCount: review, paidCount: paid, requests: rows, summary: `${open} open, ${review} needing manual payment matching, and ${paid} paid request(s) in the latest ${rows.length} merchant requests. Use payments_check_request for an open request before confirming receipt.` });
    } catch (err) { return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
  });

  const payoutItemsSchema = z.array(z.object({
    invoiceId: z.string().min(1).max(64), recipient: z.string().min(1).max(128), amount: z.string(), reason: z.string().min(1).max(240),
  })).min(1).max(20).describe('One to twenty distinct AUSD payees with saved contacts and unique invoice references');

  addTool(server, 'payments_send_payout_batch', 'Prepare, policy-check, simulate, and send a batch of up to 20 AUSD supplier or contractor payments. One forced human approval covers the exact complete batch; each transfer gets its own record and receipt, and partial completion is reported without retrying successful items.', {
    items: payoutItemsSchema,
    userId: z.string().optional(),
  }, async ({ items, userId }: { items: Array<{ invoiceId: string; recipient: string; amount: string; reason: string }>; userId?: string }) => {
    const batchId = randomUUID();
    const records: Array<{ id: string; invoiceId: string; recipientName: string; recipientAddress: string; amount: string; reason: string }> = [];
    const submitted: Array<{ invoiceId: string; status: string; txHash?: string; error?: string }> = [];
    try {
      if (env.MONAD_NETWORK !== 'mainnet') throw new Error('AUSD payout batches are Monad mainnet only.');
      const owner = normalizeUser(userId);
      const ids = items.map((item) => normalizeInvoiceId(item.invoiceId));
      if (new Set(ids).size !== ids.length) throw new Error('Each payout in a batch must have a distinct invoice reference.');
      const payees = await Promise.all(items.map((item) => resolvePaymentContact(userId, item.recipient)));
      const normalized = items.map((item, index) => ({ ...item, invoiceId: ids[index]!, payee: payees[index]!, amountRaw: parseAusdAmount(item.amount) }));
      const totalRaw = normalized.reduce((sum, item) => sum + item.amountRaw, 0n);
      const policy = await getPaymentPolicy(userId);
      const prior = await listPayments(owner, Number.MAX_SAFE_INTEGER);
      for (const item of normalized) assertPaymentPolicyAllows(policy, { recipientAddress: item.payee.address, amount: item.amount, token: 'AUSD', records: prior });
      const wallet = await resolveWallet(env, userId);
      const client = getPublicClient(env);
      if (await client.getChainId() !== 143) throw new Error('Configured RPC is not Monad mainnet (143).');
      if (!(await client.getBytecode({ address: AUSD_ADDRESS }))) throw new Error('AUSD token contract is unavailable on the configured RPC.');
      const balance = await client.readContract({ address: AUSD_ADDRESS, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const, functionName: 'balanceOf', args: [wallet.address as `0x${string}`] });
      if (balance < totalRaw) throw new Error(`Insufficient AUSD for the batch. Need ${formatAUSD(totalRaw)}; available ${formatUnits(balance, 6)}.`);
      const prepared = await Promise.all(normalized.map(async (item) => {
        const data = encodeFunctionData({ abi: TRANSFER_ABI, functionName: 'transfer', args: [item.payee.address as `0x${string}`, item.amountRaw] });
        const simulation = await simulateTx(env, { from: wallet.address, to: AUSD_ADDRESS, value: 0n, data });
        if (!simulation.ok) throw new Error(`Simulation failed for invoice ${item.invoiceId}: ${simulation.reason}`);
        return { item, data, feeWei: simulation.feeWei, riskCheck: paymentInvoiceRisk(prior, { invoiceId: item.invoiceId, recipientAddress: item.payee.address, amount: item.amount, previousRecipientAddresses: item.payee.addressHistory?.map((entry) => entry.address) }) };
      }));
      const reserved = await reserveInvoicePayments(prepared.map(({ item, riskCheck }) => ({
        userId: owner, invoiceId: item.invoiceId, recipientName: item.payee.name, recipientAddress: item.payee.address,
        token: 'AUSD' as const, amount: item.amount, reason: item.reason, status: 'processing' as const, batchId,
        note: riskCheck.flags.length ? `Review signals: ${riskCheck.flags.join(' ')}` : undefined,
      })), { maxPaymentAUSD: policy.maxPaymentAUSD, dailyLimitAUSD: policy.dailyLimitAUSD, allowedRecipients: policy.allowedRecipients });
      if (reserved.duplicate) return textResult({ ok: false, duplicate: true, existingInvoiceId: reserved.duplicate.invoiceId, status: reserved.duplicate.status, txHash: reserved.duplicate.txHash ?? null, summary: `Batch stopped before approval because invoice ${reserved.duplicate.invoiceId} already has a committed payment.` });
      records.push(...reserved.records.map(({ id, invoiceId, recipientName, recipientAddress, amount, reason }) => ({ id, invoiceId, recipientName, recipientAddress, amount, reason })));
      if (records.length !== items.length) throw new Error('The batch reservation did not contain every requested payment.');
      const totalFeeWei = prepared.reduce((sum, row) => sum + row.feeWei, 0n);
      const gate = await approvalGate({ action: 'payments_send_payout_batch', details: { batchId, from: wallet.address, chainId: 143, token: 'AUSD', tokenAddress: AUSD_ADDRESS, paymentCount: items.length, totalAmount: formatAUSD(totalRaw), estimatedTotalFeeMON: formatEther(totalFeeWei), payments: prepared.map(({ item, riskCheck }) => ({ invoiceId: item.invoiceId, recipient: item.payee.name, recipientAddress: item.payee.address, amount: item.amount, reason: item.reason, riskCheck })) }, valueWei: 0n, env, forceApproval: true, reason: `Pay ${items.length} AUSD invoices totaling ${formatAUSD(totalRaw)} AUSD`, userId });
      if (gate.decision !== 'approved') {
        await Promise.all(records.map((record) => updatePayment(record.id, { status: 'rejected', requestId: gate.requestId ?? undefined, note: gate.message })));
        await auditLog({ tool: 'payments_send_payout_batch', userId, result: 'rejected', intent: `Payout batch ${batchId} not sent`, params: { batchId, paymentCount: items.length, totalAmount: formatAUSD(totalRaw), requestId: gate.requestId } });
        return textResult({ ok: false, approvalRequired: true, requestId: gate.requestId, batchId, payments: records.map(({ invoiceId, amount, recipientName }) => ({ invoiceId, amount, recipient: recipientName, status: 'rejected' })), summary: `No batch transfers were sent. Approval was rejected or unavailable: ${gate.message}` });
      }
      for (let index = 0; index < prepared.length; index++) {
        const row = prepared[index]!;
        const record = records[index]!;
        let itemHash: `0x${string}` | undefined;
        try {
          await updatePayment(record.id, { status: 'awaiting-approval', requestId: gate.requestId ?? undefined });
          const txHash = await privySendTransaction(env, wallet, { to: AUSD_ADDRESS, value: 0n, data: row.data });
          itemHash = txHash;
          submitted.push({ invoiceId: row.item.invoiceId, status: 'broadcast', txHash });
          await updatePayment(record.id, { status: 'broadcast', txHash });
          const receipt = await client.waitForTransactionReceipt({ hash: txHash });
          if (receipt.status !== 'success') {
            await updatePayment(record.id, { status: 'failed', note: 'Transaction reverted on-chain.' });
            submitted[submitted.length - 1] = { invoiceId: row.item.invoiceId, status: 'failed', txHash, error: 'Transaction reverted on-chain.' };
            continue;
          }
          await updatePayment(record.id, { status: 'confirmed', blockNumber: receipt.blockNumber.toString(), confirmedAt: new Date().toISOString() });
          submitted[submitted.length - 1] = { invoiceId: row.item.invoiceId, status: 'confirmed', txHash };
          await auditLog({ tool: 'payments_send_payout_batch', userId, result: 'ok', txHash, intent: row.item.reason, params: { batchId, invoiceId: row.item.invoiceId, recipientAddress: row.item.payee.address, amount: row.item.amount } });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!itemHash) {
            await updatePayment(record.id, { status: 'failed', note: message });
            submitted.push({ invoiceId: row.item.invoiceId, status: 'failed', error: message });
            await auditLog({ tool: 'payments_send_payout_batch', userId, result: 'error', error: message, params: { batchId, invoiceId: row.item.invoiceId, recipientAddress: row.item.payee.address, amount: row.item.amount } });
          } else {
            await updatePayment(record.id, { status: 'broadcast', txHash: itemHash, note: message });
            const entry = submitted.find((item) => item.invoiceId === row.item.invoiceId);
            if (entry) { entry.status = 'broadcast'; entry.txHash = itemHash; entry.error = message; }
          }
        }
      }
      const confirmedCount = submitted.filter((entry) => entry.status === 'confirmed').length;
      const broadcastCount = submitted.filter((entry) => entry.status === 'broadcast').length;
      const failedCount = submitted.filter((entry) => entry.status === 'failed').length;
      return textResult({ ok: failedCount === 0 && broadcastCount === 0, batchId, totalAmount: formatAUSD(totalRaw), token: 'AUSD', confirmedCount, broadcastCount, failedCount, payments: submitted.map((entry) => ({ ...entry, explorerUrl: entry.txHash ? explorerTxUrl(env, entry.txHash) : null })), summary: `${confirmedCount}/${items.length} payout(s) confirmed. ${broadcastCount} are broadcast but unconfirmed and must not be retried; ${failedCount} failed. Batch reference: ${batchId}.` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await Promise.all(records.map((record) => updatePayment(record.id, { status: 'failed', note: message })));
      return textResult({ ok: false, batchId, payments: submitted, error: message, summary: `Payout batch stopped: ${message}` });
    }
  });

  addTool(server, 'payments_cashflow_forecast', 'Project AUSD cash after a caller-provided list of upcoming bills and expected receipts, starting from the connected wallet balance. Flags dates where the projected balance falls below zero; includes only the data supplied for this forecast.', {
    fromDate: z.string(), toDate: z.string(),
    obligations: z.array(z.object({ label: z.string(), date: z.string(), amount: z.string() })).max(100).default([]),
    expectedReceipts: z.array(z.object({ label: z.string(), date: z.string(), amount: z.string() })).max(100).default([]),
    userId: z.string().optional(),
  }, async ({ fromDate, toDate, obligations, expectedReceipts, userId }: { fromDate: string; toDate: string; obligations: Array<{ label: string; date: string; amount: string }>; expectedReceipts: Array<{ label: string; date: string; amount: string }>; userId?: string }) => {
    try {
      if (env.MONAD_NETWORK !== 'mainnet') throw new Error('Cashflow balance reads are Monad mainnet only.');
      const wallet = await resolveWallet(env, userId);
      const client = getPublicClient(env);
      if (await client.getChainId() !== 143) throw new Error('Configured RPC is not Monad mainnet (143).');
      const balance = await client.readContract({ address: AUSD_ADDRESS, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const, functionName: 'balanceOf', args: [wallet.address as `0x${string}`] });
      const forecast = forecastAusdCashflow(formatUnits(balance, 6), obligations, expectedReceipts, fromDate, toDate);
      return textResult({ ok: true, wallet: wallet.address, currentOnchainBalance: formatUnits(balance, 6), ...forecast, summary: forecast.shortfallCount ? `The supplied AUSD schedule projects a negative balance at ${forecast.shortfallCount} event(s); first shortfall ${forecast.shortfalls[0]?.date} after ${forecast.shortfalls[0]?.label}. This is a scenario, not a bank/accounting forecast.` : `The supplied schedule ends at ${forecast.projectedClosingBalance} AUSD with no negative event balance. Unlisted receipts, expenses, and token prices are not included.` });
    } catch (err) { return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
  });

  addTool(server, 'payments_refund_request', 'Prepare a full AUSD refund for a Mochi payment request that was confirmed on-chain. Verifies the original incoming transfer, payer, merchant wallet, balance, and simulation; always requires a fresh human approval. Partial refunds are not supported.', {
    requestId: z.string(), userId: z.string().optional(),
  }, async ({ requestId, userId }: { requestId: string; userId?: string }) => {
    let requestIdForRollback: string | undefined;
    let hash: `0x${string}` | undefined;
    let terminalFailure = false;
    try {
      if (env.MONAD_NETWORK !== 'mainnet') throw new Error('AUSD refunds are Monad mainnet only.');
      const owner = normalizeUser(userId);
      const request = await getPaymentRequest(owner, requestId);
      if (!request || request.status !== 'paid' || !request.txHash || !request.blockNumber || !request.payerAddress) throw new Error('Refund requires a paid request with a verified payer, block, and transaction hash.');
      if (request.refundStatus === 'processing' || request.refundStatus === 'broadcast' || request.refundStatus === 'refunded') throw new Error(`Refund is already ${request.refundStatus}; do not retry without reconciling its status.`);
      const wallet = await resolveWallet(env, userId);
      if (wallet.address.toLowerCase() !== request.merchantAddress.toLowerCase()) throw new Error('The connected merchant wallet does not match the original payment receiver.');
      const client = getPublicClient(env);
      if (await client.getChainId() !== 143) throw new Error('Configured RPC is not Monad mainnet (143).');
      const incoming = await client.getLogs({ address: AUSD_ADDRESS, event: TRANSFER_EVENT, args: { from: request.payerAddress as `0x${string}`, to: request.merchantAddress as `0x${string}` }, fromBlock: BigInt(request.blockNumber), toBlock: BigInt(request.blockNumber) });
      const verified = incoming.find((log) => log.transactionHash?.toLowerCase() === request.txHash!.toLowerCase() && log.args.value === parseAusdAmount(request.amount));
      if (!verified) throw new Error('Could not verify the original exact-amount AUSD transfer on-chain; refund is blocked.');
      const amountRaw = parseAusdAmount(request.amount);
      const balance = await client.readContract({ address: AUSD_ADDRESS, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }] as const, functionName: 'balanceOf', args: [wallet.address as `0x${string}`] });
      if (balance < amountRaw) throw new Error(`Insufficient AUSD for a full refund. Available: ${formatUnits(balance, 6)} AUSD.`);
      const data = encodeFunctionData({ abi: TRANSFER_ABI, functionName: 'transfer', args: [request.payerAddress as `0x${string}`, amountRaw] });
      const simulation = await simulateTx(env, { from: wallet.address, to: AUSD_ADDRESS, value: 0n, data });
      if (!simulation.ok) throw new Error(`Refund simulation failed: ${simulation.reason}`);
      const reserved = await updatePaymentRequest(request.id, { refundStatus: 'processing' });
      if (!reserved) throw new Error('Could not reserve refund request.');
      requestIdForRollback = request.id;
      const gate = await approvalGate({ action: 'payments_refund_request', details: { requestId: request.id, invoiceId: request.invoiceId, originalPaymentTx: request.txHash, from: wallet.address, payer: request.payerAddress, amount: request.amount, token: 'AUSD', tokenAddress: AUSD_ADDRESS, chainId: 143, simulatedFeeMON: formatEther(simulation.feeWei), refundType: 'full' }, valueWei: 0n, env, forceApproval: true, reason: `Full refund for invoice ${request.invoiceId}`, userId });
      if (gate.decision !== 'approved') {
        await updatePaymentRequest(request.id, { refundStatus: undefined, refundTxHash: undefined, note: `Refund not sent: ${gate.message}` });
        await auditLog({ tool: 'payments_refund_request', userId, result: 'rejected', intent: `Refund for invoice ${request.invoiceId} was not sent`, params: { requestId: request.id, originalPaymentTx: request.txHash, requestIdForApproval: gate.requestId, gate: gate.message } });
        return textResult({ ok: false, approvalRequired: true, requestId: gate.requestId, summary: `No refund was sent. ${gate.message}` });
      }
      hash = await privySendTransaction(env, wallet, { to: AUSD_ADDRESS, value: 0n, data });
      await updatePaymentRequest(request.id, { refundStatus: 'broadcast', refundTxHash: hash });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        terminalFailure = true;
        await updatePaymentRequest(request.id, { refundStatus: 'failed', note: 'Refund transaction reverted on-chain.' });
        throw new Error(`Refund transaction reverted: ${hash}`);
      }
      const updated = await updatePaymentRequest(request.id, { refundStatus: 'refunded', refundTxHash: hash, refundAt: new Date().toISOString(), note: undefined });
      await auditLog({ tool: 'payments_refund_request', userId, result: 'ok', txHash: hash, intent: `Full refund for invoice ${request.invoiceId}`, params: { requestId: request.id, originalPaymentTx: request.txHash, payer: request.payerAddress, amount: request.amount } });
      return textResult({ ok: true, status: 'refunded', request: updated, originalPaymentUrl: explorerTxUrl(env, request.txHash), refundTxHash: hash, explorerUrl: explorerTxUrl(env, hash), amount: request.amount, recipient: request.payerAddress, summary: `Refunded ${request.amount} AUSD to the original payer for invoice ${request.invoiceId}. Refund receipt: ${explorerTxUrl(env, hash)}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (requestIdForRollback) await updatePaymentRequest(requestIdForRollback, hash && !terminalFailure ? { refundStatus: 'broadcast', refundTxHash: hash, note: message } : { refundStatus: 'failed', ...(hash ? { refundTxHash: hash } : {}), note: message });
      await auditLog({ tool: 'payments_refund_request', userId, result: 'error', ...(hash ? { txHash: hash } : {}), error: message, params: { requestId, refundBroadcast: Boolean(hash) } });
      return textResult({ ok: false, status: hash && !terminalFailure ? 'broadcast' : 'failed', refundTxHash: hash ?? null, error: message, summary: hash && !terminalFailure ? `Refund transaction ${hash} was broadcast but is not confirmed. Do not retry; reconcile the explorer receipt first.` : `Refund not completed: ${message}` });
    }
  });

  addTool(server, 'wallet_activity_explainer', 'Summarize recent ERC-20 transfers for the linked Monad wallet in plain language. Reports the exact scanned block range and token coverage; native-MON history is not included.', {
    blocks: z.number().int().min(100).max(10_000).default(2_000),
    userId: z.string().optional(),
  }, async ({ blocks, userId }: { blocks: number; userId?: string }) => {
    try {
      if (env.MONAD_NETWORK !== 'mainnet') throw new Error('Wallet activity summary is currently Monad mainnet only.');
      const wallet = await resolveWallet(env, userId);
      assertAddress(wallet.address, 'wallet');
      const client = getPublicClient(env);
      const chainId = await client.getChainId();
      if (chainId !== 143) throw new Error(`Configured RPC returned chain ${chainId}; expected Monad mainnet (143).`);
      const toBlock = await client.getBlockNumber();
      const fromBlock = toBlock > BigInt(blocks) ? toBlock - BigInt(blocks) : 0n;
      const tokenActivity = await Promise.all(WALLET_ACTIVITY_TOKENS.map(async (token) => {
        const [received, sent] = await Promise.all([
          client.getLogs({ address: token.address, event: TRANSFER_EVENT, args: { to: wallet.address as `0x${string}` }, fromBlock, toBlock }),
          client.getLogs({ address: token.address, event: TRANSFER_EVENT, args: { from: wallet.address as `0x${string}` }, fromBlock, toBlock }),
        ]);
        const receivedRaw = received.reduce((sum, log) => sum + (log.args.value ?? 0n), 0n);
        const sentRaw = sent.reduce((sum, log) => sum + (log.args.value ?? 0n), 0n);
        const rows = [
          ...received.map((log) => ({ log, direction: 'received' as const })),
          ...sent.map((log) => ({ log, direction: 'sent' as const })),
        ].map(({ log, direction }) => ({
          symbol: token.symbol,
          direction,
          amount: formatUnits(log.args.value ?? 0n, token.decimals),
          from: log.args.from,
          to: log.args.to,
          blockNumber: log.blockNumber?.toString() ?? null,
          txHash: log.transactionHash ?? null,
          explorerUrl: log.transactionHash ? explorerTxUrl(env, log.transactionHash) : null,
        }));
        return {
          summary: { symbol: token.symbol, contract: token.address, incoming: formatUnits(receivedRaw, token.decimals), outgoing: formatUnits(sentRaw, token.decimals), incomingTransfers: received.length, outgoingTransfers: sent.length },
          rows,
        };
      }));
      const perToken = tokenActivity.map(({ summary }) => summary);
      const transfers = tokenActivity.flatMap(({ rows }) => rows).sort((a, b) => BigInt(a.blockNumber ?? '0') < BigInt(b.blockNumber ?? '0') ? 1 : -1).slice(0, 30);
      const logCount = perToken.reduce((sum, entry) => sum + entry.incomingTransfers + entry.outgoingTransfers, 0);
      const audit = await (await import('../../middleware/audit-log.js')).readRecentAudit(100);
      const identity = (userId ?? 'default').toLowerCase();
      const ownActivity = audit.filter((entry) => entry.userId ? entry.userId.toLowerCase() === identity : identity === 'default').map((entry) => ({
        ...entry,
        explorerUrl: entry.txHash ? explorerTxUrl(env, entry.txHash as `0x${string}`) : null,
      }));
      const [contacts, invoicePayments, paymentRequests] = await Promise.all([
        listContacts(userId),
        listPayments(normalizeUser(userId), 500),
        listPaymentRequests(normalizeUser(userId), 500),
      ]);
      const explainedTransfers = transfers.map((transfer) => {
        const counterparty = (transfer.direction === 'sent' ? transfer.to : transfer.from) ?? 'unknown address';
        const contact = contacts.find((item) => item.address.toLowerCase() === counterparty.toLowerCase());
        const hash = transfer.txHash?.toLowerCase();
        const outgoingInvoice = invoicePayments.find((item) => item.txHash?.toLowerCase() === hash);
        const incomingInvoice = paymentRequests.find((item) => item.txHash?.toLowerCase() === hash || item.refundTxHash?.toLowerCase() === hash);
        const context = outgoingInvoice ? `Mochi recorded this as invoice ${outgoingInvoice.invoiceId} for ${outgoingInvoice.recipientName}.`
          : incomingInvoice?.refundTxHash?.toLowerCase() === hash ? `Mochi recorded this as a refund for invoice ${incomingInvoice.invoiceId}.`
            : incomingInvoice ? `Mochi recorded this as payment for invoice ${incomingInvoice.invoiceId}.`
            : null;
        const who = contact?.name ?? counterparty;
        const plainLanguage = `${transfer.direction === 'received' ? 'Received' : 'Sent'} ${transfer.amount} ${transfer.symbol} ${transfer.direction === 'received' ? 'from' : 'to'} ${who}.${context ? ` ${context}` : ''}`;
        return { ...transfer, counterpartyName: contact?.name ?? null, relatedInvoice: outgoingInvoice?.invoiceId ?? incomingInvoice?.invoiceId ?? null, plainLanguage };
      });
      const explainedReceived = explainedTransfers.filter((transfer) => transfer.direction === 'received').length;
      const explainedSent = explainedTransfers.filter((transfer) => transfer.direction === 'sent').length;
      const linkedInvoices = explainedTransfers.filter((transfer) => transfer.relatedInvoice).length;
      return textResult({
        ok: true, wallet: wallet.address, network: 'Monad mainnet (143)',
        window: { fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), blocksScanned: Number(toBlock - fromBlock) },
        tokenCoverage: WALLET_ACTIVITY_TOKENS.map(({ symbol, address }) => ({ symbol, address })),
        erc20Activity: perToken,
        recentTransfers: explainedTransfers,
        paymentContext: { linkedInvoiceTransfers: linkedInvoices, savedContactsAvailable: contacts.length, merchantRequestsIncluded: paymentRequests.length, outgoingInvoiceRecordsIncluded: invoicePayments.length },
        mochiActionHistory: ownActivity.slice(-20),
        nativeMONHistory: 'not included (the configured public RPC exposes no reliable indexed address transaction history)',
        isCompleteWalletHistory: false,
        summary: logCount ? `In the last ${blocks} blocks, found ${logCount} AUSD/WMON transfer events. Of the ${explainedTransfers.length} most recent linked transfers, ${explainedReceived} were incoming and ${explainedSent} outgoing.${linkedInvoices ? ` ${linkedInvoices} match Mochi invoice records.` : ''} Recent actions are described in plain language and matched to saved contacts where possible. Open explorer links to verify each transaction. This scan does not include native MON, other tokens, contract traces, or activity beyond the stated block window.` : `No AUSD or WMON transfers found in the last ${blocks} blocks. Mochi also checked its local invoice history. This is a bounded token scan, not a complete wallet history; native MON and other tokens are outside its coverage.`,
      });
    } catch (err) {
      return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
