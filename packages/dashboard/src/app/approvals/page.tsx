'use client';

import { useCallback, useEffect, useState } from 'react';
import ApprovalModal from '@/components/ApprovalModal';
import type { ApprovalRecord } from '@/lib/approvals';

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/approvals', { cache: 'no-store' });
      const data = await res.json();
      if (data.ok) setApprovals(data.approvals ?? []);
    } catch {
      /* keep stale */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  const respond = async (id: string, decision: 'approved' | 'rejected') => {
    await fetch(`/api/approvals/${id}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    load();
  };

  const history = approvals.filter((a) => a.status !== 'pending');

  return (
    <main className="grid gap-4 min-w-0 [&>*]:min-w-0">
      <ApprovalModal approvals={approvals} onRespond={respond} />
      <div className="rounded-xl bg-panel p-5 border border-white/10">
        <h2 className="text-sm font-semibold tracking-wide text-white/70">DECISION HISTORY</h2>
        {history.length === 0 ? (
          <p className="mt-3 text-sm text-white/50">No decisions yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {history.map((a) => (
              <li key={a.requestId} className="flex items-center justify-between text-sm border border-white/5 rounded-lg px-3 py-2">
                <code className="font-mono text-white/80">{a.action}</code>
                <span className={a.status === 'approved' ? 'text-green-300' : 'text-red-300'}>{a.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
