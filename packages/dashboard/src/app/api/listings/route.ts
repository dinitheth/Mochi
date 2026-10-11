import { NextResponse } from 'next/server';
import { activeNetwork, ethCall, NETWORKS, weiToMon } from '@/lib/monad';

const MARKETS = [
  process.env.MICROMARKET_ADDRESS || '0x332059A65Aa2A88405BC214A9D1243f4D23bA8c7',
  '0xb2162b9f72a8a33a2c8e7f4c5a00c6e5316907c4',
];
const DEFAULT_COLLECTION = '0x3440af240213610a945339111567ddedd55384b0';
const SEL_GET_LISTING = '0x88700d1c';
const SEL_TOKEN_URI = '0xc87b56dd';

function pad32(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

function encodeAddr(a: string): string {
  return a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function word(hex: string, i: number): bigint {
  return BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
}

function addr(hex: string, i: number): string {
  return '0x' + hex.slice(2 + i * 64 + 24, 2 + (i + 1) * 64);
}

function decodeString(hex: string): string | null {
  try {
    const len = Number(BigInt('0x' + hex.slice(66, 130)));
    const dataHex = hex.slice(130, 130 + len * 2);
    const bytes = new Uint8Array(dataHex.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export interface ListingView {
  market: string;
  nft: string;
  tokenId: string;
  collectionName: string | null;
  priceMON: string;
  seller: string;
  image: string | null;
}

export async function GET(req: Request) {
  const network = activeNetwork();
  const meta = NETWORKS[network];
  const { searchParams } = new URL(req.url);
  const cap = Math.min(Number(searchParams.get('cap') || '25'), 25);
  const collection = (searchParams.get('collection') || DEFAULT_COLLECTION).toLowerCase();
  try {
    const out: ListingView[] = [];
    const metaCache = new Map<string, { image: string | null; name: string | null }>();
    async function metaOf(tokenId: bigint): Promise<{ image: string | null; name: string | null }> {
      const key = `${collection}:${tokenId.toString()}`;
      const hit = metaCache.get(key);
      if (hit) return hit;
      try {
        const uri = decodeString(await ethCall(meta.rpcUrl, collection, SEL_TOKEN_URI + pad32(tokenId)));
        const b64 = uri?.split(',')[1];
        if (!b64) return { image: null, name: null };
        const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as { image?: string; name?: string };
        const v = { image: json.image ?? null, name: json.name ?? null };
        metaCache.set(key, v);
        return v;
      } catch {
        return { image: null, name: null };
      }
    }
    for (const market of MARKETS) {
      for (let id = 1; id <= cap; id++) {
        try {
          const data = SEL_GET_LISTING + encodeAddr(collection) + pad32(BigInt(id));
          const raw = await ethCall(meta.rpcUrl, market, data);
          const seller = addr(raw, 0);
          const price = word(raw, 1);
          const active = word(raw, 2) !== 0n;
          if (seller === '0x0000000000000000000000000000000000000000' || !active) continue;
          const m = await metaOf(BigInt(id));
          out.push({
            market,
            nft: collection,
            tokenId: String(id),
            collectionName: m.name,
            priceMON: weiToMon(price),
            seller,
            image: m.image,
          });
        } catch {
          continue;
        }
      }
    }
    out.sort((a, b) => Number(BigInt(Math.floor(Number(a.priceMON) * 1e6))) - Number(BigInt(Math.floor(Number(b.priceMON) * 1e6))));
    return NextResponse.json({ ok: true, network, listings: out });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
