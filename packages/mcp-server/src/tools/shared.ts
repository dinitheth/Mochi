import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from '../config/env.js';
import { getDefaultWallet, getStoredWallet, type StoredWallet } from '../config/privy.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyServer = any;

function isAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

export function textResult(payload: unknown) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

export function errorResult(message: string, extra?: Record<string, unknown>) {
  return textResult({ ok: false, error: message, ...extra });
}

/**
 * Human-friendly token amount: `raw` base units with `decimals` places,
 * trimmed to `maxDp` decimals without trailing zeros. Raw value stays
 * available separately wherever exactness matters.
 */
export function formatTokenUnits(raw: bigint, decimals: number, maxDp = 6): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  if (maxDp <= 0) return `${neg ? '-' : ''}${whole.toString()}`;
  const fracFull = (abs % base).toString().padStart(decimals, '0');
  const frac = fracFull.slice(0, maxDp).replace(/0+$/, '');
  return frac ? `${neg ? '-' : ''}${whole.toString()}.${frac}` : `${neg ? '-' : ''}${whole.toString()}`;
}

/** Compat wrapper: prefers registerTool (SDK >=1.12), falls back to tool(). */
export function addTool(
  server: McpServer,
  name: string,
  description: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<any>,
  // Optional MCP Apps / ChatGPT Apps SDK metadata: outputSchema enables
  // structuredContent results; _meta carries ui.resourceUri + openai aliases.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: { outputSchema?: Record<string, any>; _meta?: Record<string, unknown> },
): void {
  const s = server as AnyServer;
  const meta = TOOL_META[name] ?? {};
  if (typeof s.registerTool === 'function') {
    s.registerTool(
      name,
      {
        title: meta.title ?? name,
        description,
        inputSchema: schema,
        ...(options?.outputSchema ? { outputSchema: options.outputSchema } : {}),
        annotations: meta.annotations,
        ...(options?._meta ? { _meta: options._meta } : {}),
      },
      handler,
    );
  } else if (typeof s.tool === 'function') {
    s.tool(name, description, schema, handler);
  } else {
    throw new Error('MCP server supports neither registerTool nor tool');
  }
}

interface ToolMeta {
  title: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/**
 * Human titles + safety annotations. ChatGPT and Claude use these to decide
 * in-chat confirmation behavior: reads never prompt; money-moving writes do.
 * Network scope is tool-specific: local demo actions target testnet (10143), while
 * explicitly labeled ecosystem adapters target Monad mainnet (143).
 */
const READONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, idempotentHint: false, openWorldHint: true } as const;
const MONEY = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

