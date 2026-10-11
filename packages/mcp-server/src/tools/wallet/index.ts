import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatEther } from 'viem';
import type { Env } from '../../config/env.js';
import { explorerAddressUrl, getExplorerUrl, getPublicClient, NETWORK_META } from '../../config/monad.js';
import { createOrLoadWallet, getStoredWallet, importWalletRecord } from '../../config/privy.js';
import { auditLog } from '../../middleware/audit-log.js';
import { ERC20_ABI, addTool, assertAddress, resolveWallet, textResult } from '../shared.js';
import { resolveRecipient } from '../../config/contacts.js';

function zerionHeaders(env: Env): Record<string, string> | null {
  if (!env.ZERION_API_KEY) return null;
  return {
    Authorization: `Basic ${Buffer.from(env.ZERION_API_KEY + ':').toString('base64')}`,
    accept: 'application/json',
  };
}

const KNOWN_TOKENS: Record<string, Array<{ symbol: string; address: `0x${string}` }>> = {
  // Curated from https://github.com/monad-crypto/token-list (mainnet); testnet intentionally sparse.
  mainnet: [
    { symbol: 'WMON', address: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A' },
  ],
  testnet: [{ symbol: 'WMON', address: '0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541' }],
};

export function registerWalletTools(server: McpServer, env: Env): void {
  addTool(
    server,
    'wallet_initialize',
    'First-time setup: create or load the Privy-secured agent wallet for a userId. Returns address, MON balance, network and explorer link.',
    {
      userId: z.string().min(1).describe('Unique identifier for this user/session'),
      network: z.enum(['mainnet', 'testnet']).default('testnet').describe('Monad network to use'),
    },
    async ({ userId }: { userId: string; network?: string }) => {
      try {
        const { wallet, isNew, mode } = await createOrLoadWallet(env, userId);
        const client = getPublicClient(env);
        let balanceWei = 0n;
        try {
          balanceWei = await client.getBalance({ address: wallet.address as `0x${string}` });
        } catch {
          balanceWei = 0n;
        }
        const meta = NETWORK_META[env.MONAD_NETWORK];
        await auditLog({ tool: 'wallet_initialize', userId, result: 'ok', params: { isNew, mode } });
        return textResult({
          ok: true,
          isNew,
          mode,
          userId,
          address: wallet.address,
          privyWalletId: wallet.walletId,
          network: env.MONAD_NETWORK,
          chainId: meta.chainId,
          balanceMON: formatEther(balanceWei),
          balanceWei: balanceWei.toString(),
          explorerUrl: explorerAddressUrl(env, wallet.address),
          faucet: meta.faucet,
          summary:
            mode === 'privy'
              ? `Wallet ${isNew ? 'created' : 'loaded'} via Privy. Address ${wallet.address} holds ${formatEther(balanceWei)} MON on ${meta.name}. View: ${explorerAddressUrl(env, wallet.address)}`
              : `Wallet ${isNew ? 'registered' : 'loaded'} in ${mode} mode (Privy not configured). Address ${wallet.address} holds ${formatEther(balanceWei)} MON on ${meta.name}. Set PRIVY_APP_ID/PRIVY_APP_SECRET for production signing.`,
        });
      } catch (err) {
        await auditLog({ tool: 'wallet_initialize', userId, result: 'error', error: err instanceof Error ? err.message : String(err) });
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  addTool(
    server,
    'wallet_get_address',
    "Return the agent's current wallet address, network and explorer URL.",
    {
      userId: z.string().optional().describe('User/session id. Defaults to the first initialized wallet.'),
    },
    async ({ userId }: { userId?: string }) => {
      try {
        const wallet = await resolveWallet(env, userId);
        return textResult({
          ok: true,
          address: wallet.address,
          privyWalletId: wallet.walletId,
          network: env.MONAD_NETWORK,
          chainId: NETWORK_META[env.MONAD_NETWORK].chainId,
          explorerUrl: getExplorerUrl(env),
          addressUrl: explorerAddressUrl(env, wallet.address),
          summary: `Agent wallet: ${wallet.address} on ${NETWORK_META[env.MONAD_NETWORK].name} (${explorerAddressUrl(env, wallet.address)})`,
        });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  addTool(
    server,
    'wallet_get_balance',
    "Get MON balance and known ERC20 balances for the agent wallet (or any address).",
    {
      address: z.string().optional().describe('Address or saved contact name. Defaults to the agent wallet.'),
      userId: z.string().optional().describe('User/session id used to resolve the default wallet.'),
    },
    async ({ address, userId }: { address?: string; userId?: string }) => {
      try {
        let target: string | undefined = address;
        if (!target) target = (await resolveWallet(env, userId)).address;
        else if (!/^0x[0-9a-fA-F]{40}$/.test(target)) target = await resolveRecipient(userId, target);
        assertAddress(target);
        const client = getPublicClient(env);
        const balanceWei = await client.getBalance({ address: target as `0x${string}` });
        const tokens: Array<{ symbol: string; address: string; balance: string }> = [];
        for (const t of KNOWN_TOKENS[env.MONAD_NETWORK] ?? []) {
          try {
            const [raw, decimals] = await Promise.all([
              client.readContract({ address: t.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [target as `0x${string}`] }) as Promise<bigint>,
              client.readContract({ address: t.address, abi: ERC20_ABI, functionName: 'decimals' }) as Promise<number>,
            ]);
            const d = Number(decimals);
            const whole = raw / 10n ** BigInt(d);
            const frac = (raw % 10n ** BigInt(d)).toString().padStart(d, '0').replace(/0+$/, '').slice(0, 6);
            tokens.push({ symbol: t.symbol, address: t.address, balance: frac ? `${whole}.${frac}` : whole.toString() });
          } catch {
            continue;
          }
        }
        await auditLog({ tool: 'wallet_get_balance', userId, result: 'ok', params: { address: target } });
        return textResult({
          ok: true,
          address: target,
          network: env.MONAD_NETWORK,
          balanceMON: formatEther(balanceWei),
          balanceWei: balanceWei.toString(),
          tokens,
          explorerUrl: explorerAddressUrl(env, target),
          summary: `${target} holds ${formatEther(balanceWei)} MON on ${NETWORK_META[env.MONAD_NETWORK].name}${tokens.length ? ` plus ${tokens.map((t) => `${t.balance} ${t.symbol}`).join(', ')}` : ''}.`,
        });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  addTool(
    server,
    'wallet_portfolio',
    'Portfolio overview via Zerion: total positions value, distribution by type/chain and 24h change. Read-only analytics.',
    {
      address: z.string().optional().describe('Address to analyze. Defaults to the agent wallet.'),
      userId: z.string().optional().describe('User/session id used to resolve the default wallet.'),
      chain: z.string().optional().describe('Zerion chain filter, e.g. "monad". Defaults to all supported chains.'),
      currency: z.string().default('usd').describe('Fiat currency for valuation'),
    },
    async ({ address, userId, chain, currency }: { address?: string; userId?: string; chain?: string; currency: string }) => {
      try {
        const headers = zerionHeaders(env);
        if (!headers) {
          return textResult({
            ok: true,
            source: 'unconfigured',
            summary: 'Zerion is not configured (set ZERION_API_KEY). Use wallet_get_balance for on-chain balances instead.',
          });
        }
        let target = address;
        if (!target) target = (await resolveWallet(env, userId)).address;
        assertAddress(target);
        const params = new URLSearchParams({ currency });
        if (chain) params.set('filter[chain_ids]', chain);
        const res = await fetch(`https://api.zerion.io/v1/wallets/${target}/portfolio?${params.toString()}`, { headers });
        if (res.status === 402) {
          return textResult({
            ok: true,
            source: 'plan-limited',
            summary: 'Your Zerion plan covers the portfolio endpoint but returned 402 for this query. Use wallet_get_balance for on-chain balances.',
          });
        }
        if (!res.ok) throw new Error(`Zerion portfolio failed: HTTP ${res.status}`);
        const data = (await res.json()) as {
          data?: { attributes?: { total?: { positions?: number }; positions_distribution_by_type?: Record<string, number>; positions_distribution_by_chain?: Record<string, number>; changes?: { absolute_1d?: number; percent_1d?: number | null } } };
        };
        const a = data.data?.attributes;
        await auditLog({ tool: 'wallet_portfolio', userId, result: 'ok', params: { address: target, chain: chain ?? null } });
        const total = a?.total?.positions ?? 0;
        const chg = a?.changes;
        return textResult({
          ok: true,
          source: 'zerion',
          address: target,
          totalUSD: total,
          byType: a?.positions_distribution_by_type ?? {},
          byChain: a?.positions_distribution_by_chain ?? {},
          change24hUSD: chg?.absolute_1d ?? 0,
          change24hPct: chg?.percent_1d ?? null,
          summary:
            total > 0
              ? `${target} holds $${total.toFixed(2)} across positions (${chg?.percent_1d != null ? `${chg.percent_1d.toFixed(2)}%` : 'n/a'} 24h).`
              : `${target} shows no Zerion-indexed positions${chain ? ` on ${chain}` : ''}. Testnet coverage is thin — on-chain balances via wallet_get_balance remain the source of truth there.`,
        });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  addTool(
    server,
    'wallet_import',
    'Link an existing address (or Privy wallet id) to a userId for this server.',
    {
      userId: z.string().min(1).describe('User/session id to attach the wallet to'),
      address: z.string().describe('EVM address to link (0x...)'),
      walletId: z.string().optional().describe('Privy wallet id if known; defaults to linked:<address>'),
    },
    async ({ userId, address, walletId }: { userId: string; address: string; walletId?: string }) => {
      try {
        assertAddress(address);
        const wallet = await importWalletRecord(userId, address, walletId ?? `linked:${address}`, env.MONAD_NETWORK);
        const existing = await getStoredWallet(userId);
        void existing;
        await auditLog({ tool: 'wallet_import', userId, result: 'ok', params: { address } });
        return textResult({
          ok: true,
          userId,
          address: wallet.address,
          privyWalletId: wallet.walletId,
          explorerUrl: explorerAddressUrl(env, wallet.address),
          summary: `Linked ${address} to user "${userId}". View: ${explorerAddressUrl(env, address)}`,
        });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
