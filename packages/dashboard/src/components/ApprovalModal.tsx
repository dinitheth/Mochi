'use client';

import type { ApprovalRecord } from '@/lib/approvals';
import { shortAddr } from './WalletCard';

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
              <code className="font-mono text-sm text-amber-200">{a.action}</code>
              <span className="text-sm font-bold">
                {a.action === 'payments_send_invoice'
                  ? `${String(a.details.amount ?? '—')} ${String(a.details.token ?? 'AUSD')}`
                  : a.action === 'payments_send_payout_batch'
                    ? `${String(a.details.paymentCount ?? '—')} payments · ${String(a.details.totalAmount ?? '—')} AUSD`
                  : `${monFromWei(a.valueWei)} MON`}
              </span>
            </div>
            {a.reason && <p className="mt-1 text-sm text-white/70">{a.reason}</p>}
            <p className="mt-2 text-xs text-white/50">
              {a.decisions.filter((vote) => vote.decision === 'approved').length} of {a.requiredApprovals} distinct approvals
              {a.decisions.length > 0 ? ` · votes: ${a.decisions.map((vote) => `${vote.actorId} ${vote.decision}`).join(', ')}` : ''}
            </p>
            {a.action === 'payments_send_invoice' ? (
              <div className="mt-3 grid gap-2 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3 text-sm sm:grid-cols-2">
                <p><span className="text-white/45">Payment</span><br /><strong>{String(a.details.amount ?? '—')} {String(a.details.token ?? 'AUSD')}</strong></p>
                <p><span className="text-white/45">Invoice</span><br /><strong>{String(a.details.invoiceId ?? '—')}</strong></p>
                <p><span className="text-white/45">Recipient</span><br /><strong>{String(a.details.recipient ?? '—')}</strong></p>
                <p><span className="text-white/45">Recipient address</span><br /><code className="break-all">{String(a.details.recipientAddress ?? '—')}</code></p>
                <p><span className="text-white/45">From</span><br /><code className="break-all">{String(a.details.from ?? '—')}</code></p>
                <p><span className="text-white/45">Estimated network fee</span><br /><strong>{String(a.details.simulatedFeeMON ?? '—')} MON</strong></p>
                <p className="sm:col-span-2"><span className="text-white/45">Purpose</span><br />{String(a.details.reason ?? '—')}</p>
                <p className="sm:col-span-2"><span className="text-white/45">Network</span><br />Monad chain {String(a.details.chainId ?? '—')} · AUSD contract <code className="break-all">{String(a.details.tokenAddress ?? '—')}</code></p>
              </div>
            ) : null}
            {a.action === 'payments_send_payout_batch' && Array.isArray(a.details.payments) ? (
              <div className="mt-3 grid gap-2 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3 text-sm">
                <p><span className="text-white/45">Batch total</span><br /><strong>{String(a.details.totalAmount ?? '—')} AUSD</strong> · {String(a.details.paymentCount ?? '—')} transfers</p>
                {(a.details.payments as Array<Record<string, unknown>>).map((payment, index) => (
                  <div key={`${String(payment.invoiceId)}-${index}`} className="rounded border border-white/10 p-2">
                    <p><strong>{String(payment.invoiceId ?? 'Invoice')}</strong> · {String(payment.amount ?? '—')} AUSD to {String(payment.recipient ?? 'payee')}</p>
                    <p className="text-xs text-white/60 break-all">{String(payment.recipientAddress ?? '')} · {String(payment.reason ?? '')}</p>
                    {payment.riskCheck && typeof payment.riskCheck === 'object' && Array.isArray((payment.riskCheck as Record<string, unknown>).flags) ? <p className="text-xs text-amber-200">Review: {((payment.riskCheck as { flags: string[] }).flags).join(' ') || 'No history-based warning.'}</p> : null}
                  </div>
                ))}
                <p className="text-xs text-white/50">Estimated batch network fee: {String(a.details.estimatedTotalFeeMON ?? 'unknown')} MON · Monad chain {String(a.details.chainId ?? '143')}</p>
              </div>
            ) : null}
            {a.details.riskCheck && typeof a.details.riskCheck === 'object' && Array.isArray((a.details.riskCheck as Record<string, unknown>).flags) ? (
              <p className="mt-2 text-xs text-amber-200">Payment review signals: {((a.details.riskCheck as { flags: string[] }).flags).join(' ') || 'No history-based warning.'}</p>
            ) : null}
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-white/45">Full request details</summary>
              <pre className="mt-2 max-h-64 overflow-auto text-xs font-mono text-white/50 whitespace-pre-wrap break-all">
                {JSON.stringify(a.details, null, 2)}
              </pre>
            </details>
            <p className="mt-1 font-mono text-xs text-white/30">
              {(a.details?.to as string)?.startsWith?.('0x') ? shortAddr(String(a.details.to)) : ''} ·{' '}
              {new Date(a.timestamp).toLocaleString()}
            </p>
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