const TOOL_META: Record<string, ToolMeta> = {
  wallet_initialize: { title: 'Set up wallet', annotations: { ...WRITE, destructiveHint: false } },
  wallet_get_address: { title: 'Get wallet address', annotations: { ...READONLY } },
  wallet_get_balance: { title: 'Get wallet balance', annotations: { ...READONLY } },
  wallet_import: { title: 'Link existing wallet', annotations: { ...WRITE, destructiveHint: false } },
  wallet_portfolio: { title: 'Wallet portfolio (Zerion)', annotations: { ...READONLY } },
  transaction_send_mon: { title: 'Send MON', annotations: { ...MONEY } },
  transaction_send_token: { title: 'Send tokens', annotations: { ...MONEY } },
  transaction_estimate_gas: { title: 'Estimate gas cost', annotations: { ...READONLY } },
  transaction_get_status: { title: 'Check transaction status', annotations: { ...READONLY } },
  transaction_simulate: { title: 'Simulate transaction', annotations: { ...READONLY } },
  contract_read: { title: 'Read contract', annotations: { ...READONLY } },
  contract_write: { title: 'Write to contract', annotations: { ...MONEY } },
  contract_deploy: { title: 'Deploy contract', annotations: { ...MONEY } },
  nft_research_collections: { title: 'Research NFT collections', annotations: { ...READONLY } },
  nft_opensea_listings: { title: 'Find OpenSea Monad listings', annotations: { ...READONLY } },
  nft_opensea_buy: { title: 'Buy OpenSea Monad NFT', annotations: { ...MONEY } },
  nft_get_user_collection: { title: 'List owned NFTs', annotations: { ...READONLY } },
  nft_buy: { title: 'Buy NFT', annotations: { ...MONEY } },
  nft_bid: { title: 'Bid on NFT auction', annotations: { ...MONEY } },
  nft_offer: { title: 'Make NFT offer', annotations: { ...MONEY } },
  nft_accept_offer: { title: 'Accept NFT offer', annotations: { ...WRITE, destructiveHint: false } },
  nft_cancel_offer: { title: 'Cancel NFT offer', annotations: { ...WRITE, destructiveHint: false } },
  nft_cancel_listing: { title: 'Cancel NFT listing', annotations: { ...WRITE, destructiveHint: false } },
  lending_deposit: { title: 'Supply lending pool', annotations: { ...MONEY } },
  lending_withdraw: { title: 'Withdraw from pool', annotations: { ...WRITE, destructiveHint: false } },
  lending_borrow: { title: 'Borrow against NFT', annotations: { ...MONEY } },
  lending_repay: { title: 'Repay NFT loan', annotations: { ...MONEY } },
  lending_positions: { title: 'Lending positions', annotations: { ...READONLY } },
  contacts_save: { title: 'Save contact', annotations: { ...WRITE, destructiveHint: false } },
  contacts_list: { title: 'List contacts', annotations: { ...READONLY } },
  contacts_remove: { title: 'Remove contact', annotations: { ...WRITE, destructiveHint: false } },
  render_marketplace: { title: 'Mochi Market', annotations: { ...READONLY } },
  render_auctions: { title: 'Mochi Auctions', annotations: { ...READONLY } },
  settings_set_auto_approve: { title: 'Auto-approve setting', annotations: { ...WRITE, destructiveHint: false } },
  settings_get_policy: { title: 'View auto-approve policy', annotations: { ...READONLY } },
  nft_settle_auction: { title: 'Settle NFT auction', annotations: { ...WRITE, destructiveHint: false } },
  nft_launch_collection: { title: 'Launch NFT collection', annotations: { ...MONEY } },
  defi_get_token_price: { title: 'Get token price', annotations: { ...READONLY } },
  defi_monad_market_brief: { title: 'Mochi Monad Market Brief', annotations: { ...READONLY } },
  defi_plan_monad_mission: { title: 'Mochi Mission Planner', annotations: { ...READONLY } },
  defi_faucet_mint: { title: 'Mint test tokens', annotations: { ...WRITE, destructiveHint: false } },
  defi_swap_tokens: { title: 'Swap tokens', annotations: { ...MONEY } },
  chain_get_network_stats: { title: 'Network stats', annotations: { ...READONLY } },
  chain_get_block: { title: 'Get block', annotations: { ...READONLY } },
  chain_get_gas_price: { title: 'Gas price', annotations: { ...READONLY } },
  chain_get_logs: { title: 'Query event logs', annotations: { ...READONLY } },
};

export async function resolveWallet(env: Env, userId?: string): Promise<StoredWallet> {
  if (userId) {
    const w = await getStoredWallet(userId);
    if (w) return w;
    throw new Error(
      `No wallet found for userId "${userId}". Call wallet_initialize with this userId first.`,
    );
  }
  const d = await getDefaultWallet(env);
  if (d) return d;
  throw new Error('No wallet initialized yet. Call wallet_initialize first.');
}

export function assertAddress(value: string, label = 'address'): asserts value is `0x${string}` {
  if (!isAddress(value)) throw new Error(`Invalid ${label}: "${value}". Expected a 0x-prefixed 40-hex-char address.`);
}

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

export const ERC721_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tokenOfOwnerByIndex',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'string' }],
  },
] as const;
