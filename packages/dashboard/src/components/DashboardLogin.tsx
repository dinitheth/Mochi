'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function DashboardLogin() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Sign-in failed.');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-copy">
        <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold tracking-[0.18em] text-white/65">
          <span className="h-2 w-2 rounded-full bg-[#a8f0c4] shadow-[0_0_14px_rgba(168,240,196,0.8)]" />
          MOCHI <span className="text-white/30">/</span> MONAD
        </p>
        <h1 className="mt-8 max-w-2xl text-5xl font-bold leading-[0.98] tracking-[-0.06em] sm:text-7xl">
          Your wallet,<br />
          <span className="bg-gradient-to-r from-[#b6aaff] via-[#9280ff] to-[#a8f0c4] bg-clip-text text-transparent">in your flow.</span>
        </h1>
        <p className="mt-6 max-w-xl text-base leading-7 text-white/60 sm:text-lg">
          A calmer way to review wallet activity and keep your Monad tools close. Your team role controls approval access.
        </p>
        <div className="mt-9 flex flex-wrap gap-2 text-xs text-white/55">
          <span className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-2">Wallet activity</span>
          <span className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-2">Transaction approvals</span>
          <span className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-2">Monad network</span>
        </div>
      </section>

      <section className="login-card">
        <div className="mb-7 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-[0.16em] text-[#b6aaff]">MOCHI DASHBOARD</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">Welcome back</h2>
            <p className="mt-2 text-sm leading-6 text-white/50">Sign in with your dashboard or team password.</p>
          </div>
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-white/10 bg-gradient-to-br from-[#836ef9]/30 to-[#a8f0c4]/10 text-lg font-bold text-[#d7d0ff]">M</span>
        </div>
        <form onSubmit={submit} className="grid gap-4">
          <label className="grid gap-2 text-xs font-medium tracking-wide text-white/65">
            DASHBOARD PASSWORD
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="login-input"
              aria-label="Dashboard password"
              placeholder="Enter your password"
              required
            />
          </label>
          {error && <p className="text-sm text-red-300" role="alert">{error}</p>}
          <button disabled={busy} className="login-primary mt-1 px-5 font-semibold disabled:cursor-wait disabled:opacity-65">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="mt-6 text-center text-xs leading-5 text-white/40">Private dashboard access · Mochi on Monad</p>
      </section>
    </main>
  );
}
