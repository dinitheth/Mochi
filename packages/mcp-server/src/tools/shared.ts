import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from '../config/env.js';
import { getDefaultWallet, getStoredWallet, type StoredWallet } from '../config/privy.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyServer = any;

function isAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

export function textResult(payload: unknown) {
  const text = typeof payload === 'string'
    ? String(normalizeUserCopy(redactConfiguredSecrets(payload)))
    : JSON.stringify(normalizeUserCopy(redactPayload(payload)), null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

function friendlyFailure(value: unknown): string {
  const message = String(value ?? '');
  if (/no available liquidity|no route available|could not find.*route/i.test(message)) return 'Mochi could not find a suitable route for this pair right now. Try a different token pair or request a fresh quote.';
  if (/unverified.*(?:router|target)|router.*allowlist|unexpected transaction target/i.test(message)) return 'Mochi could not safely use that swap route. Your funds were not swapped; request a fresh quote to try another verified route.';
  if (/simulation|execution reverted|transaction reverted|pre-flight/i.test(message)) return 'Mochi could not safely complete the swap. Check your wallet activity before trying again, because a separate token approval may already have completed.';
  if (/insufficient funds|exceeds? (your )?balance/i.test(message)) return 'There is not enough balance to complete this action, including the network fee.';
  if (/invalid .*address|address.*invalid/i.test(message)) return 'That wallet address does not look right. Check it and try again.';
  if (/slippage|price moved|minimum output/i.test(message)) return 'The price changed too much while preparing this swap. Please request a fresh quote.';
  if (/not listed|listing.*inactive/i.test(message)) return 'This item is no longer available. Refresh the listings and choose another.';
  if (/expired/i.test(message)) return 'This request has expired. Please start again.';
  if (/permission|not (the )?owner|not permitted|unauthor/i.test(message)) return 'This action is not available for this account.';
  if (/timeout|timed out|fetch failed|ECONN|unreachable|network/i.test(message)) return 'Mochi could not reach the service. Check your connection and try again.';
  return 'Mochi could not complete that request. Please try again. If it keeps happening, contact Mochi support.';
}

function normalizeUserCopy(value: unknown, field?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeUserCopy(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key.toLowerCase().replace(/[^a-z]/g, '') !== 'chainid')
    .map(([key, nested]) => [key, key === 'error' && nested ? friendlyFailure(nested) : normalizeUserCopy(nested, key)]));
  if (typeof value !== 'string') return value;
  const normalized = value
    .replace(/\b(?:Monad(?:\s+mainnet)?|mainnet)\s*\(\s*143\s*\)/gi, 'Monad')
    .replace(/\bMonad\s+mainnet\s*[·,-]?\s*chain\s*ID\s*[:#]?\s*143\b/gi, 'Monad mainnet')
    .replace(/\bchain(?:\s*ID)?\s*[:#]?\s*143\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (field === 'summary' && /\b(?:wei|function selector|execution method|calldata|pre-flight|simulation failed|HTTP \d{3}|RPC error|mcp__[\w_]+)\b/i.test(normalized)) {
    return friendlyFailure(normalized);
  }
  return normalized;
}

const SENSITIVE_ENV_NAME = /(?:API_KEY|TOKEN|PASSWORD|SECRET|RPC_URL)$/i;

function redactConfiguredSecrets(value: string): string {
  return Object.entries(process.env)
    .filter(([name, secret]) => SENSITIVE_ENV_NAME.test(name) && Boolean(secret))
    .sort((a, b) => (b[1]?.length ?? 0) - (a[1]?.length ?? 0))
    .reduce((text, [name, secret]) => text.replaceAll(secret!, `[redacted ${name}]`), value);
}

function redactPayload(value: unknown): unknown {
  if (typeof value === 'string') return redactConfiguredSecrets(value);
  if (Array.isArray(value)) return value.map(redactPayload);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      key,
      isSensitivePayloadKey(key) && typeof nested === 'string'
        ? '[redacted]'
        : redactPayload(nested),
    ]));
  }
  return value;
}

