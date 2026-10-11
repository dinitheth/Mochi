import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { decodeFunctionData, formatEther } from 'viem';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import { explorerTxUrl, getPublicClient } from '../../config/monad.js';
import { privySendTransaction } from '../../config/privy.js';
import { approvalGate } from '../../middleware/approval-gate.js';
import { auditLog } from '../../middleware/audit-log.js';
import { simulateTx } from '../../middleware/simulate.js';
import { addTool, assertAddress, resolveWallet, textResult } from '../shared.js';
import { buildUniswapSwapTransaction, getUniswapApproval, getUniswapQuote, UNISWAP_APPROVAL_PROXY } from '../../integrations/uniswap.js';

const APPROVE_ABI = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const;
const ROUTERS = new Set([UNISWAP_APPROVAL_PROXY.toLowerCase(), '0xa6ce4f10d83dbddac17e68e1837ca9ce6a1b596e', '0x0d97dc33264bfc1c226207428a79b26757fb9dc3']);

function rawAmount(value: string, decimals: number): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`Invalid token amount "${value}".`);
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(`Amount has more than ${decimals} decimal places.`);
  const result = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (result <= 0n) throw new Error('Amount must be greater than zero.');
  return result;
}

function checkApprovalTransaction(tx: { to: `0x${string}`; data: `0x${string}` }, token: `0x${string}`, required: bigint, reset: boolean): void {
  if (tx.to.toLowerCase() !== token.toLowerCase()) throw new Error('Approval transaction targets a token other than the selected input token.');
  const decoded = decodeFunctionData({ abi: APPROVE_ABI, data: tx.data });
  const [spender, amount] = decoded.args;
  if (!ROUTERS.has(spender.toLowerCase())) throw new Error('Approval transaction spender is outside Uniswap’s verified Monad router allowlist.');
  if (reset ? amount !== 0n : amount !== required) throw new Error('Uniswap approval amount does not exactly match the requested input amount.');
}

