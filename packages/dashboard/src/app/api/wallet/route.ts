import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { activeNetwork, ethGetBalance, NETWORKS, weiToMon } from '@/lib/monad';
import { dashboardActorFromRequest, isDashboardSessionRequest, unauthorized } from '@/lib/auth';

interface StoredWallet {
  userId: string;
  walletId: string;
  address: string;
  network: string;
  createdAt: string;
}

async function loadWallets(): Promise<Record<string, StoredWallet>> {
  const candidates = [
    join(process.cwd(), '..', 'mcp-server', 'wallet-state.json'),
    join(process.cwd(), 'wallet-state.json'),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(await fs.readFile(p, 'utf8')) as Record<string, StoredWallet>;
    } catch {
      continue;
    }
  }
  return {};
}

export async function GET(req: Request) {
  if (!isDashboardSessionRequest(req)) return unauthorized();
  const actor = dashboardActorFromRequest(req);
  if (!actor) return unauthorized();
  const network = activeNetwork();
  const meta = NETWORKS[network];
  const wallets = await loadWallets();
  const userId = actor.walletUserId ?? actor.id;
  const first = wallets[userId] ?? Object.values(wallets).find((wallet) => wallet.userId === userId) ?? null;
  const address = first?.address ?? (userId === 'owner' ? process.env.AGENT_ADDRESS ?? null : null);

  let balanceWei = '0';
  let balanceMON = '0';
  if (address) {
    try {
      const bal = await ethGetBalance(meta.rpcUrl, address);
      balanceWei = bal.toString();
      balanceMON = weiToMon(bal);
    } catch {
      balanceWei = '0';
    }
  }

  return NextResponse.json({
    ok: true,
    initialized: Boolean(first),
    network,
    chainId: meta.chainId,
    address,
    walletId: first?.walletId ?? null,
    userId: first?.userId ?? null,
    balanceWei,
    balanceMON,
    explorerUrl: address ? `${meta.explorerUrl}/address/${address}` : meta.explorerUrl,
    walletCount: first ? 1 : 0,
  });
}