function isSensitivePayloadKey(key: string): boolean {
  // Match credential fields, not ordinary domain fields such as token_symbol,
  // token_address, tokenId, or tokenIn. Those are needed to identify assets.
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return [
    'token', 'apikey', 'accesstoken', 'refreshtoken', 'idtoken', 'sessiontoken',
    'clientsecret', 'secret', 'secretkey', 'password', 'privatekey', 'rpcurl',
    'authorization', 'credential',
  ].some((suffix) => normalized === suffix || normalized.endsWith(suffix));
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
  wallet_wrap_native: { title: 'Convert MON to WMON', annotations: { ...MONEY } },
  wallet_import: { title: 'Link existing wallet', annotations: { ...WRITE, destructiveHint: false } },
  wallet_portfolio: { title: 'Wallet portfolio (Zerion)', annotations: { ...READONLY } },
  transaction_send_mon: { title: 'Send MON', annotations: { ...MONEY } },
  transaction_send_token: { title: 'Send tokens', annotations: { ...MONEY } },
  payments_prepare_invoice: { title: 'Prepare AUSD invoice payment', annotations: { ...READONLY } },
  payments_send_invoice: { title: 'Pay AUSD invoice', annotations: { ...MONEY } },
  payments_get_policy: { title: 'View treasury payment rules', annotations: { ...READONLY } },
  payments_set_policy: { title: 'Set treasury payment rules', annotations: { ...WRITE } },
  payments_history: { title: 'Invoice payment history', annotations: { ...READONLY } },
  payments_closeout: { title: 'Payment period closeout', annotations: { ...READONLY } },
  wallet_activity_explainer: { title: 'Explain wallet activity', annotations: { ...READONLY } },
  aave_markets: { title: 'Aave Monad markets', annotations: { ...READONLY } },
  aave_positions: { title: 'Aave lending positions', annotations: { ...READONLY } },
  kuru_orderbook_top: { title: 'Kuru order-book top', annotations: { ...READONLY } },
  kintsu_position: { title: 'Kintsu staking position', annotations: { ...READONLY } },
  kintsu_stake_mon: { title: 'Stake MON with Kintsu', annotations: { ...MONEY } },
  kintsu_request_unstake: { title: 'Request Kintsu unlock', annotations: { ...MONEY } },
  perpl_markets: { title: 'Perpl futures markets', annotations: { ...READONLY } },
  transaction_estimate_gas: { title: 'Estimate network fee', annotations: { ...READONLY } },
  transaction_get_status: { title: 'Check action status', annotations: { ...READONLY } },
  transaction_simulate: { title: 'Preview action', annotations: { ...READONLY } },
  contract_read: { title: 'View app information', annotations: { ...READONLY } },
  contract_write: { title: 'Review app action', annotations: { ...MONEY } },
  contract_deploy: { title: 'Create an on-chain app', annotations: { ...MONEY } },
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
  uniswap_quote_swap: { title: 'Quote Uniswap swap', annotations: { ...READONLY } },
  uniswap_swap_tokens: { title: 'Swap through Uniswap', annotations: { ...MONEY } },
  chain_get_network_stats: { title: 'Network status', annotations: { ...READONLY } },
  chain_get_block: { title: 'Recent network activity', annotations: { ...READONLY } },
  chain_get_gas_price: { title: 'Current network fee', annotations: { ...READONLY } },
  chain_get_logs: { title: 'Recent app activity', annotations: { ...READONLY } },
};

/** Read-only classification used by remote authorization middleware. Unknown tools fail closed. */
export function isReadOnlyMcpTool(name: string): boolean {
  if (['render_marketplace', 'render_auctions', 'render_payment_request'].includes(name)) return true;
  return TOOL_META[name]?.annotations?.readOnlyHint === true;
}

export function isKnownMcpTool(name: string): boolean {
  return Object.hasOwn(TOOL_META, name) || ['render_marketplace', 'render_auctions', 'render_payment_request'].includes(name);
}

export async function resolveWallet(env: Env, userId?: string): Promise<StoredWallet> {
  if (userId) {
    const w = await getStoredWallet(userId, env);
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
