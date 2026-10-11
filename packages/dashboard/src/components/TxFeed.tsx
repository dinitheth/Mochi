'use client';

import { useEffect, useState } from 'react';

interface ActivityEntry {
  ts?: string;
  tool?: string;
  result?: string;
  txHash?: string;
  intent?: string;
  error?: string;
}

const TOOL_TITLES: Record<string, string> = {
  wallet_initialize: 'Set Up Wallet',
  wallet_get_address: 'Wallet Address',
  wallet_get_balance: 'Check Balance',
  wallet_import: 'Import Wallet',
  wallet_portfolio: 'Portfolio Overview',
  transaction_send_mon: 'Send MON',
  transaction_send_token: 'Send Tokens',
  transaction_estimate_gas: 'Estimate Gas',
  transaction_get_status: 'Transaction Status',
  transaction_simulate: 'Simulate Transaction',
  contract_read: 'Read Contract',
  contract_write: 'Write Contract',
  contract_deploy: 'Deploy Contract',
  nft_research_collections: 'Research NFTs',
  nft_get_user_collection: 'My NFTs',
  nft_buy: 'Buy NFT',
  nft_bid: 'Place Bid',
  nft_settle_auction: 'Settle Auction',
  nft_launch_collection: 'Launch Collection',
  nft_offer: 'Make Offer',
  nft_accept_offer: 'Accept Offer',
  nft_cancel_offer: 'Cancel Offer',
  nft_cancel_listing: 'Cancel Listing',
  defi_get_token_price: 'Token Price',
  defi_faucet_mint: 'Mint Test Tokens',
  defi_swap_tokens: 'Swap Tokens',
  chain_get_network_stats: 'Network Stats',
  chain_get_block: 'Block Info',
  chain_get_gas_price: 'Gas Price',
  chain_get_logs: 'Event Logs',
  lending_deposit: 'Supply Funds',
  lending_withdraw: 'Withdraw Funds',
  lending_borrow: 'Borrow Funds',
  lending_repay: 'Repay Loan',
  lending_positions: 'Lending Overview',
  contacts_save: 'Save Contact',
  contacts_list: 'View Contacts',
  contacts_remove: 'Remove Contact',
};

function titleFor(tool?: string): string {
  if (!tool) return 'Activity';
  return TOOL_TITLES[tool] ?? tool;
}

function shortHash(h: string): string {
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Replace every full 0x address in display text with its short form. */
function shortenAddresses(text: string): string {
  return text.replace(/0x[0-9a-fA-F]{40}/g, (m) => shortAddress(m));
}

const ERROR_SHORTCUTS: Array<[RegExp, string]> = [
  [/exceeds the balance|insufficient funds/i, 'Insufficient funds'],
  [/invalid.*address|invalid address|address.*"0x/i, 'Invalid address'],
  [/execution reverted|reverted/i, 'Transaction would revert'],
  [/below reserve/i, 'Below reserve price'],
  [/not listed|not actively listed/i, 'Not listed'],
  [/already ended|auction.*ended/i, 'Auction ended'],
  [/already settled|settled/i, 'Already settled'],
  [/no auction|does not exist/i, 'Not found'],
  [/allowance/i, 'Allowance too low'],
  [/not (the )?owner|not seller|not buyer|not borrower/i, 'Not permitted'],
  [/expired/i, 'Expired'],
  [/slippage/i, 'Slippage too high'],
  [/no signer|no wallet|not configured/i, 'Wallet not ready'],
  [/webhook|unreachable|ECONNREFUSED|fetch failed|timeout|timed out/i, 'Network issue — retry'],
];

function shortError(msg: string): string {
  for (const [re, label] of ERROR_SHORTCUTS) {
    if (re.test(msg)) return label;
  }
  return msg.length > 90 ? msg.slice(0, 87) + '…' : msg;
}

export default function TxFeed() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/activity', { cache: 'no-store' });
        const data = await res.json();
        if (alive) setEntries(data.entries ?? []);
      } catch {
        /* offline — keep stale */
      }
    };
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="rounded-xl bg-panel p-5 border border-white/10">
      <h2 className="text-sm font-semibold tracking-wide text-white/70">LIVE AGENT ACTIVITY</h2>
      {entries.length === 0 ? (
        <p className="mt-3 text-sm text-white/50">No agent actions yet. Activity appears here in real time.</p>
      ) : (
        <ul className="mt-3 space-y-2 max-h-96 overflow-y-auto no-scrollbar">
          {entries.map((e, i) => (
            <li key={i} className="rounded-lg bg-ink/60 border border-white/5 px-3 py-2 text-sm min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-white/90 truncate">{titleFor(e.tool)}</span>
                <span
                  className={`shrink-0 text-xs px-2 py-0.5 rounded-full ${
                    e.result === 'ok'
                      ? 'bg-green-500/15 text-green-300'
                      : e.result === 'rejected'
                        ? 'bg-red-500/15 text-red-300'
                        : 'bg-yellow-500/15 text-yellow-300'
                  }`}
                >
                  {e.result ?? '—'}
                </span>
              </div>
              {e.intent ? (
                <p className="mt-1 text-white/70 break-words">{shortenAddresses(e.intent)}</p>
              ) : e.txHash ? (
                <p className="mt-1 font-mono text-xs text-white/50">{shortHash(e.txHash)}</p>
              ) : null}
              {e.error && <p className="mt-1 text-xs text-red-300 break-words">{shortenAddresses(shortError(e.error))}</p>}
              {e.ts && <p className="mt-1 text-xs text-white/30">{new Date(e.ts).toLocaleString()}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
