'use client';

import { useCallback, useEffect, useState } from 'react';

interface Auction {
  auctionId: string;
  nft: string;
  tokenId: string;
  collectionName: string | null;
  seller: string;
  reserveMON: string;
  highestBidMON: string;
  highestBidder: string;
  endTime: number;
  image: string | null;
}

function fmtCountdown(secs: number): string {
  if (secs <= 0) return 'ended';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}h ${m}m ${s}s`;
}

export default function AuctionsPage() {
  const [auctions, setAuctions] = useState<Auction[]>([]);
  const [chainNow, setChainNow] = useState<number>(0);
  const [fetchedAt, setFetchedAt] = useState<number>(0);
  const [now, setNow] = useState<number>(() => Date.now());
  const [bidAmounts, setBidAmounts] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/auctions', { cache: 'no-store' });
      const data = await res.json();
      if (data.ok) {
        setAuctions(data.auctions ?? []);
        setChainNow(data.chainNow ?? 0);
        setFetchedAt(Date.now());
      }
    } catch {
      /* keep stale */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(t);
      clearInterval(tick);
    };
  }, [load]);

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <main className="grid gap-4 min-w-0 [&>*]:min-w-0">
      <div className="rounded-xl bg-panel p-5 border border-white/10">
        <h2 className="text-sm font-semibold tracking-wide text-white/70">
          LIVE AUCTIONS {auctions.length > 0 && <span className="text-monad">· {auctions.length}</span>}
        </h2>
        <p className="mt-1 text-xs text-white/40">
          Bids execute from your agent wallet — copy a command into Codex/Claude, confirm the approval, done.
        </p>
      </div>

      {auctions.length === 0 && (
        <div className="rounded-xl bg-panel p-5 border border-white/10">
          <p className="text-sm text-white/50">No live auctions right now. Launch one from chat to see it here.</p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 min-w-0 [&>*]:min-w-0">
        {auctions.map((a) => {
          const elapsed = Math.floor((now - fetchedAt) / 1000);
          const remaining = a.endTime - chainNow - elapsed;
          const bid = bidAmounts[a.auctionId] ?? '';
          return (
            <div key={a.auctionId} className="rounded-xl bg-panel p-5 border border-white/10">
              <div className="flex gap-4">
                {a.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.image} alt={a.collectionName ?? `NFT #${a.tokenId}`} className="w-24 h-24 rounded-lg" />
                ) : (
                  <div className="w-24 h-24 rounded-lg bg-ink/60 border border-white/10 flex items-center justify-center text-2xl">
                    #{a.tokenId}
                  </div>
                )}
                <div className="flex-1">
                  <p className="font-bold">{a.collectionName ?? 'Unnamed'} #{a.tokenId}</p>
                  <p className="text-xs font-mono text-white/40">Auction #{a.auctionId}</p>
                  <p className={`mt-1 text-sm font-mono ${remaining <= 0 ? 'text-red-300' : 'text-amber-200'}`}>
                    ⏳ {fmtCountdown(remaining)}
                  </p>
                </div>
              </div>
              <div className="mt-3 text-sm space-y-1">
                <p>
                  Reserve: <span className="font-mono">{a.reserveMON} MON</span>
                </p>
                <p>
                  Highest: <span className="font-mono font-bold">{a.highestBidMON} MON</span>{' '}
                  <span className="font-mono text-xs text-white/40">
                    by {a.highestBidder.slice(0, 6)}…{a.highestBidder.slice(-4)}
                  </span>
                </p>
              </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                value={bid}
                onChange={(e) => setBidAmounts({ ...bidAmounts, [a.auctionId]: e.target.value })}
                placeholder="Bid MON"
                inputMode="decimal"
                className="flex-1 min-w-24 px-3 py-2 rounded-lg bg-ink/60 border border-white/10 text-sm font-mono"
              />
                <button
                  onClick={() =>
                    copy(
                      `bid-${a.auctionId}`,
                      `Use monad-mcp nft_bid with userId dinisfdth to bid ${bid || '<amount>'} MON on auction #${a.auctionId}.`,
                    )
                  }
                  className="px-4 py-2 rounded-lg bg-monad/20 border border-monad/40 text-sm font-semibold hover:bg-monad/30"
                >
                  {copied === `bid-${a.auctionId}` ? 'Copied!' : 'Copy bid cmd'}
                </button>
                <button
                  onClick={() =>
                    copy(
                      `settle-${a.auctionId}`,
                      `Use monad-mcp nft_settle_auction with userId dinisfdth to settle auction #${a.auctionId}.`,
                    )
                  }
                  className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-sm hover:bg-white/10"
                >
                  {copied === `settle-${a.auctionId}` ? 'Copied!' : 'Settle cmd'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
