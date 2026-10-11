'use client';

export interface WalletInfo {
  initialized: boolean;
  network: string;
  chainId: number;
  address: string | null;
  balanceMON: string;
  explorerUrl: string;
  userId: string | null;
}

export function shortAddr(a: string): string {
  return a.length > 13 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export default function WalletCard({ wallet }: { wallet: WalletInfo | null }) {
  if (!wallet) {
    return (
      <div className="rounded-xl bg-panel p-5 border border-white/10">
        <div className="text-sm text-white/60">Loading wallet…</div>
      </div>
    );
  }
  return (
    <div className="rounded-xl bg-panel p-5 border border-white/10">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-white/70">AGENT WALLET</h2>
      </div>
      {!wallet.initialized || !wallet.address ? (
        <p className="mt-3 text-sm text-white/60">
          No wallet initialized yet. In Claude, run <code className="font-mono text-monad">wallet_initialize</code> first.
        </p>
      ) : (
        <>
          <p className="mt-3 font-mono text-lg break-all">{shortAddr(wallet.address)}</p>
          <p className="mt-1 font-mono text-xs text-white/50 break-all leading-relaxed [overflow-wrap:anywhere]">{wallet.address}</p>
          <p className="mt-3 text-2xl sm:text-3xl font-bold break-words">
            {wallet.balanceMON} <span className="text-base text-white/60">MON</span>
          </p>
          <a href={wallet.explorerUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm text-monad hover:underline">
            View on explorer
          </a>
        </>
      )}
    </div>
  );
}
