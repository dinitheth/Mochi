import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { encodeFunctionData, formatEther, formatUnits, parseAbi, parseEther } from 'viem';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import { getPublicClient } from '../../config/monad.js';
import { explorerTxUrl } from '../../config/monad.js';
import { privySendTransaction } from '../../config/privy.js';
import { approvalGate } from '../../middleware/approval-gate.js';
import { auditLog } from '../../middleware/audit-log.js';
import { simulateTx } from '../../middleware/simulate.js';
import { addTool, assertAddress, resolveWallet, textResult } from '../shared.js';

/** Monad mainnet deployments checked against the Monad protocol registry. */
export const AAVE_V3 = {
  pool: '0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef' as const,
  dataProvider: '0xB65A68B98274ef7D9a60E0C0747dD1BEc3D32fad' as const,
};
export const KINTSU_VAULT = '0xA3227C5969757783154C60bF0bC1944180ed81B9' as const;
export const PERPL_API = 'https://app.perpl.xyz/api';

const DATA_PROVIDER_ABI = parseAbi([
  'function getAllReservesTokens() view returns ((string symbol,address tokenAddress)[])',
  'function getUserReserveData(address asset,address user) view returns (uint256 currentATokenBalance,uint256 currentStableDebt,uint256 currentVariableDebt,uint256 principalStableDebt,uint256 scaledVariableDebt,uint stableBorrowRate,uint liquidityRate,uint40 stableRateLastUpdated,bool usageAsCollateralEnabled)',
]);
const AAVE_POOL_ABI = parseAbi([
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)',
]);
const KINTSU_ABI = parseAbi([
  'function deposit(uint96 minShares,address receiver) payable',
  'function convertToShares(uint96 assets) view returns (uint96)',
  'function convertToAssets(uint96 shares) view returns (uint96)',
  'function getAllUserUnlockRequests(address user) view returns ((uint96 shares,uint96 spotValue,uint64 batchId,uint16 exitFeeBips)[])',
  'function requestUnlock(uint96 shares,uint96 minSpotValue)',
]);
const MAX_UINT96 = 2n ** 96n - 1n;

