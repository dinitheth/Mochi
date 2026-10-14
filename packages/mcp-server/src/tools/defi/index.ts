import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { encodeFunctionData, formatEther } from 'viem';
import type { Env } from '../../config/env.js';
import { explorerAddressUrl, explorerTxUrl, getPublicClient, NETWORK_META } from '../../config/monad.js';
import { getDexConfig, resolveMockToken } from '../../config/dex.js';
import { privySendTransaction } from '../../config/privy.js';
import { approvalGate } from '../../middleware/approval-gate.js';
import { auditLog } from '../../middleware/audit-log.js';
import { ERC20_ABI, addTool, assertAddress, formatTokenUnits, resolveWallet, textResult } from '../shared.js';
import { simulateTx } from '../../middleware/simulate.js';
import { getZeroExSwapQuote, ZEROEX_ALLOWANCE_HOLDER, ZEROEX_NATIVE_TOKEN } from '../../integrations/zeroex.js';
import { fetchMonadTokenFlows, fetchMonadTokenScreen } from '../../integrations/nansen.js';
import { fetchZerionMonadTokenPosition } from '../../integrations/zerion.js';
import { hyperSyncLogs } from '../../config/hypersync.js';

/** UniswapV2-style router ABI — also matches our MicroSwap pool on testnet. */
const ROUTER_ABI = [
  {
    type: 'function',
    name: 'getAmountsOut',
    stateMutability: 'view',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'swapExactTokensForTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const;

const ALLOWANCE_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

const MINT_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

async function zerionPrice(env: Env, tokenAddress: string): Promise<number | null> {
  if (!env.ZERION_API_KEY) return null;
  try {
    const res = await fetch(`https://api.zerion.io/v1/fungibles/${tokenAddress}?currency=usd`, {
      headers: { Authorization: `Basic ${Buffer.from(env.ZERION_API_KEY + ':').toString('base64')}`, accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { attributes?: { market_data?: { price?: number } } } };
    return data?.data?.attributes?.market_data?.price ?? null;
  } catch {
    return null;
  }
}

function parseTokenAmount(amount: string, decimals: number): bigint {
  const [whole, frac = ''] = amount.split('.');
  if (!/^\d+$/.test(whole) || (frac && !/^\d+$/.test(frac))) throw new Error(`Invalid amount "${amount}".`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error(`Unsupported token decimals: ${decimals}.`);
  if (frac.length > decimals) throw new Error(`Amount has more than ${decimals} decimal places.`);
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (raw <= 0n) throw new Error('Amount must be > 0.');
  return raw;
}

const APPROVAL_ABI = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

const TOKEN_SYMBOL_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

function asAddress(value: string, label: string): `0x${string}` {
  assertAddress(value, label);
  return value as `0x${string}`;
}

const MAINNET_TOKEN_ALIASES: Record<string, `0x${string}`> = {
  mon: ZEROEX_NATIVE_TOKEN,
  wmon: NETWORK_META.mainnet.wmon,
  usdc: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  ausd: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
};

function resolveMainnetToken(value: string, label: string): `0x${string}` {
  const alias = MAINNET_TOKEN_ALIASES[value.trim().toLowerCase()];
  return alias ?? asAddress(value, label);
}

async function executeMainnetZeroExSwap(input: {
  env: Env;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippageTolerance: number;
  userId?: string;
}): Promise<ReturnType<typeof textResult>> {
  const { env, tokenIn, tokenOut, amountIn, slippageTolerance, userId } = input;
  if (env.MONAD_NETWORK !== 'mainnet') throw new Error('The 0x adapter is mainnet-only.');
  const tokenInAddress = resolveMainnetToken(tokenIn, 'tokenIn');
  const tokenOutAddress = resolveMainnetToken(tokenOut, 'tokenOut');
  if (tokenInAddress.toLowerCase() === tokenOutAddress.toLowerCase()) throw new Error('Input and output tokens must differ.');
  const inputIsNative = tokenInAddress.toLowerCase() === ZEROEX_NATIVE_TOKEN.toLowerCase();
  const outputIsNative = tokenOutAddress.toLowerCase() === ZEROEX_NATIVE_TOKEN.toLowerCase();

  const wallet = await resolveWallet(env, userId);
  const client = getPublicClient(env);
  const chainId = await client.getChainId();
  if (chainId !== 143) throw new Error(`Configured RPC returned chain ID ${chainId}; expected Monad mainnet (143). No transaction was sent.`);

  const [decInRaw, decOutRaw] = await Promise.all([
    inputIsNative ? Promise.resolve(18) : client.readContract({ address: tokenInAddress, abi: ERC20_ABI, functionName: 'decimals' }),
    outputIsNative ? Promise.resolve(18) : client.readContract({ address: tokenOutAddress, abi: ERC20_ABI, functionName: 'decimals' }),
  ]);
  const decIn = Number(decInRaw);
  const decOut = Number(decOutRaw);
  const amountInRaw = parseTokenAmount(amountIn, decIn);
  const [balance, inSymbol, outSymbol] = await Promise.all([
    inputIsNative ? client.getBalance({ address: wallet.address as `0x${string}` }) : client.readContract({ address: tokenInAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet.address as `0x${string}`] }),
    inputIsNative ? Promise.resolve('MON') : client.readContract({ address: tokenInAddress, abi: TOKEN_SYMBOL_ABI, functionName: 'symbol' }).catch(() => tokenInAddress),
    outputIsNative ? Promise.resolve('MON') : client.readContract({ address: tokenOutAddress, abi: TOKEN_SYMBOL_ABI, functionName: 'symbol' }).catch(() => tokenOutAddress),
  ]);
  if ((balance as bigint) < amountInRaw) throw new Error(`Insufficient ${String(inSymbol)} balance for this swap.`);

  const slippageBps = Math.round(slippageTolerance * 100);
  const firstQuote = await getZeroExSwapQuote(env, {
    sellToken: tokenInAddress,
    buyToken: tokenOutAddress,
    sellAmount: amountInRaw,
    taker: wallet.address as `0x${string}`,
    slippageBps,
  });
  if (firstQuote.issues?.simulationIncomplete) throw new Error('0x could not complete its quote simulation; refusing to prepare this swap.');
  const firstTransactionValue = BigInt(firstQuote.transaction.value ?? '0');
  if (inputIsNative ? firstTransactionValue !== amountInRaw : firstTransactionValue !== 0n) {
    throw new Error('The swap quote requested an unexpected amount of native MON; no swap was sent. Please request a fresh quote.');
  }

  const formatIn = formatTokenUnits(amountInRaw, decIn);
  const firstMin = BigInt(firstQuote.minBuyAmount);
  const quoteSummary = `${formatIn} ${String(inSymbol)} → about ${formatTokenUnits(BigInt(firstQuote.buyAmount), decOut)} ${String(outSymbol)}; minimum received ${formatTokenUnits(firstMin, decOut)} ${String(outSymbol)} at ${slippageTolerance}% slippage.`;

  // Every mainnet aggregator swap requires explicit human approval until mission-scoped
  // budgets can value arbitrary ERC-20 inputs in a trustworthy common unit.
  const gate = await approvalGate({
    action: 'defi_swap_tokens',
    details: {
      network: 'Monad mainnet',
      from: wallet.address,
      tokenIn: tokenInAddress,
      tokenInSymbol: String(inSymbol),
      amountIn: formatIn,
      tokenOut: tokenOutAddress,
      tokenOutSymbol: String(outSymbol),
      expectedOut: firstQuote.buyAmount,
      minimumOut: firstQuote.minBuyAmount,
      slippageTolerance,
    },
    valueWei: 0n,
    forceApproval: true,
    env,
    reason: `Monad mainnet swap: ${quoteSummary}`,
    userId,
  });
  if (gate.decision !== 'approved') {
    await auditLog({ tool: 'defi_swap_tokens', userId, result: 'rejected', params: { provider: '0x', tokenIn: tokenInAddress, tokenOut: tokenOutAddress, amountIn: formatIn } });
    return textResult({
      ok: false,
      approvalRequired: true,
      quote: { buyAmount: formatTokenUnits(BigInt(firstQuote.buyAmount), decOut), minimum: formatTokenUnits(firstMin, decOut), token: String(outSymbol) },
      summary: `${quoteSummary} The swap has not been sent. Complete Mochi’s approval request before it can proceed.`,
    });
  }

  const allowance = inputIsNative ? amountInRaw : (await client.readContract({
    address: tokenInAddress, abi: APPROVAL_ABI, functionName: 'allowance',
    args: [wallet.address as `0x${string}`, ZEROEX_ALLOWANCE_HOLDER],
  })) as bigint;
  let approveTxHash: `0x${string}` | null = null;
  const submitAllowance = async (amount: bigint): Promise<`0x${string}`> => {
    const approveData = encodeFunctionData({ abi: APPROVAL_ABI, functionName: 'approve', args: [ZEROEX_ALLOWANCE_HOLDER, amount] });
    const approvalSimulation = await simulateTx(env, { from: wallet.address, to: tokenInAddress, value: 0n, data: approveData });
    if (!approvalSimulation.ok) throw new Error(`Token approval simulation failed; nothing was broadcast: ${approvalSimulation.reason}`);
    const hash = await privySendTransaction(env, wallet, { to: tokenInAddress, value: 0n, data: approveData });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`Token approval transaction reverted: ${hash}`);
    return hash;
  };
  if (!inputIsNative && allowance !== amountInRaw) {
    // Replace any oversized standing allowance too. Reset first for tokens
    // that require zero-before-nonzero approval semantics.
    if (allowance > 0n) await submitAllowance(0n);
    approveTxHash = await submitAllowance(amountInRaw);
  }

  // The user may have taken minutes to approve. Requote and enforce the approved
  // minimum output so the signed-off economic terms cannot silently worsen.
  const quote = await getZeroExSwapQuote(env, {
    sellToken: tokenInAddress,
    buyToken: tokenOutAddress,
    sellAmount: amountInRaw,
    taker: wallet.address as `0x${string}`,
    slippageBps,
  });
  if (quote.issues?.simulationIncomplete) throw new Error('Fresh 0x quote could not be simulated; swap aborted.');
  if (BigInt(quote.minBuyAmount) < firstMin) {
    throw new Error('The executable quote now gives less than the human-approved minimum output. Swap aborted; request a fresh approval.');
  }
  const transactionValue = BigInt(quote.transaction.value ?? '0');
  if (inputIsNative ? transactionValue !== amountInRaw : transactionValue !== 0n) {
    throw new Error('The swap quote requested an unexpected amount of native MON; no swap was sent. Please request a fresh quote.');
  }

  const data = quote.transaction.data as `0x${string}`;
  const simulation = await simulateTx(env, { from: wallet.address, to: quote.transaction.to, value: transactionValue, data });
  if (!simulation.ok) throw new Error(`Swap simulation failed; no swap was broadcast: ${simulation.reason}`);
  const outputBefore = outputIsNative
    ? await client.getBalance({ address: wallet.address as `0x${string}` })
    : (await client.readContract({ address: tokenOutAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet.address as `0x${string}`] })) as bigint;
  const hash = await privySendTransaction(env, wallet, { to: quote.transaction.to as `0x${string}`, value: transactionValue, data });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Swap transaction reverted: ${hash}`);
  const outputAfter = outputIsNative
    ? await client.getBalance({ address: wallet.address as `0x${string}` })
    : (await client.readContract({ address: tokenOutAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet.address as `0x${string}`] })) as bigint;
  const gasPaid = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
  const received = outputIsNative
    ? (outputAfter + gasPaid >= outputBefore ? outputAfter + gasPaid - outputBefore : 0n)
    : (outputAfter >= outputBefore ? outputAfter - outputBefore : 0n);
  await auditLog({ tool: 'defi_swap_tokens', userId, result: 'ok', txHash: hash, params: { provider: '0x', network: 'mainnet', tokenIn: tokenInAddress, tokenOut: tokenOutAddress, amountIn: amountInRaw.toString(), minimumOut: quote.minBuyAmount, approveTxHash } });

  const receivedFormatted = formatTokenUnits(received, decOut);
  const minimumFormatted = formatTokenUnits(BigInt(quote.minBuyAmount), decOut);
  return textResult({
    ok: true,
    network: 'Monad mainnet',
    swapped: `${formatIn} ${String(inSymbol)}`,
    received: `${receivedFormatted} ${String(outSymbol)}`,
    minimumReceived: `${minimumFormatted} ${String(outSymbol)}`,
    estimatedNetworkFee: `${formatEther(simulation.feeWei)} MON`,
    explorerUrl: explorerTxUrl(env, hash),
    summary: `Swap complete: ${formatIn} ${String(inSymbol)} became ${receivedFormatted} ${String(outSymbol)} on Monad.`,
  });
}

export function registerDeFiTools(server: McpServer, env: Env): void {
  addTool(
    server,
    'defi_plan_monad_mission',
    'Build a read-only Monad token mission brief from Nansen market and flow data, Envio transfers, wallet exposure, and optionally a 0x quote. Never submits a transaction; use the separate approval-gated swap tool if you decide to trade.',
    {
      tokenAddress: z.string().optional().describe('Optional Monad token address to inspect. Omit to receive a short Nansen market screen for choosing a token.'),
      limit: z.number().int().min(1).max(10).default(5).describe('Number of market-screen candidates to return (1–10).'),
      sellTokenAddress: z.string().optional().describe('Optional ERC-20 token to quote selling for the selected token. Requires tokenAddress and sellAmount; use WMON rather than native MON.'),
      sellAmount: z.string().optional().describe('Optional exact input amount in human units, e.g. "2.5". Requires sellTokenAddress and tokenAddress.'),
      slippageTolerance: z.number().min(0.1).max(5).default(0.5).describe('Quote slippage in percent (0.1–5); used only for an indicative 0x quote.'),
      userId: z.string().optional().describe('Optional user/session id used to resolve the wallet for read-only exposure and quote context.'),
    },
    async ({ tokenAddress, limit, sellTokenAddress, sellAmount, slippageTolerance, userId }: {
      tokenAddress?: string; limit: number; sellTokenAddress?: string; sellAmount?: string; slippageTolerance: number; userId?: string;
    }) => {
      try {
        if (env.MONAD_NETWORK !== 'mainnet') throw new Error('Mission Planner is mainnet-only. Set MONAD_NETWORK=mainnet.');
        if (tokenAddress) assertAddress(tokenAddress, 'tokenAddress');
        if (sellTokenAddress) assertAddress(sellTokenAddress, 'sellTokenAddress');
        if (Boolean(sellTokenAddress) !== Boolean(sellAmount)) throw new Error('Provide both sellTokenAddress and sellAmount to request a quote.');
        if ((sellTokenAddress || sellAmount) && !tokenAddress) throw new Error('Choose tokenAddress before requesting a quote.');

        const client = getPublicClient(env);
        const chainId = await client.getChainId();
        if (chainId !== 143) throw new Error(`Configured RPC returned chain ID ${chainId}; expected Monad mainnet (143).`);

        const sourceStatus: Record<string, string> = {};
        let marketTokens: Awaited<ReturnType<typeof fetchMonadTokenScreen>> = [];
        try {
          marketTokens = await fetchMonadTokenScreen(env, limit);
          sourceStatus.nansenMarket = 'available';
        } catch (error) {
          sourceStatus.nansenMarket = error instanceof Error ? error.message : String(error);
        }

        let selectedToken: Record<string, unknown> | null = null;
        let transferActivity: Record<string, unknown> | null = null;
        let walletExposure: Record<string, unknown> | null = null;
        let flowIntelligence: Record<string, unknown> | null = null;
        let quoteSummary: Record<string, unknown> | null = null;
        let walletAddress: string | null = null;

        if (!tokenAddress) {
          const addresses = marketTokens.map((token) => token.token_address);
          if (addresses.length && env.HYPERSYNC_TOKEN && env.HYPERSYNC_URL.includes('monad') && !env.HYPERSYNC_URL.toLowerCase().includes('testnet')) {
            try {
              const toBlock = Number(await client.getBlockNumber());
              const fromBlock = Math.max(0, toBlock - 2000);
              const scan = await hyperSyncLogs(env, { address: addresses, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'], fromBlock, toBlock });
              if (scan) {
                const counts: Record<string, number> = {};
                for (const log of scan.logs) counts[log.address.toLowerCase()] = (counts[log.address.toLowerCase()] ?? 0) + 1;
                transferActivity = { provider: 'Envio HyperSync', fromBlock, toBlock, complete: scan.nextBlock >= toBlock, counts };
                sourceStatus.envio = 'available';
              } else sourceStatus.envio = 'unavailable';
            } catch (error) { sourceStatus.envio = error instanceof Error ? error.message : String(error); }
          } else sourceStatus.envio = 'unavailable (configure Monad mainnet HyperSync URL and token)';
        } else {
          selectedToken = { address: tokenAddress, marketScreen: marketTokens.find((token) => token.token_address.toLowerCase() === tokenAddress.toLowerCase()) ?? null };
          try {
            const flow = await fetchMonadTokenFlows(env, tokenAddress);
            flowIntelligence = { timeframe: '1d', metrics: flow.metrics, warnings: flow.warnings };
            sourceStatus.nansenFlows = 'available';
          } catch (error) { sourceStatus.nansenFlows = error instanceof Error ? error.message : String(error); }

          if (env.HYPERSYNC_TOKEN && env.HYPERSYNC_URL.includes('monad') && !env.HYPERSYNC_URL.toLowerCase().includes('testnet')) {
            try {
              const toBlock = Number(await client.getBlockNumber());
              const fromBlock = Math.max(0, toBlock - 2000);
              const scan = await hyperSyncLogs(env, { address: tokenAddress, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'], fromBlock, toBlock });
              if (scan) {
                transferActivity = { provider: 'Envio HyperSync', fromBlock, toBlock, complete: scan.nextBlock >= toBlock, transferEvents: scan.logs.length };
                sourceStatus.envio = 'available';
              } else sourceStatus.envio = 'unavailable';
            } catch (error) { sourceStatus.envio = error instanceof Error ? error.message : String(error); }
          } else sourceStatus.envio = 'unavailable (configure Monad mainnet HyperSync URL and token)';

          try {
            const wallet = await resolveWallet(env, userId);
            walletAddress = wallet.address;
            const address = tokenAddress as `0x${string}`;
            const [balance, decimalsRaw, symbol] = await Promise.all([
              client.readContract({ address, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet.address as `0x${string}`] }) as Promise<bigint>,
              client.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }) as Promise<number>,
              client.readContract({ address, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => address),
            ]);
            const decimals = Number(decimalsRaw);
            walletExposure = { address: wallet.address, onchainBalance: formatTokenUnits(balance, decimals), symbol: String(symbol) };
            sourceStatus.walletBalance = 'available (Monad RPC)';
            try {
              const position = await fetchZerionMonadTokenPosition(env, wallet.address, tokenAddress);
              walletExposure.zerion = position;
              sourceStatus.zerion = env.ZERION_API_KEY ? (position ? 'position found' : 'no indexed position or unavailable') : 'unconfigured';
            } catch (error) { sourceStatus.zerion = error instanceof Error ? error.message : String(error); }
          } catch (error) {
            sourceStatus.walletBalance = error instanceof Error ? error.message : String(error);
          }

          if (sellTokenAddress && sellAmount && walletAddress) {
            try {
              const sellToken = sellTokenAddress as `0x${string}`;
              const buyToken = tokenAddress as `0x${string}`;
              if (sellToken.toLowerCase() === buyToken.toLowerCase()) throw new Error('Sell and buy token addresses must differ.');
              const [sellDecimalsRaw, buyDecimalsRaw, sellSymbol, buySymbol] = await Promise.all([
                client.readContract({ address: sellToken, abi: ERC20_ABI, functionName: 'decimals' }),
                client.readContract({ address: buyToken, abi: ERC20_ABI, functionName: 'decimals' }),
                client.readContract({ address: sellToken, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => sellToken),
                client.readContract({ address: buyToken, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => buyToken),
              ]);
              const sellDecimals = Number(sellDecimalsRaw);
              const buyDecimals = Number(buyDecimalsRaw);
              const sellAmountRaw = parseTokenAmount(sellAmount, sellDecimals);
              const quote = await getZeroExSwapQuote(env, {
                sellToken, buyToken, sellAmount: sellAmountRaw,
                taker: walletAddress as `0x${string}`,
                slippageBps: Math.round(slippageTolerance * 100),
              });
              quoteSummary = {
                provider: '0x Swap API',
                sell: { address: sellToken, symbol: String(sellSymbol), amount: formatTokenUnits(sellAmountRaw, sellDecimals) },
                buy: { address: buyToken, symbol: String(buySymbol), expected: formatTokenUnits(BigInt(quote.buyAmount), buyDecimals), minimum: formatTokenUnits(BigInt(quote.minBuyAmount), buyDecimals) },
                slippageTolerancePercent: slippageTolerance,
                routeSources: [...new Set((quote.route?.fills ?? []).map((fill) => fill.source).filter((source): source is string => Boolean(source)))],
                liquidityAvailable: quote.liquidityAvailable,
                transactionSubmitted: false,
              };
              sourceStatus.zeroExQuote = 'available';
            } catch (error) { sourceStatus.zeroExQuote = error instanceof Error ? error.message : String(error); }
          } else if (sellTokenAddress && sellAmount) sourceStatus.zeroExQuote = 'unavailable (initialize or select a wallet first)';
        }

        const tokens = marketTokens.map((token) => ({
          ...token,
          transferEventsInWindow: transferActivity && 'counts' in transferActivity
            ? (transferActivity.counts as Record<string, number>)[token.token_address.toLowerCase()] ?? 0
            : null,
        }));
        return textResult({
          ok: true,
          mode: tokenAddress ? 'token-mission' : 'market-discovery',
          network: 'Monad mainnet (143)',
          retrievedAt: new Date().toISOString(),
          sources: sourceStatus,
          marketScreen: { timeframe: '24h', tokens },
          selectedToken,
          flowIntelligence,
          transferActivity,
          walletExposure,
          indicativeQuote: quoteSummary,
          nextAction: quoteSummary ? 'Review this indicative quote. If you choose to trade, call defi_swap_tokens separately; its mainnet flow requires human approval.' : tokenAddress ? 'Review the token data. To compare a swap, provide sellTokenAddress and sellAmount; no trade will be sent by this planner.' : 'Choose a tokenAddress from the screen to inspect its holder flows, wallet exposure, and recent transfers.',
          note: 'This is research context, not a recommendation. Nansen and Zerion may not cover every token. HyperSync transfer counts cover at most 2,000 recent blocks. 0x quote data is indicative and this tool never returns executable calldata or submits transactions.',
        });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  addTool(
    server,
    'defi_monad_market_brief',
    'Read a 24-hour Nansen token screen for Monad and cross-check recent ERC-20 transfer activity with Envio HyperSync. Read-only; it does not trade or provide financial advice.',
    { limit: z.number().int().min(1).max(10).default(5).describe('Maximum tokens to include (1–10).') },
    async ({ limit }: { limit: number }) => {
      try {
        if (env.MONAD_NETWORK !== 'mainnet') throw new Error('Monad market brief is mainnet-only. Set MONAD_NETWORK=mainnet.');
        const tokens = await fetchMonadTokenScreen(env, limit);
        const client = getPublicClient(env);
        const chainId = await client.getChainId();
        if (chainId !== 143) throw new Error(`Configured RPC returned chain ID ${chainId}; expected Monad mainnet (143).`);

        let activity: { provider: string; fromBlock: number; toBlock: number; complete: boolean; transferCounts: Record<string, number> } | null = null;
        if (tokens.length > 0 && env.HYPERSYNC_TOKEN && env.HYPERSYNC_URL.includes('monad') && !env.HYPERSYNC_URL.toLowerCase().includes('testnet')) {
          const toBlock = Number(await client.getBlockNumber());
          const fromBlock = Math.max(0, toBlock - 2000);
          const scan = await hyperSyncLogs(env, {
            address: tokens.map((token) => token.token_address),
            topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
            fromBlock,
            toBlock,
          });
          if (scan) {
            const counts: Record<string, number> = {};
            for (const log of scan.logs) {
              const address = log.address.toLowerCase();
              counts[address] = (counts[address] ?? 0) + 1;
            }
            activity = { provider: 'Envio HyperSync', fromBlock, toBlock, complete: scan.nextBlock >= toBlock, transferCounts: counts };
          }
        }
        return textResult({
          ok: true,
          network: 'Monad mainnet (143)',
          timeframe: '24h',
          retrievedAt: new Date().toISOString(),
          sources: { market: 'Nansen Token Screener', onchainActivity: activity ? 'Envio HyperSync' : 'unavailable (configure a Monad mainnet HYPERSYNC_URL and HYPERSYNC_TOKEN)' },
          activityWindow: activity ? { fromBlock: activity.fromBlock, toBlock: activity.toBlock, complete: activity.complete } : null,
          tokens: tokens.map((token) => ({
            ...token,
            transferEventsInWindow: activity?.transferCounts[token.token_address.toLowerCase()] ?? null,
          })),
          note: 'Metrics are provider data, not a recommendation. Envio counts cover the returned ERC-20 Transfer logs in a scan of at most 2,000 recent blocks; null means the source was unavailable.',
        });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  addTool(
    server,
    'defi_get_token_price',
    'Get a token price: MicroSwap pool quote on testnet, on-chain DEX quote with routerAddress, Zerion, else honest unknown.',
    {
      tokenAddress: z.string().optional().describe('Token contract address (0x...)'),
      symbol: z.string().optional().describe('Symbol label, e.g. "TTA"'),
      routerAddress: z.string().optional().describe('DEX router/pool for on-chain quotes'),
    },
    async ({ tokenAddress, symbol, routerAddress }: { tokenAddress?: string; symbol?: string; routerAddress?: string }) => {
      try {
        if (!tokenAddress && !symbol) throw new Error('Provide tokenAddress and/or symbol.');
        if (tokenAddress) assertAddress(tokenAddress, 'token');
        const wmon = NETWORK_META[env.MONAD_NETWORK].wmon;
        const dex = getDexConfig(env);
        const router = (routerAddress ?? dex.router ?? undefined) as `0x${string}` | undefined;

        // 1) MicroSwap pool quote for mock pairs (1 unit in -> counterpart out).
        if (tokenAddress && router && dex.kind === 'microswap') {
          const mock = resolveMockToken(env, tokenAddress);
          if (mock) {
            const other = dex.mockTokens.find((t) => t.address !== mock.address);
            if (other) {
              try {
                const client = getPublicClient(env);
                const unit = 10n ** BigInt(mock.decimals);
                const amounts = (await client.readContract({
                  address: router,
                  abi: ROUTER_ABI,
                  functionName: 'getAmountsOut',
                  args: [unit, [mock.address, other.address]],
                })) as bigint[];
                const out = amounts[amounts.length - 1];
                const outStr = formatTokenUnits(out, other.decimals);
                return textResult({
                  ok: true,
                  source: 'microswap-pool',
                  token: tokenAddress,
                  symbol: mock.symbol,
                  priceInCounterpart: outStr,
                  priceInCounterpartRaw: out.toString(),
                  counterpart: other.symbol,
                  summary: `1 ${mock.symbol} ≈ ${outStr} ${other.symbol} (MicroSwap pool quote).`,
                });
              } catch {
                /* fall through */
              }
            }
          }
        }
        // 2) Generic on-chain quote: 1 token -> WMON via router.
        if (tokenAddress && router) {
          try {
            const client = getPublicClient(env);
            const decimals = Number((await client.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18)) as number);
            const unit = 10n ** BigInt(decimals);
            const amounts = (await client.readContract({
              address: router,
              abi: ROUTER_ABI,
              functionName: 'getAmountsOut',
              args: [unit, [tokenAddress as `0x${string}`, wmon as `0x${string}`]],
            })) as bigint[];
            const outMon = formatEther(amounts[amounts.length - 1]);
            return textResult({ ok: true, source: 'dex-quote', token: tokenAddress, priceMON: outMon, summary: `${symbol ?? tokenAddress} ≈ ${outMon} MON (on-chain quote, 1 unit).` });
          } catch {
            /* fall through */
          }
        }
        // 3) Zerion
        if (tokenAddress) {
          const usd = await zerionPrice(env, tokenAddress);
          if (usd !== null) {
            return textResult({ ok: true, source: 'zerion', token: tokenAddress, priceUSD: usd, summary: `${symbol ?? tokenAddress} ≈ $${usd} (Zerion).` });
          }
        }
        // 4) WMON identity
        if (symbol === 'WMON' || symbol === 'MON' || tokenAddress === wmon) {
          return textResult({ ok: true, source: 'identity', priceMON: '1', summary: 'WMON/MON is the native asset: 1 WMON = 1 MON.' });
        }
        return textResult({
          ok: true,
          source: 'unknown',
          token: tokenAddress ?? symbol,
          priceMON: null,
          summary: `No price source available for ${symbol ?? tokenAddress}. Set ZERION_API_KEY or pass routerAddress for an on-chain quote.`,
        });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  addTool(
    server,
    'defi_faucet_mint',
    'Mint testnet mock tokens (TTA/TTB) to a wallet. Open mint, zero value, testnet only.',
    {
      token: z.string().describe('Mock token symbol (TTA/TTB) or contract address'),
      amount: z.string().describe('Human-readable amount, e.g. "10"'),
      to: z.string().optional().describe('Recipient. Defaults to the agent wallet.'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ token, amount, to, userId }: { token: string; amount: string; to?: string; userId?: string }) => {
      try {
        if (env.MONAD_NETWORK !== 'testnet') throw new Error('Mock faucet is testnet-only.');
        const mock = resolveMockToken(env, token);
        if (!mock) throw new Error(`Unknown mock token "${token}". Available: ${getDexConfig(env).mockTokens.map((t) => t.symbol).join(', ')}.`);
        let recipient = to;
        if (!recipient) recipient = (await resolveWallet(env, userId)).address;
        assertAddress(recipient, 'recipient');
        const raw = parseTokenAmount(amount, mock.decimals);
        const wallet = await resolveWallet(env, userId);
        const data = encodeFunctionData({ abi: MINT_ABI, functionName: 'mint', args: [recipient as `0x${string}`, raw] });
        const hash = await privySendTransaction(env, wallet, { to: mock.address, value: 0n, data });
        const receipt = await getPublicClient(env).waitForTransactionReceipt({ hash });
        await auditLog({ tool: 'defi_faucet_mint', userId, result: 'ok', txHash: hash, params: { token: mock.symbol, amount, to: recipient } });
        return textResult({
          ok: true,
          txHash: hash,
          explorerUrl: explorerTxUrl(env, hash),
          token: mock.symbol,
          tokenAddress: mock.address,
          amount,
          to: recipient,
          blockNumber: receipt.blockNumber.toString(),
          summary: `Minted ${amount} ${mock.symbol} to ${recipient}. Tx ${hash}. View: ${explorerTxUrl(env, hash)}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'defi_faucet_mint', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg });
      }
    },
  );

  addTool(
    server,
    'defi_swap_tokens',
    'Swap tokens on Monad mainnet through Mochi’s automatic verified 0x route with mandatory human approval and transaction simulation; accepts MON, WMON, USDC, AUSD, or token addresses. MON means native MON and WMON means wrapped MON. On testnet, use the configured demo router.',
    {
      tokenIn: z.string().describe('Input asset: MON (native), WMON (wrapped), USDC, AUSD, or a token address. MON and WMON are different assets.'),
      tokenOut: z.string().describe('Output asset: MON (native), WMON (wrapped), USDC, AUSD, or a token address.'),
      amountIn: z.string().describe('Human-readable input amount, e.g. "1"'),
      slippageTolerance: z.number().min(0).max(50).default(0.5).describe('Max slippage % (default 0.5)'),
      routerAddress: z.string().optional().describe('Testnet-only router override; Mochi selects its verified route automatically on mainnet.'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ tokenIn, tokenOut, amountIn, slippageTolerance, routerAddress, userId }: { tokenIn: string; tokenOut: string; amountIn: string; slippageTolerance: number; routerAddress?: string; userId?: string }) => {
      try {
        if (env.MONAD_NETWORK === 'mainnet') {
          if (routerAddress) throw new Error('Mochi selects a verified route automatically on mainnet.');
          return await executeMainnetZeroExSwap({ env, tokenIn, tokenOut, amountIn, slippageTolerance, userId });
        }
        const dex = getDexConfig(env);
        // Accept mock symbols for convenience.
        const inMock = resolveMockToken(env, tokenIn);
        const outMock = resolveMockToken(env, tokenOut);
        const inAddr = (inMock ? inMock.address : tokenIn) as `0x${string}`;
        const outAddr = (outMock ? outMock.address : tokenOut) as `0x${string}`;
        assertAddress(inAddr, 'tokenIn');
        assertAddress(outAddr, 'tokenOut');
        if (routerAddress) assertAddress(routerAddress, 'router');
        const router = (routerAddress ?? dex.router ?? undefined) as `0x${string}` | undefined;

        const wallet = await resolveWallet(env, userId);
        const client = getPublicClient(env);
        const decIn = Number((await client.readContract({ address: inAddr, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18)) as number);
        const decOut = Number((await client.readContract({ address: outAddr, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18)) as number);
        const amountInRaw = parseTokenAmount(amountIn, decIn);

        let quoteOut: bigint | null = null;
        if (router) {
          try {
            const amounts = (await client.readContract({
              address: router,
              abi: ROUTER_ABI,
              functionName: 'getAmountsOut',
              args: [amountInRaw, [inAddr, outAddr]],
            })) as bigint[];
            quoteOut = amounts[amounts.length - 1];
          } catch {
            quoteOut = null;
          }
        }

        const inLabel = inMock?.symbol ?? inAddr;
        const outLabel = outMock?.symbol ?? outAddr;
        const quoteText =
          quoteOut !== null
            ? `Quote: ${amountIn} ${inLabel} → ~${formatTokenUnits(quoteOut, decOut)} ${outLabel} @ ${slippageTolerance}% slippage.`
            : 'No on-chain quote available (no router configured). Execution requires routerAddress.';

        const needsHuman = !router || quoteOut === null;
        const gate = await approvalGate({
          action: 'defi_swap_tokens',
          details: {
            from: wallet.address,
            tokenIn: inAddr,
            tokenOut: outAddr,
            amountIn,
            quoteOut: quoteOut?.toString() ?? null,
            slippageTolerance,
            router: router ?? null,
          },
          valueWei: 0n,
          env,
          forceApproval: needsHuman,
          reason: `Swap ${amountIn} ${inLabel} → ${outLabel}`,
          userId,
        });
        if (gate.decision !== 'approved') {
          await auditLog({ tool: 'defi_swap_tokens', userId, result: 'rejected', params: { tokenIn: inAddr, tokenOut: outAddr, amountIn } });
          return textResult({ ok: false, approvalRequired: true, requestId: gate.requestId, quote: quoteOut?.toString() ?? null, quoteFormatted: quoteOut !== null ? `${formatTokenUnits(quoteOut, decOut)} ${outLabel}` : null, summary: `${quoteText} ${gate.message} Approve in the dashboard to execute.` });
        }

        if (!router) {
          return textResult({
            ok: false,
            approved: true,
            quote: quoteOut?.toString() ?? null,
            summary: `${quoteText} Approved, but no DEX router is configured. Pass routerAddress to execute, or run the swap via contract_write.`,
          });
        }

        // 1) Ensure allowance (approve exact amount if insufficient).
        let approveHash: string | null = null;
        const allowance = (await client.readContract({
          address: inAddr,
          abi: ALLOWANCE_ABI,
          functionName: 'allowance',
          args: [wallet.address as `0x${string}`, router],
        }).catch(() => 0n)) as bigint;
        if (allowance < amountInRaw) {
          const approveData = encodeFunctionData({ abi: ALLOWANCE_ABI, functionName: 'approve', args: [router, amountInRaw] });
          approveHash = await privySendTransaction(env, wallet, { to: inAddr, value: 0n, data: approveData });
          await client.waitForTransactionReceipt({ hash: approveHash as `0x${string}` });
        }

        // 2) Execute the swap (pre-flight first — allowance is on-chain by now).
        const minOut = quoteOut !== null ? (quoteOut * BigInt(Math.floor((100 - slippageTolerance) * 100))) / 10000n : 0n;
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
        const swapData = encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: 'swapExactTokensForTokens',
          args: [amountInRaw, minOut, [inAddr, outAddr], wallet.address as `0x${string}`, deadline],
        });
        const sim = await simulateTx(env, { from: wallet.address, to: router, value: 0n, data: swapData });
        if (!sim.ok) {
          await auditLog({ tool: 'defi_swap_tokens', userId, result: 'error', error: `simulation: ${sim.reason}`, params: { tokenIn: inAddr, tokenOut: outAddr, amountIn } });
          return textResult({
            ok: false,
            approved: true,
            approveTxHash: approveHash,
            error: `Approved, but pre-flight simulation failed — swap aborted before broadcast: ${sim.reason}`,
            summary: `Not sending the swap: it would fail on-chain (${sim.reason}). Allowance tx ${approveHash ?? 'n/a'} already mined. No swap broadcast.`,
          });
        }
        const hash = await privySendTransaction(env, wallet, { to: router, value: 0n, data: swapData });
        const receipt = await client.waitForTransactionReceipt({ hash });
        await auditLog({ tool: 'defi_swap_tokens', userId, result: 'ok', txHash: hash, params: { tokenIn: inAddr, tokenOut: outAddr, amountIn } });
        return textResult({
          ok: true,
          txHash: hash,
          explorerUrl: explorerTxUrl(env, hash),
          poolUrl: explorerAddressUrl(env, router),
          amountIn: `${amountIn} ${inLabel}`,
          quoteOut: quoteOut?.toString() ?? null,
          quoteOutFormatted: quoteOut !== null ? `${formatTokenUnits(quoteOut, decOut)} ${outLabel}` : null,
          minOut: minOut.toString(),
          minOutFormatted: `${formatTokenUnits(minOut, decOut)} ${outLabel}`,
          approveTxHash: approveHash,
          approveExplorerUrl: approveHash ? explorerTxUrl(env, approveHash) : null,
          simulatedFeeMON: formatEther(sim.feeWei),
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          summary: `Swapped ${amountIn} ${inLabel} → ${outLabel}${approveHash ? ` (auto-approved router first: ${approveHash})` : ''}. ${quoteText} Tx ${hash} in block ${receipt.blockNumber}. View: ${explorerTxUrl(env, hash)}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'defi_swap_tokens', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg });
      }
    },
  );
}
