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
    <main className="max-w-sm mx-auto mt-16 rounded-xl bg-panel p-6 border border-white/10">
      <h2 className="text-lg font-semibold"><span className="text-monad">Mochi</span> sign-in</h2>
      <p className="mt-2 text-sm text-white/50">Welcome back. Enter the dashboard password to continue.</p>
      <form onSubmit={submit} className="mt-5 grid gap-3">
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="px-3 py-2 rounded-lg bg-ink border border-white/15"
          aria-label="Dashboard password"
          required
        />
        {error && <p className="text-sm text-red-300">{error}</p>}
        <button disabled={busy} className="px-4 py-2 rounded-lg bg-monad/30 border border-monad/50 font-semibold">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
