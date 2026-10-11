'use client';

import { useCallback, useEffect, useState } from 'react';

export default function AutoApproveSwitch() {
  const [enabled, setEnabled] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const w = await fetch('/api/wallet', { cache: 'no-store' }).then((r) => r.json());
      const uid = w.userId ?? null;
      setUserId(uid);
      if (!uid) return;
      const res = await fetch(`/api/settings?userId=${encodeURIComponent(uid)}`, { cache: 'no-store' });
      const data = await res.json();
      if (data.ok) setEnabled(Boolean(data.autoApprove));
    } catch {
      /* keep stale */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const toggle = async () => {
    if (!userId || busy) return;
    setBusy(true);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, autoApprove: !enabled }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      disabled={busy || !userId}
      onClick={toggle}
      title={enabled ? 'Auto-approve ON — tap to require approvals' : 'Auto-approve OFF — tap to let agent act freely'}
      aria-label="Toggle auto-approve"
      className={`shrink-0 w-12 h-7 rounded-full border transition-colors ${
        enabled ? 'bg-amber-400/80 border-amber-300' : 'bg-white/10 border-white/20'
      }`}
    >
      <span
        className={`block w-5 h-5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`}
      />
    </button>
  );
}
