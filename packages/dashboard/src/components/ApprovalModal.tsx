'use client';

import type { ApprovalRecord } from '@/lib/approvals';

function monFromWei(wei: string): string {
  try {
    const w = BigInt(wei);
    const whole = w / 10n ** 18n;
    const frac = (w % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '').slice(0, 6);
    return frac ? `${whole}.${frac}` : whole.toString();
  } catch {
    return wei;
  }
}

const ACTION_LABELS: Record<string, string> = {
  wallet_wrap_native: 'Convert MON to WMON', transaction_send_mon: 'Send MON', transaction_send_token: 'Send tokens',
  defi_swap_tokens: 'Swap tokens', uniswap_swap_tokens: 'Swap tokens', nft_buy: 'Buy an NFT', nft_opensea_buy: 'Buy an NFT on OpenSea',
  nft_bid: 'Place an NFT bid', nft_offer: 'Make an NFT offer', nft_accept_offer: 'Accept an NFT offer',
  nft_cancel_offer: 'Cancel an NFT offer', nft_cancel_listing: 'Cancel an NFT listing',
  lending_deposit: 'Supply funds', lending_withdraw: 'Withdraw funds', lending_borrow: 'Borrow against an NFT', lending_repay: 'Repay a loan',
  kintsu_stake_mon: 'Stake MON', kintsu_request_unstake: 'Request unstaking',
  payments_send_invoice: 'Pay an invoice', payments_send_payout_batch: 'Send scheduled payments', payments_refund_request: 'Refund a payment',
  contract_write: 'Review contract interaction', contract_deploy: 'Create a contract',
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? 'Review this action';
}

function displayDetails(details: Record<string, unknown>, action: string): Array<[string, string]> {
  const fields: Array<[string, string]> = [];
  const add = (label: string, value: unknown, unit = '') => {
    if (value !== undefined && value !== null && String(value).trim()) fields.push([label, `${String(value)}${unit}`]);
  };
  if (details.amount != null) add('Amount', details.amount, ` ${String(details.token ?? '')}`.trimEnd());
  else if (details.amountMON != null) add('Amount', details.amountMON, ' MON');
  else if (details.listingPriceMON != null) add('Asking price', details.listingPriceMON, ' MON');
  else if (details.amountIn != null) add('You swap', details.amountIn, details.tokenInSymbol ? ` ${String(details.tokenInSymbol)}` : '');
  if (details.tokenOutSymbol != null && details.quotedOutput != null) add('Estimated to receive', details.quotedOutput, ` ${String(details.tokenOutSymbol)}`);
  if (details.recipient != null) add('Recipient', details.recipient);
  if (details.recipientAddress != null) add('Recipient address', String(details.recipientAddress).replace(/^(0x[\da-fA-F]{6})[\da-fA-F]+([\da-fA-F]{4})$/, '$1…$2'));
  if (details.invoiceId != null) add('Invoice', details.invoiceId);
  if (details.paymentCount != null) add('Number of payments', details.paymentCount);
  if (details.totalAmount != null) add('Total', details.totalAmount, ' AUSD');
  if (details.estimatedFeeMON != null || details.simulatedFeeMON != null || details.estimatedTotalFeeMON != null) {
    add('Estimated network fee', details.estimatedFeeMON ?? details.simulatedFeeMON ?? details.estimatedTotalFeeMON, ' MON');
  }
  if (details.reason != null && action !== 'contract_write') add('Purpose', details.reason);
  if (details.settlement != null) add('When you receive it', details.settlement);
  if (!fields.length && details.reason != null) add('What this does', details.reason);
  return fields;
}

function amountForApproval(a: ApprovalRecord): string | null {
  if (a.action === 'payments_send_invoice') return `${String(a.details.amount ?? '—')} ${String(a.details.token ?? 'AUSD')}`;
  if (a.action === 'payments_send_payout_batch') return `${String(a.details.paymentCount ?? '—')} payments · ${String(a.details.totalAmount ?? '—')} AUSD`;
  const amount = a.details.amountMON ?? a.details.listingPriceMON ?? a.details.amountIn;
  if (amount != null) {
    const token = a.details.tokenInSymbol ?? (a.details.amountIn != null ? '' : 'MON');
    return `${String(amount)}${token ? ` ${String(token)}` : ''}`;
  }
  try { return BigInt(a.valueWei) > 0n ? `${monFromWei(a.valueWei)} MON` : null; } catch { return null; }
}

function friendlyReason(reason: string): string {
  if (/mcp__|selector|calldata|\bwei\b|execution method|function\s+[a-z0-9_]+/i.test(reason)) return 'Please review the action details below before approving.';
  return reason.replace(/\b[a-z][a-z0-9]*\(\)\s*(?:—|-)\s*payable/gi, 'payment action').replace(/\b[a-z][a-z0-9]*\(\)/gi, 'this action');
}