export function registerUniswapTools(server: McpServer, env: Env): void {
  addTool(server, 'uniswap_quote_swap', 'Get a Monad mainnet Uniswap v4 exact-input swap quote. Read-only: no approval, signing, or transaction is performed.', {
    tokenIn: z.string().describe('Input ERC-20 address'),
    tokenOut: z.string().describe('Output ERC-20 address'),
    amountIn: z.string().describe('Human-readable exact input amount'),
    slippageTolerance: z.number().min(0).max(5).default(0.5),
    userId: z.string().optional(),
  }, async ({ tokenIn, tokenOut, amountIn, slippageTolerance, userId }: { tokenIn: string; tokenOut: string; amountIn: string; slippageTolerance: number; userId?: string }) => {
    try {
      if (env.MONAD_NETWORK !== 'mainnet') throw new Error('Uniswap quotes are currently enabled on Monad mainnet only.');
      assertAddress(tokenIn, 'tokenIn');
      assertAddress(tokenOut, 'tokenOut');
      const wallet = await resolveWallet(env, userId);
      const client = getPublicClient(env);
      const chainId = await client.getChainId();
      if (chainId !== 143) throw new Error(`Configured RPC returned chain ${chainId}; Uniswap requires Monad mainnet (143).`);
      const decimals = Number(await client.readContract({ address: tokenIn as `0x${string}`, abi: [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const, functionName: 'decimals' }));
      const quote = await getUniswapQuote(env, { tokenIn: tokenIn as `0x${string}`, tokenOut: tokenOut as `0x${string}`, amountIn: rawAmount(amountIn, decimals), swapper: wallet.address as `0x${string}`, slippageTolerance });
      return textResult({ ok: true, provider: 'Uniswap Trading API', protocol: 'Uniswap v4', chainId: 143, tokenIn, tokenOut, amountIn, outputAmountRaw: quote.outputAmount, minimumOutputRaw: quote.minimumOutputAmount, transactionTarget: quote.transaction.to, requestId: quote.requestId ?? null, summary: `Uniswap v4 quotes ${amountIn} input tokens for at least ${quote.minimumOutputAmount} output base units at ${slippageTolerance}% slippage. This is read-only; no transaction was sent.` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return textResult({ ok: false, error: message });
    }
  });

  addTool(server, 'uniswap_swap_tokens', 'Execute an exact-input Uniswap v4 Monad mainnet swap. Requires an explicit dashboard approval, validates Uniswap router targets, simulates each on-chain transaction, and enforces a minimum output.', {
    tokenIn: z.string().describe('Input ERC-20 address'),
    tokenOut: z.string().describe('Output ERC-20 address'),
    amountIn: z.string().describe('Human-readable exact input amount'),
    slippageTolerance: z.number().min(0).max(5).default(0.5),
    userId: z.string().optional(),
  }, async ({ tokenIn, tokenOut, amountIn, slippageTolerance, userId }: { tokenIn: string; tokenOut: string; amountIn: string; slippageTolerance: number; userId?: string }) => {
    let approvalHash: `0x${string}` | null = null;
    try {
      if (env.MONAD_NETWORK !== 'mainnet') throw new Error('Uniswap swaps are currently enabled on Monad mainnet only.');
      assertAddress(tokenIn, 'tokenIn');
      assertAddress(tokenOut, 'tokenOut');
      const wallet = await resolveWallet(env, userId);
      const client = getPublicClient(env);
      const chainId = await client.getChainId();
      if (chainId !== 143) throw new Error(`Configured RPC returned chain ${chainId}; Uniswap requires Monad mainnet (143).`);
      const inputToken = tokenIn as `0x${string}`;
      const outputToken = tokenOut as `0x${string}`;
      const decimals = Number(await client.readContract({ address: inputToken, abi: [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const, functionName: 'decimals' }));
      const amount = rawAmount(amountIn, decimals);
      const quote = await getUniswapQuote(env, { tokenIn: inputToken, tokenOut: outputToken, amountIn: amount, swapper: wallet.address as `0x${string}`, slippageTolerance });
      const approvals = await getUniswapApproval(env, { token: inputToken, tokenOut: outputToken, amount, wallet: wallet.address as `0x${string}` });
      if (approvals.cancel) checkApprovalTransaction(approvals.cancel, inputToken, amount, true);
      if (approvals.approval) checkApprovalTransaction(approvals.approval, inputToken, amount, false);
      const gate = await approvalGate({
        action: 'uniswap_swap_tokens',
        details: {
          from: wallet.address, tokenIn: inputToken, tokenOut: outputToken, amountIn,
          quotedOutputRaw: quote.outputAmount, minimumOutputRaw: quote.minimumOutputAmount,
          protocol: 'Uniswap v4', chainId: 143,
          approvalRequired: Boolean(approvals.approval), approvalResetRequired: Boolean(approvals.cancel),
          approvalSpender: approvals.approval ? UNISWAP_APPROVAL_PROXY : null,
        },
        valueWei: 0n, env, forceApproval: true,
        reason: `Swap ${amountIn} tokens through Uniswap v4 on Monad`, userId,
      });
      if (gate.decision !== 'approved') {
        await auditLog({ tool: 'uniswap_swap_tokens', userId, result: 'rejected', params: { tokenIn, tokenOut, amountIn } });
        return textResult({ ok: false, approvalRequired: true, requestId: gate.requestId, quote: { outputAmountRaw: quote.outputAmount, minimumOutputRaw: quote.minimumOutputAmount }, summary: `Review the Uniswap v4 swap and any required token approval in the dashboard. ${gate.message}` });
      }

      if (approvals.cancel) {
        const sim = await simulateTx(env, { from: wallet.address, to: approvals.cancel.to, value: 0n, data: approvals.cancel.data });
        if (!sim.ok) throw new Error(`Approval reset simulation failed: ${sim.reason}`);
        approvalHash = await privySendTransaction(env, wallet, { to: approvals.cancel.to, value: approvals.cancel.value, data: approvals.cancel.data });
        const receipt = await client.waitForTransactionReceipt({ hash: approvalHash });
        if (receipt.status !== 'success') throw new Error('Allowance reset transaction reverted.');
      }
      if (approvals.approval) {
        const sim = await simulateTx(env, { from: wallet.address, to: approvals.approval.to, value: 0n, data: approvals.approval.data });
        if (!sim.ok) throw new Error(`Token approval simulation failed: ${sim.reason}`);
        approvalHash = await privySendTransaction(env, wallet, { to: approvals.approval.to, value: approvals.approval.value, data: approvals.approval.data });
        const receipt = await client.waitForTransactionReceipt({ hash: approvalHash });
        if (receipt.status !== 'success') throw new Error('Token approval transaction reverted.');
      }

      const transaction = await buildUniswapSwapTransaction(env, quote, wallet.address as `0x${string}`);
      const simulation = await simulateTx(env, { from: wallet.address, to: transaction.to, value: transaction.value, data: transaction.data });
      if (!simulation.ok) throw new Error(`Swap simulation failed; swap was not broadcast: ${simulation.reason}`);
      const hash = await privySendTransaction(env, wallet, { to: transaction.to, value: transaction.value, data: transaction.data });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`Uniswap swap reverted: ${hash}`);
      await auditLog({ tool: 'uniswap_swap_tokens', userId, result: 'ok', txHash: hash, params: { tokenIn, tokenOut, amountIn, minimumOutputRaw: quote.minimumOutputAmount } });
      return textResult({ ok: true, txHash: hash, explorerUrl: explorerTxUrl(env, hash), approvalTxHash: approvalHash, protocol: 'Uniswap v4', chainId: 143, amountIn, quotedOutputRaw: quote.outputAmount, minimumOutputRaw: quote.minimumOutputAmount, simulatedFeeMON: formatEther(simulation.feeWei), blockNumber: receipt.blockNumber.toString(), summary: `Uniswap v4 swap confirmed in block ${receipt.blockNumber}. View: ${explorerTxUrl(env, hash)}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await auditLog({ tool: 'uniswap_swap_tokens', userId, result: 'error', error: message, params: { tokenIn, tokenOut, amountIn, approvalHash } });
      return textResult({ ok: false, approvalTxHash: approvalHash, error: message, summary: approvalHash ? `Swap did not complete. A token-approval transaction may already be confirmed (${approvalHash}); check its allowance before retrying.` : message });
    }
  });
}