export function applyMinReceiveSlippage(quote: bigint, slippageBps = 50): bigint {
  if (quote <= 0n || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw new Error('Invalid quote or slippage tolerance.');
  return (quote * BigInt(10_000 - slippageBps)) / 10_000n;
}
const KURU_ORDERBOOK_ABI = parseAbi([
  'function bestBidAsk() view returns (uint256 bestBid,uint256 bestAsk)',
  'function getMarketParams() view returns (uint32 pricePrecision,uint96 sizePrecision,address baseAsset,uint256 baseDecimals,address quoteAsset,uint256 quoteDecimals,uint32 tickSize,uint96 minSize,uint96 maxSize,uint256 takerFeeBps,uint256 makerFeeBps)',
]);

export interface PerplMarketContext {
  chain?: { id?: number; chain_id?: number; name?: string };
  markets?: Array<Record<string, unknown>>;
  tokens?: unknown[];
}

export function parsePerplMarketContext(value: unknown): PerplMarketContext {
  if (!value || typeof value !== 'object' || !Array.isArray((value as PerplMarketContext).markets)) {
    throw new Error('Perpl returned an invalid market context.');
  }
  const result = value as PerplMarketContext;
  const chainId = result.chain?.id ?? result.chain?.chain_id;
  if (chainId !== 143) {
    throw new Error(`Perpl context is for chain ${chainId ?? 'unknown'}; expected Monad mainnet (143).`);
  }
  const markets = result.markets!;
  result.markets = markets.map((market) => {
    const config = (market.config && typeof market.config === 'object' ? market.config : {}) as Record<string, unknown>;
    const state = (market.state && typeof market.state === 'object' ? market.state : {}) as Record<string, unknown>;
    return {
      id: market.id,
      name: market.name ?? market.symbol,
      priceDecimals: config.price_decimals,
      sizeDecimals: config.size_decimals,
      isOpen: config.is_open,
      midRaw: state.mid,
      bidRaw: state.bid,
      askRaw: state.ask,
      fundingRateRaw: (market.funding as Record<string, unknown> | undefined)?.rate,
    };
  });
  return result;
}

export async function fetchPerplMarkets(fetchImpl: typeof fetch = fetch): Promise<PerplMarketContext> {
  const response = await fetchImpl(`${PERPL_API}/v1/pub/context`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Perpl API returned HTTP ${response.status}.`);
  return parsePerplMarketContext(await response.json());
}

async function ensureMainnet(env: Env) {
  if (env.MONAD_NETWORK !== 'mainnet') throw new Error('This integration is Monad mainnet only.');
  const client = getPublicClient(env);
  const chainId = await client.getChainId();
  if (chainId !== 143) throw new Error(`Configured RPC returned chain ${chainId}; expected Monad mainnet (143).`);
  return client;
}

export function registerEcosystemTools(server: McpServer, env: Env): void {
  addTool(server, 'kuru_orderbook_top', 'Read the best bid/ask and market precision from a Kuru Monad spot order book. Supply the order-book contract address; no order is placed.', {
    marketAddress: z.string().describe('Kuru order-book contract address on Monad mainnet'),
  }, async ({ marketAddress }: { marketAddress: string }) => {
    try {
      const client = await ensureMainnet(env);
      assertAddress(marketAddress, 'Kuru market');
      const market = marketAddress as `0x${string}`;
      const code = await client.getBytecode({ address: market });
      if (!code || code === '0x') throw new Error('No contract code exists at this market address on Monad mainnet.');
      const [top, params] = await Promise.all([
        client.readContract({ address: market, abi: KURU_ORDERBOOK_ABI, functionName: 'bestBidAsk' }),
        client.readContract({ address: market, abi: KURU_ORDERBOOK_ABI, functionName: 'getMarketParams' }),
      ]);
      const [pricePrecision, sizePrecision, baseAsset, baseDecimals, quoteAsset, quoteDecimals, tickSize, minSize, maxSize, takerFeeBps, makerFeeBps] = params;
      const [bestBid, bestAsk] = top;
      return textResult({ ok: true, protocol: 'Kuru', market, network: 'Monad mainnet (143)', baseAsset, baseDecimals: Number(baseDecimals), quoteAsset, quoteDecimals: Number(quoteDecimals), bestBidRaw: bestBid.toString(), bestAskRaw: bestAsk.toString(), pricePrecision: pricePrecision.toString(), sizePrecision: sizePrecision.toString(), tickSize: tickSize.toString(), minSize: minSize.toString(), maxSize: maxSize.toString(), takerFeeBps: takerFeeBps.toString(), makerFeeBps: makerFeeBps.toString(), summary: `Kuru book ${market}: raw best bid ${bestBid} and ask ${bestAsk} at price precision ${pricePrecision}. Values are returned with the contract's explicit precision metadata; no trade was sent.` });
    } catch (err) { return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
  });

  addTool(server, 'aave_markets', 'Read Aave V3 Monad reserve markets from the deployed Aave Protocol Data Provider. No transaction is sent.', {}, async () => {
    try {
      const client = await ensureMainnet(env);
      const code = await client.getBytecode({ address: AAVE_V3.dataProvider });
      if (!code || code === '0x') throw new Error('Aave Data Provider has no code at the configured Monad deployment address.');
      const reserves = await client.readContract({ address: AAVE_V3.dataProvider, abi: DATA_PROVIDER_ABI, functionName: 'getAllReservesTokens' });
      const markets = reserves.map(({ symbol, tokenAddress }) => ({ symbol, asset: tokenAddress }));
      return textResult({ ok: true, protocol: 'Aave V3', network: 'Monad mainnet (143)', source: AAVE_V3.dataProvider, markets, count: markets.length, summary: `Loaded ${markets.length} Aave V3 reserve assets from Monad mainnet.` });
    } catch (err) { return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
  });

  addTool(server, 'aave_positions', 'Read Aave V3 Monad collateral, debt, available borrowing capacity, health factor, and reserve balances for a wallet. Read-only; no supply or borrow transaction is sent.', {
    address: z.string().optional().describe('Wallet address; defaults to the linked Mochi wallet'), userId: z.string().optional(),
  }, async ({ address, userId }: { address?: string; userId?: string }) => {
    try {
      const client = await ensureMainnet(env);
      const account = address ?? (await resolveWallet(env, userId)).address;
      assertAddress(account, 'wallet');
      const code = await client.getBytecode({ address: AAVE_V3.dataProvider });
      if (!code || code === '0x') throw new Error('Aave Data Provider has no code at the configured Monad deployment address.');
      const [reserves, totals] = await Promise.all([
        client.readContract({ address: AAVE_V3.dataProvider, abi: DATA_PROVIDER_ABI, functionName: 'getAllReservesTokens' }),
        client.readContract({ address: AAVE_V3.pool, abi: AAVE_POOL_ABI, functionName: 'getUserAccountData', args: [account as `0x${string}`] }),
      ]);
      const positions = await Promise.all(reserves.map(async ({ symbol, tokenAddress }) => {
        const [data, decimals] = await Promise.all([
          client.readContract({ address: AAVE_V3.dataProvider, abi: DATA_PROVIDER_ABI, functionName: 'getUserReserveData', args: [tokenAddress, account as `0x${string}`] }),
          client.readContract({ address: tokenAddress, abi: parseAbi(['function decimals() view returns (uint8)']), functionName: 'decimals' }).catch(() => 18),
        ]);
        const supplied = data[0];
        const debt = data[1] + data[2];
        if (supplied === 0n && debt === 0n) return null;
        return { symbol, asset: tokenAddress, supplied: formatUnits(supplied, Number(decimals)), variableDebt: formatUnits(data[2], Number(decimals)), stableDebt: formatUnits(data[1], Number(decimals)), totalDebt: formatUnits(debt, Number(decimals)), usedAsCollateral: data[8] };
      }));
      const [collateral, debt, available, liquidationThreshold, ltv, healthFactor] = totals;
      const active = positions.filter((position) => position !== null);
      return textResult({ ok: true, protocol: 'Aave V3', network: 'Monad mainnet (143)', wallet: account, positions: active, accountData: { collateralBase: collateral.toString(), debtBase: debt.toString(), availableBorrowsBase: available.toString(), liquidationThresholdBps: liquidationThreshold.toString(), ltvBps: ltv.toString(), healthFactorRay: healthFactor.toString() }, summary: active.length ? `Aave V3 has ${active.length} active reserve position(s). Health factor is ${healthFactor === (1n << 256n) - 1n ? 'infinite (no debt)' : formatUnits(healthFactor, 18)}; inspect the raw account data before acting.` : 'No supplied or borrowed Aave reserves found for this wallet.' });
    } catch (err) { return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
  });

  addTool(server, 'kintsu_position', 'Read Monad sMON balance, its current MON conversion estimate, and queued unlock requests. Unlocking is batched and delayed; this is a read-only position tool.', {
    address: z.string().optional().describe('Wallet address; defaults to the linked Mochi wallet'), userId: z.string().optional(),
  }, async ({ address, userId }: { address?: string; userId?: string }) => {
    try {
      const client = await ensureMainnet(env);
      const account = address ?? (await resolveWallet(env, userId)).address;
      assertAddress(account, 'wallet');
      const code = await client.getBytecode({ address: KINTSU_VAULT });
      if (!code || code === '0x') throw new Error('Kintsu Monad staking contract has no code at the documented address.');
      const [shares, unlocks] = await Promise.all([
        client.readContract({ address: KINTSU_VAULT, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [account as `0x${string}`] }),
        client.readContract({ address: KINTSU_VAULT, abi: KINTSU_ABI, functionName: 'getAllUserUnlockRequests', args: [account as `0x${string}`] }),
      ]);
      const monValue = shares > 0n ? await client.readContract({ address: KINTSU_VAULT, abi: KINTSU_ABI, functionName: 'convertToAssets', args: [shares > 2n ** 96n - 1n ? 2n ** 96n - 1n : shares] }) : 0n;
      return textResult({ ok: true, protocol: 'Kintsu', network: 'Monad mainnet (143)', wallet: account, sMONShares: formatUnits(shares, 18), estimatedMONValue: formatUnits(monValue, 18), unlockRequests: unlocks.map((r) => ({ shares: formatUnits(r.shares, 18), spotValueMON: formatUnits(r.spotValue, 18), batchId: r.batchId.toString(), exitFeeBips: r.exitFeeBips.toString() })), note: 'The conversion is a current estimate. Unlock requests require batching and cooldown before redemption.', summary: `Wallet holds ${formatUnits(shares, 18)} sMON (estimated ${formatUnits(monValue, 18)} MON) and has ${unlocks.length} pending unlock request(s).` });
    } catch (err) { return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
  });

  addTool(server, 'kintsu_stake_mon', 'Stake MON into Kintsu on Monad. Shows the sMON quote and minimum shares, simulates the exact payable call, and always requires human approval.', {
    amount: z.string().describe('MON amount to stake, e.g. "1.25"'), userId: z.string().optional(),
  }, async ({ amount, userId }: { amount: string; userId?: string }) => {
    try {
      const client = await ensureMainnet(env);
      const wallet = await resolveWallet(env, userId);
      const amountWei = parseEther(amount);
      if (amountWei <= 0n || amountWei > MAX_UINT96) throw new Error('Stake amount must be positive and fit Kintsu’s uint96 amount limit.');
      const quote = await client.readContract({ address: KINTSU_VAULT, abi: KINTSU_ABI, functionName: 'convertToShares', args: [amountWei] });
      const minShares = applyMinReceiveSlippage(quote);
      const data = encodeFunctionData({ abi: KINTSU_ABI, functionName: 'deposit', args: [minShares, wallet.address as `0x${string}`] });
      const simulation = await simulateTx(env, { from: wallet.address, to: KINTSU_VAULT, value: amountWei, data });
      if (!simulation.ok) throw new Error(`Kintsu stake simulation failed: ${simulation.reason}`);
      const gate = await approvalGate({ action: 'kintsu_stake_mon', details: { from: wallet.address, vault: KINTSU_VAULT, amountMON: formatEther(amountWei), quotedShares: formatEther(quote), minimumShares: formatEther(minShares), slippageBps: 50, estimatedFeeMON: formatEther(simulation.feeWei), chainId: 143 }, valueWei: amountWei, env, forceApproval: true, reason: `Stake ${formatEther(amountWei)} MON with Kintsu`, userId });
      if (gate.decision !== 'approved') return textResult({ ok: false, approvalRequired: true, requestId: gate.requestId, summary: `Kintsu stake was not sent. ${gate.message}` });
      const hash = await privySendTransaction(env, wallet, { to: KINTSU_VAULT, value: amountWei, data });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`Kintsu stake reverted: ${hash}`);
      await auditLog({ tool: 'kintsu_stake_mon', userId, result: 'ok', txHash: hash, params: { amount: formatEther(amountWei), minShares: minShares.toString() } });
      return textResult({ ok: true, txHash: hash, explorerUrl: explorerTxUrl(env, hash), amountMON: formatEther(amountWei), quotedShares: formatEther(quote), minimumShares: formatEther(minShares), blockNumber: receipt.blockNumber.toString(), summary: `Staked ${formatEther(amountWei)} MON with Kintsu. Estimated ${formatEther(quote)} sMON; at least ${formatEther(minShares)} sMON was required. Tx: ${explorerTxUrl(env, hash)}` });
    } catch (err) { const message = err instanceof Error ? err.message : String(err); await auditLog({ tool: 'kintsu_stake_mon', userId, result: 'error', error: message }); return textResult({ ok: false, error: message }); }
  });

  addTool(server, 'kintsu_request_unstake', 'Request a Kintsu sMON unlock on Monad. This queues a batched unstake and is not an immediate withdrawal. Simulates the exact call and always requires human approval.', {
    shares: z.string().describe('sMON shares to unlock, e.g. "1.25"'), userId: z.string().optional(),
  }, async ({ shares, userId }: { shares: string; userId?: string }) => {
    try {
      const client = await ensureMainnet(env);
      const wallet = await resolveWallet(env, userId);
      const sharesWei = parseEther(shares);
      if (sharesWei <= 0n || sharesWei > MAX_UINT96) throw new Error('Share amount must be positive and fit Kintsu’s uint96 amount limit.');
      const currentShares = await client.readContract({ address: KINTSU_VAULT, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [wallet.address as `0x${string}`] });
      if (currentShares < sharesWei) throw new Error(`Insufficient sMON balance. Available: ${formatEther(currentShares)} sMON.`);
      const quotedAssets = await client.readContract({ address: KINTSU_VAULT, abi: KINTSU_ABI, functionName: 'convertToAssets', args: [sharesWei] });
      const minSpotValue = applyMinReceiveSlippage(quotedAssets);
      const data = encodeFunctionData({ abi: KINTSU_ABI, functionName: 'requestUnlock', args: [sharesWei, minSpotValue] });
      const simulation = await simulateTx(env, { from: wallet.address, to: KINTSU_VAULT, value: 0n, data });
      if (!simulation.ok) throw new Error(`Kintsu unlock request simulation failed: ${simulation.reason}`);
      const gate = await approvalGate({ action: 'kintsu_request_unstake', details: { from: wallet.address, vault: KINTSU_VAULT, shares: formatEther(sharesWei), estimatedMONValue: formatEther(quotedAssets), minimumSpotValue: formatEther(minSpotValue), slippageBps: 50, estimatedFeeMON: formatEther(simulation.feeWei), chainId: 143, settlement: 'delayed batch and cooldown; not immediately redeemable' }, valueWei: 0n, env, forceApproval: true, reason: `Request Kintsu unlock for ${formatEther(sharesWei)} sMON`, userId });
      if (gate.decision !== 'approved') return textResult({ ok: false, approvalRequired: true, requestId: gate.requestId, summary: `Kintsu unlock request was not sent. ${gate.message}` });
      const hash = await privySendTransaction(env, wallet, { to: KINTSU_VAULT, value: 0n, data });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`Kintsu unlock request reverted: ${hash}`);
      await auditLog({ tool: 'kintsu_request_unstake', userId, result: 'ok', txHash: hash, params: { shares: formatEther(sharesWei), minSpotValue: minSpotValue.toString() } });
      return textResult({ ok: true, txHash: hash, explorerUrl: explorerTxUrl(env, hash), shares: formatEther(sharesWei), estimatedMONValue: formatEther(quotedAssets), minimumSpotValue: formatEther(minSpotValue), blockNumber: receipt.blockNumber.toString(), note: 'This only submits an unlock request. Kintsu batches unstaking and applies a cooldown before a separate redeem action can withdraw MON.', summary: `Requested an unlock for ${formatEther(sharesWei)} sMON (estimated ${formatEther(quotedAssets)} MON). Funds are not immediately available; wait for Kintsu’s batch and cooldown. Tx: ${explorerTxUrl(env, hash)}` });
    } catch (err) { const message = err instanceof Error ? err.message : String(err); await auditLog({ tool: 'kintsu_request_unstake', userId, result: 'error', error: message }); return textResult({ ok: false, error: message }); }
  });

  addTool(server, 'perpl_markets', 'Read current Perpl Monad perpetual markets and market identifiers from Perpl’s public REST context. This tool does not place orders.', {}, async () => {
    try {
      if (env.MONAD_NETWORK !== 'mainnet') throw new Error('Perpl mainnet market data is disabled while Mochi is configured for testnet.');
      const context = await fetchPerplMarkets();
      return textResult({ ok: true, protocol: 'Perpl', network: 'Monad mainnet (143)', markets: context.markets, count: context.markets?.length ?? 0, summary: `Loaded ${context.markets?.length ?? 0} current Perpl perpetual markets. Market data is read-only; placing or managing positions is not enabled in this adapter.` });
    } catch (err) { return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
  });
}