export default function ApprovalModal({
  approvals,
  onRespond,
  viewer,
}: {
  approvals: ApprovalRecord[];
  onRespond: (id: string, decision: 'approved' | 'rejected') => void;
  viewer: { id: string; role: string } | null;
}) {
  const pending = approvals.filter((a) => a.status === 'pending');
  if (pending.length === 0) {
    return (
      <div className="rounded-xl bg-panel p-5 border border-white/10">
        <h2 className="text-sm font-semibold tracking-wide text-white/70">APPROVAL QUEUE</h2>
        <p className="mt-3 text-sm text-white/50">No pending requests. Over-limit agent actions will appear here.</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl bg-panel p-5 border border-amber-400/30">
      <h2 className="text-sm font-semibold tracking-wide text-amber-300">
        APPROVAL QUEUE · {pending.length} pending
      </h2>
      <div className="mt-3 space-y-3">
        {pending.map((a) => (
          <div key={a.requestId} className="rounded-lg bg-ink/60 border border-white/10 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-amber-200">{actionLabel(a.action)}</span>
              {amountForApproval(a) && <span className="text-sm font-bold">{amountForApproval(a)}</span>}
            </div>
              {a.reason && !/^0x[\da-f]+$/i.test(a.reason) && <p className="mt-1 text-sm text-white/70">{friendlyReason(a.reason)}</p>}
            <p className="mt-2 text-xs text-white/50">
              {a.decisions.filter((vote) => vote.decision === 'approved').length} of {a.requiredApprovals} team approvals
            </p>
            {a.action !== 'payments_send_invoice' && a.action !== 'payments_send_payout_batch' && (
              <div className="mt-3 grid gap-2 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3 text-sm sm:grid-cols-2">
                {displayDetails(a.details, a.action).map(([label, value]) => <p key={label}><span className="text-white/45">{label}</span><br /><strong className="break-words">{value}</strong></p>)}
                {a.action === 'contract_write' && <p className="text-white/70">This request interacts with a contract. Only approve if you expected this action and trust its source.</p>}
              </div>
            )}
            {a.action === 'payments_send_invoice' ? (
              <div className="mt-3 grid gap-2 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3 text-sm sm:grid-cols-2">
                <p><span className="text-white/45">Payment</span><br /><strong>{String(a.details.amount ?? '—')} {String(a.details.token ?? 'AUSD')}</strong></p>
                <p><span className="text-white/45">Invoice</span><br /><strong>{String(a.details.invoiceId ?? '—')}</strong></p>
                <p><span className="text-white/45">Recipient</span><br /><strong>{String(a.details.recipient ?? '—')}</strong></p>
                <p><span className="text-white/45">Recipient address</span><br /><strong className="break-all">{String(a.details.recipientAddress ?? '—').replace(/^(0x[\da-fA-F]{6})[\da-fA-F]+([\da-fA-F]{4})$/, '$1…$2')}</strong></p>
                <p><span className="text-white/45">Estimated network fee</span><br /><strong>{String(a.details.simulatedFeeMON ?? '—')} MON</strong></p>
                <p className="sm:col-span-2"><span className="text-white/45">Purpose</span><br />{String(a.details.reason ?? '—')}</p>
                <p className="sm:col-span-2"><span className="text-white/45">Network</span><br />Monad</p>
              </div>
            ) : null}
            {a.action === 'payments_send_payout_batch' && Array.isArray(a.details.payments) ? (
              <div className="mt-3 grid gap-2 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3 text-sm">
                <p><span className="text-white/45">Batch total</span><br /><strong>{String(a.details.totalAmount ?? '—')} AUSD</strong> · {String(a.details.paymentCount ?? '—')} transfers</p>
                {(a.details.payments as Array<Record<string, unknown>>).map((payment, index) => (
                  <div key={`${String(payment.invoiceId)}-${index}`} className="rounded border border-white/10 p-2">
                    <p><strong>{String(payment.invoiceId ?? 'Invoice')}</strong> · {String(payment.amount ?? '—')} AUSD to {String(payment.recipient ?? 'payee')}</p>
                    <p className="text-xs text-white/60 break-words">{String(payment.recipientAddress ?? '').replace(/^(0x[\da-fA-F]{6})[\da-fA-F]+([\da-fA-F]{4})$/, '$1…$2')}{payment.reason ? ` · ${friendlyReason(String(payment.reason))}` : ''}</p>
                    {payment.riskCheck && typeof payment.riskCheck === 'object' && Array.isArray((payment.riskCheck as Record<string, unknown>).flags) && ((payment.riskCheck as { flags: string[] }).flags).length > 0 ? <p className="text-xs text-amber-200">Please review this payment carefully before approving.</p> : null}
                  </div>
                ))}
                <p className="text-xs text-white/50">Estimated batch network fee: {String(a.details.estimatedTotalFeeMON ?? 'unknown')} MON · Monad chain {String(a.details.chainId ?? '143')}</p>
              </div>
            ) : null}
            {a.details.riskCheck && typeof a.details.riskCheck === 'object' && Array.isArray((a.details.riskCheck as Record<string, unknown>).flags) && ((a.details.riskCheck as { flags: string[] }).flags).length > 0 ? (
              <p className="mt-2 text-xs text-amber-200">Please review this payment carefully before approving.</p>
            ) : null}
            <p className="mt-2 text-xs text-white/40">Requested {new Date(a.timestamp).toLocaleString()}</p>
            {viewer && ['admin', 'approver'].includes(viewer.role) && a.status === 'pending' && !a.decisions.some((vote) => vote.actorId === viewer.id) ? <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => onRespond(a.requestId, 'approved')}
                className="px-4 py-2 rounded-lg bg-green-500/20 border border-green-400/40 text-green-200 text-sm font-semibold hover:bg-green-500/30"
              >
                Approve
              </button>
              <button
                onClick={() => onRespond(a.requestId, 'rejected')}
                className="px-4 py-2 rounded-lg bg-red-500/20 border border-red-400/40 text-red-200 text-sm font-semibold hover:bg-red-500/30"
              >
                Reject
              </button>
            </div> : <p className="mt-3 text-xs text-white/40">{a.status !== 'pending' ? `Request ${a.status}.` : a.decisions.some((vote) => vote.actorId === viewer?.id) ? 'Your vote is recorded.' : 'You have read-only access to this approval.'}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
