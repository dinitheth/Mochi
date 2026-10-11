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
}: {
  approvals: ApprovalRecord[];
  onRespond: (id: string, decision: 'approved' | 'rejected') => void;
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
              <span className="text-sm font-bold">{monFromWei(a.valueWei)} MON</span>
            </div>
            {a.reason && <p className="mt-1 text-sm text-white/70">{a.reason}</p>}
            <pre className="mt-2 text-xs font-mono text-white/50 whitespace-pre-wrap break-all">
              {JSON.stringify(a.details, null, 2).slice(0, 600)}
            </pre>
            <p className="mt-1 font-mono text-xs text-white/30">
              {(a.details?.to as string)?.startsWith?.('0x') ? shortAddr(String(a.details.to)) : ''} ·{' '}
              {new Date(a.timestamp).toLocaleString()}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
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
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
