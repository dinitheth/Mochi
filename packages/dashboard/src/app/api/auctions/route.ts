import { NextResponse } from 'next/server';
import { activeNetwork, ethCall, ethChainNow, NETWORKS, weiToMon } from '@/lib/monad';

const AUCTION_HOUSE = process.env.AUCTION_HOUSE_ADDRESS || '0x1a77918b88E398F77D78EDae870d4406C66eb0B2';
const SEL_COUNT = '0x2ad71573';
const SEL_GET = '0x78bd7935';
const SEL_TOKEN_URI = '0xc87b56dd';

function pad32(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

function word(hex: string, i: number): bigint {
  return BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
}

function addr(hex: string, i: number): string {
  return '0x' + hex.slice(2 + i * 64 + 24, 2 + (i + 1) * 64);
}

function decodeString(hex: string): string {
  // ABI-encoded string: offset(32) length(32) data
  const len = Number(BigInt('0x' + hex.slice(66, 130)));
  const dataHex = hex.slice(130, 130 + len * 2);
  const bytes = new Uint8Array(dataHex.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
  return new TextDecoder().decode(bytes);
}

function tokenIdToImageJson(tokenUri: string): string | null {
  try {
    // data:application/json;base64,<...{... "image":"data:image/svg+xml;base64,..."}>
    const b64 = tokenUri.split(',')[1];
    if (!b64) return null;
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as { image?: string; name?: string };
    return json.image ?? null;
  } catch {
    return null;
  }
}

export interface AuctionView {
  auctionId: string;
  nft: string;
  tokenId: string;
  collectionName: string | null;
  seller: string;
  reserveMON: string;
  highestBidMON: string;
  highestBidder: string;
  endTime: number;
  settled: boolean;
  image: string | null;
}

export async function GET() {
  const network = activeNetwork();
  const meta = NETWORKS[network];
  try {
    const [countHex, chainNow] = await Promise.all([
      ethCall(meta.rpcUrl, AUCTION_HOUSE, SEL_COUNT),
      ethChainNow(meta.rpcUrl),
    ]);
    const count = Number(BigInt(countHex));
    const cap = Math.min(count, 25);
    const auctions: AuctionView[] = [];
    for (let i = cap; i >= 1; i--) {
      try {
        const raw = await ethCall(meta.rpcUrl, AUCTION_HOUSE, SEL_GET + pad32(BigInt(i)));
        const seller = addr(raw, 0);
        if (seller === '0x0000000000000000000000000000000000000000') continue;
        const settled = word(raw, 7) !== 0n;
        if (settled) continue;
        const nft = addr(raw, 1);
        const tokenId = word(raw, 2);
        let image: string | null = null;
        let collectionName: string | null = null;
        try {
          const uriHex = await ethCall(
            meta.rpcUrl,
            nft,
            SEL_TOKEN_URI + pad32(tokenId),
          );
          const uri = decodeString(uriHex);
          image = tokenIdToImageJson(uri);
          const b64 = uri.split(',')[1];
          if (b64) {
            const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as { name?: string };
            collectionName = json.name ?? null;
          }
        } catch {
          image = null;
        }
        auctions.push({
          auctionId: String(i),
          nft,
          tokenId: tokenId.toString(),
          collectionName,
          seller,
          reserveMON: weiToMon(word(raw, 3)),
          highestBidMON: weiToMon(word(raw, 4)),
          highestBidder: addr(raw, 5),
          endTime: Number(word(raw, 6)),
          settled,
          image,
        });
      } catch {
        continue;
      }
    }
    return NextResponse.json({ ok: true, network, chainNow, auctionHouse: AUCTION_HOUSE, auctions });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
