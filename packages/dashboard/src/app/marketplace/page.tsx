'use client';

import { useCallback, useEffect, useState } from 'react';

interface Listing {
  market: string;
  nft: string;
  tokenId: string;
  collectionName: string | null;
  priceMON: string;
  seller: string;
  image: string | null;
}

export default function MarketplacePage() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/listings?cap=25', { cache: 'no-store' });
      const data = await res.json();
      if (data.ok) setListings(data.listings ?? []);
    } catch {
      /* keep stale */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
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

  const floor = listings.length
    ? listings.reduce((a, b) => (Number(a.priceMON) < Number(b.priceMON) ? a : b))
    : null;

  return (
    <main className="grid gap-4 min-w-0 [&>*]:min-w-0">
      <div className="rounded-xl bg-panel p-5 border border-white/10">
        <h2 className="text-sm font-semibold tracking-wide text-white/70">
          MOCHI MARKETS {listings.length > 0 && <span className="text-monad">· {listings.length} listed</span>}
        </h2>
        <p className="mt-1 text-xs text-white/40">
          {floor ? (
            <>Floor {floor.priceMON} MON · {floor.collectionName ?? 'Unnamed'} #{floor.tokenId}</>
          ) : (
            'Scanning fixed-price listings across Mochi markets…'
          )}
        </p>
      </div>

      {listings.length === 0 && (
        <div className="rounded-xl bg-panel p-5 border border-white/10">
          <p className="text-sm text-white/50">No fixed-price listings in Mochi markets right now. Check Auctions for live bids.</p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3 min-w-0 [&>*]:min-w-0">
        {listings.map((l) => (
          <div key={`${l.market}-${l.tokenId}`} className="rounded-xl bg-panel p-4 border border-white/10">
            {l.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={l.image} alt={l.collectionName ?? `NFT #${l.tokenId}`} className="w-full rounded-lg" />
            ) : (
              <div className="w-full aspect-square rounded-lg bg-ink/60 border border-white/10 flex items-center justify-center text-3xl">
                #{l.tokenId}
              </div>
            )}
            <p className="mt-3 font-bold text-sm">{l.collectionName ?? 'Unnamed'} #{l.tokenId}</p>
            <p className="mt-1 text-xl font-mono">
              {l.priceMON} <span className="text-sm text-white/50">MON</span>
            </p>
            <p className="mt-1 font-mono text-xs text-white/30">
              seller {l.seller.slice(0, 6)}…{l.seller.slice(-4)}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() =>
                  copy(
                    `buy-${l.tokenId}`,
                    `Use monad-mcp nft_buy with userId dinisfdth to buy ${l.nft} token #${l.tokenId} with maxPrice ${l.priceMON}.`,
                  )
                }
                className="flex-1 px-3 py-2 rounded-lg bg-monad/20 border border-monad/40 text-sm font-semibold hover:bg-monad/30"
              >
                {copied === `buy-${l.tokenId}` ? 'Copied!' : `Buy ${l.priceMON}`}
              </button>
              <button
                onClick={() =>
                  copy(
                    `offer-${l.tokenId}`,
                    `Use monad-mcp nft_offer with userId dinisfdth to offer on ${l.nft} token #${l.tokenId}.`,
                  )
                }
                className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm hover:bg-white/10"
              >
                {copied === `offer-${l.tokenId}` ? 'Copied!' : 'Offer'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
