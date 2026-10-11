'use client';

import { useCallback, useEffect, useState } from 'react';
import WalletCard, { type WalletInfo } from '@/components/WalletCard';
import TxFeed from '@/components/TxFeed';
import ApprovalModal from '@/components/ApprovalModal';
import type { ApprovalRecord } from '@/lib/approvals';

interface NetworkInfo {
  latestBlock?: string;
  gasPriceGwei?: string;
  network?: string;
}
interface ApprovalViewer { id: string; role: 'admin' | 'approver' | 'preparer' | 'viewer' }

export default function Home() {
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [approvalViewer, setApprovalViewer] = useState<ApprovalViewer | null>(null);

  const load = useCallback(async () => {
    try {
      const [w, a] = await Promise.all([
        fetch('/api/wallet', { cache: 'no-store' }).then((r) => r.json()),
        fetch('/api/approvals', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
      ]);
      setWallet(w);
      if (a?.ok) {
        setApprovals(a.approvals ?? []);
        setApprovalViewer(a.viewer ?? null);
      }
    } catch {
      /* keep stale */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
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

  return (
    <main className="grid gap-3 sm:gap-4 min-w-0 [&>*]:min-w-0">
      <WalletCard wallet={wallet} />
      <div>
        <ApprovalModal approvals={approvals} onRespond={respond} viewer={approvalViewer} />
      </div>
      <div>
        <TxFeed />
      </div>
    </main>
  );
}
