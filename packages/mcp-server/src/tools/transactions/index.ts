import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { encodeFunctionData, formatEther, formatGwei, parseEther } from 'viem';
import type { Env } from '../../config/env.js';
import { explorerTxUrl, getPublicClient } from '../../config/monad.js';
import { privySendTransaction } from '../../config/privy.js';
import { approvalGate } from '../../middleware/approval-gate.js';
import { auditLog } from '../../middleware/audit-log.js';
import { spendingPolicyMessage } from '../../middleware/spending-policy.js';
import { ERC20_ABI, addTool, assertAddress, resolveWallet, textResult } from '../shared.js';
import { hyperRpcReceipt } from '../../config/hyperrpc.js';
import { simulateTx } from '../../middleware/simulate.js';
import { resolveRecipient } from '../../config/contacts.js';

export function registerTransactionTools(server: McpServer, env: Env): void {
  addTool(
    server,
    'transaction_send_mon',
    'Send MON to an address. Values at/above SPENDING_LIMIT_WEI pause for human approval in the dashboard.',
    {
      to: z.string().describe('Recipient address (0x...) or saved contact name, e.g. "sam"'),
      amount: z.string().describe('Amount in MON (e.g. "1.5")'),
      reason: z.string().optional().describe('Why this transaction is being sent'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ to, amount, reason, userId }: { to: string; amount: string; reason?: string; userId?: string }) => {
      try {
        const toAddr = await resolveRecipient(userId, to);
        let valueWei: bigint;
        try {
          valueWei = parseEther(amount);
        } catch {
          throw new Error(`Invalid amount "${amount}". Use a decimal MON string like "0.1".`);
        }
        if (valueWei <= 0n) throw new Error('Amount must be greater than 0.');
        const wallet = await resolveWallet(env, userId);

        await auditLog({ tool: 'transaction_send_mon', userId, intent: reason ?? `send ${amount} MON to ${to}`, params: { to, amount }, result: 'ok' });

        const gate = await approvalGate({
          action: 'transaction_send_mon',
          details: { from: wallet.address, to, amountMON: amount, reason: reason ?? null },
          valueWei,
          env,
          reason,
          userId,
        });

        if (gate.decision !== 'approved') {
          await auditLog({ tool: 'transaction_send_mon', userId, result: 'rejected', params: { to, amount, requestId: gate.requestId } });
          return textResult({
            ok: false,
            approvalRequired: true,
            requestId: gate.requestId,
            summary: `This transaction requires your approval because it meets/exceeds the spending limit. ${gate.message} Please check the Mochi dashboard to approve or reject. Details: send ${amount} MON to ${to}. Policy: ${spendingPolicyMessage(valueWei, env)}`,
          });
        }

        const t0 = Date.now();
        const hash = await privySendTransaction(env, wallet, { to: toAddr, value: valueWei });
        const client = getPublicClient(env);
        const receipt = await client.waitForTransactionReceipt({ hash });
        const elapsed = Date.now() - t0;

        await auditLog({ tool: 'transaction_send_mon', userId, result: 'ok', txHash: hash, params: { to, amount } });
        return textResult({
          ok: true,
          txHash: hash,
          explorerUrl: explorerTxUrl(env, hash),
          from: wallet.address,
          to,
          toResolved: toAddr,
          amountMON: amount,
          valueWei: valueWei.toString(),
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          status: receipt.status,
          confirmationMs: elapsed,
          autoApproved: gate.autoApproved,
          summary: `Sent ${amount} MON to ${to}. Tx ${hash} confirmed in block ${receipt.blockNumber} (~${elapsed}ms). View: ${explorerTxUrl(env, hash)}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'transaction_send_mon', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg, summary: `Transaction failed: ${msg}` });
      }
    },
  );

  addTool(
    server,
    'transaction_send_token',
    'Send any ERC20 token. Goes through the same approval gate as MON transfers.',
    {
      tokenAddress: z.string().describe('ERC20 contract address (0x...)'),
      to: z.string().describe('Recipient address (0x...) or saved contact name'),
      amount: z.string().describe('Human-readable amount, e.g. "25.5"'),
      tokenSymbol: z.string().optional().describe('Token symbol label for display'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ tokenAddress, to, amount, tokenSymbol, userId }: { tokenAddress: string; to: string; amount: string; tokenSymbol?: string; userId?: string }) => {
      try {
        assertAddress(tokenAddress, 'token');
        const toAddr = await resolveRecipient(userId, to);
        const wallet = await resolveWallet(env, userId);
        const client = getPublicClient(env);
        const decimals = (await client.readContract({ address: tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18)) as number;
        const d = Number(decimals);
        const [whole, frac = ''] = amount.split('.');
        if (!/^\d+$/.test(whole) || (frac && !/^\d+$/.test(frac))) throw new Error(`Invalid amount "${amount}".`);
        const raw = BigInt(whole) * 10n ** BigInt(d) + BigInt((frac + '0'.repeat(d)).slice(0, d) || '0');
        if (raw <= 0n) throw new Error('Amount must be greater than 0.');

        const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [toAddr, raw] });

        const gate = await approvalGate({
          action: 'transaction_send_token',
          details: { from: wallet.address, token: tokenAddress, to, amount, symbol: tokenSymbol ?? null },
          valueWei: 0n,
          env,
          forceApproval: true,
          reason: `Send ${amount} ${tokenSymbol ?? 'tokens'} to ${to}`,
          userId,
        });
        if (gate.decision !== 'approved') {
          await auditLog({ tool: 'transaction_send_token', userId, result: 'rejected', params: { tokenAddress, to, amount } });
          return textResult({
            ok: false,
            approvalRequired: true,
            requestId: gate.requestId,
            summary: `Token transfer needs approval. ${gate.message} Please approve in the dashboard: send ${amount} ${tokenSymbol ?? ''} to ${to}.`,
          });
        }

        const hash = await privySendTransaction(env, wallet, { to: tokenAddress as `0x${string}`, value: 0n, data });
        const receipt = await client.waitForTransactionReceipt({ hash });
        await auditLog({ tool: 'transaction_send_token', userId, result: 'ok', txHash: hash, params: { tokenAddress, to, amount } });
        return textResult({
          ok: true,
          txHash: hash,
          explorerUrl: explorerTxUrl(env, hash),
          token: tokenAddress,
          to,
          toResolved: toAddr,
          amount,
          rawAmount: raw.toString(),
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          summary: `Sent ${amount} ${tokenSymbol ?? 'tokens'} to ${to}. Tx ${hash}. View: ${explorerTxUrl(env, hash)}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'transaction_send_token', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg });
      }
    },
  );

  addTool(
    server,
    'transaction_estimate_gas',
    'Estimate gas cost before executing a transaction. Returns gas units, gas price and total in MON.',
    {
      to: z.string().describe('Target address (0x...) or saved contact name'),
      amount: z.string().optional().describe('Value in MON, e.g. "0.1"'),
      data: z.string().optional().describe('Calldata (0x...)'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ to, amount, data, userId }: { to: string; amount?: string; data?: string; userId?: string }) => {
      try {
        const target = await resolveRecipient(userId, to).catch(() => null);
        const toAddr = target ?? (/^0x[0-9a-fA-F]{40}$/.test(to) ? (to as `0x${string}`) : null);
        if (!toAddr) throw new Error(`Unknown target "${to}" — not an address or saved contact.`);
        const wallet = await resolveWallet(env, userId).catch(() => null);
        const client = getPublicClient(env);
        const valueWei = amount ? parseEther(amount) : 0n;
        const gas = await client.estimateGas({
          account: (wallet?.address ?? toAddr) as `0x${string}`,
          to: toAddr,
          value: valueWei,
          ...(data ? { data: data as `0x${string}` } : {}),
        });
        const gasPrice = await client.getGasPrice();
        const totalWei = gas * gasPrice;
        return textResult({
          ok: true,
          to,
          estimatedGasUnits: gas.toString(),
          gasPriceWei: gasPrice.toString(),
          gasPriceGwei: formatGwei(gasPrice),
          totalCostWei: totalWei.toString(),
          totalCostMON: formatEther(totalWei),
          summary: `Estimate: ${gas.toString()} gas @ ${formatGwei(gasPrice)} gwei ≈ ${formatEther(totalWei)} MON.`,
        });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  addTool(
    server,
    'transaction_simulate',
    'Dry-run any transaction before signing: detects reverts with reasons, estimates gas, and checks the wallet covers value + fees. Read-only, never broadcasts.',
    {
      to: z.string().describe('Target address (0x...) or saved contact name'),
      amount: z.string().optional().describe('MON value, e.g. "0.5". Defaults to 0.'),
      data: z.string().optional().describe('Calldata (0x...). Omit for plain transfers.'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ to, amount, data, userId }: { to: string; amount?: string; data?: string; userId?: string }) => {
      try {
        assertAddress(to, 'target');
        const wallet = await resolveWallet(env, userId);
        const valueWei = amount ? parseEther(amount) : 0n;
        const sim = await simulateTx(env, {
          from: wallet.address,
          to,
          value: valueWei,
          ...(data ? { data: data as `0x${string}` } : {}),
        });
        const totalNeeded = valueWei + sim.feeWei;
        await auditLog({ tool: 'transaction_simulate', userId, result: sim.ok ? 'ok' : 'error', params: { to, amount: amount ?? '0' }, error: sim.reason ?? undefined });
        return textResult({
          ok: true,
          verdict: sim.verdict,
          wouldSucceed: sim.callOk,
          revertReason: sim.callOk ? null : sim.reason,
          returnData: sim.returnData,
          gasUnits: sim.gasUnits,
          gasPriceGwei: sim.gasPriceGwei,
          feeMON: formatEther(sim.feeWei),
          valueMON: formatEther(valueWei),
          walletBalanceMON: formatEther(sim.balanceWei),
          affordable: sim.balanceWei >= totalNeeded,
          summary:
            sim.verdict === 'SAFE_TO_SEND'
              ? `Simulation passed: sends ${formatEther(valueWei)} MON to ${to}, fee ≈ ${formatEther(sim.feeWei)} MON, wallet holds ${formatEther(sim.balanceWei)} MON.`
              : `DO NOT SEND: ${sim.reason}.`,
        });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  registerStatusTool(server, env);
}

function registerStatusTool(server: McpServer, env: Env): void {
  addTool(
    server,
    'transaction_get_status',
    'Check status of a transaction by hash: pending/confirmed/failed, block, gas used, explorer link.',
    {
      txHash: z.string().describe('Transaction hash (0x...)'),
    },
    async ({ txHash }: { txHash: string }) => {
      try {
        if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error(`Invalid txHash "${txHash}".`);
        // Fast path: HyperRPC receipt (read-optimized, throttled).
        const fast = await hyperRpcReceipt(env, txHash).catch(() => null);
        if (fast && fast.blockNumber) {
          const okTx = fast.status === '0x1';
          return textResult({
            ok: true,
            status: okTx ? 'confirmed' : 'failed',
            source: 'hyperrpc',
            txHash,
            blockNumber: BigInt(fast.blockNumber).toString(),
            gasUsed: fast.gasUsed ? BigInt(fast.gasUsed).toString() : null,
            explorerUrl: explorerTxUrl(env, txHash),
            summary: `Transaction ${txHash} ${okTx ? 'confirmed' : 'FAILED'} in block ${BigInt(fast.blockNumber).toString()} (via HyperRPC). View: ${explorerTxUrl(env, txHash)}`,
          });
        }
        const client = getPublicClient(env);
        const [receipt, tx] = await Promise.all([
          client.getTransactionReceipt({ hash: txHash as `0x${string}` }).catch(() => null),
          client.getTransaction({ hash: txHash as `0x${string}` }).catch(() => null),
        ]);
        if (!receipt && !tx) {
          return textResult({ ok: true, status: 'not-found', txHash, summary: `Transaction ${txHash} not found (yet). It may still be propagating.` });
        }
        if (!receipt) {
          return textResult({
            ok: true,
            status: 'pending',
            txHash,
            explorerUrl: explorerTxUrl(env, txHash),
            summary: `Transaction ${txHash} is pending. View: ${explorerTxUrl(env, txHash)}`,
          });
        }
        return textResult({
          ok: true,
          status: receipt.status === 'success' ? 'confirmed' : 'failed',
          txHash,
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          explorerUrl: explorerTxUrl(env, txHash),
          summary: `Transaction ${txHash} ${receipt.status === 'success' ? 'confirmed' : 'FAILED'} in block ${receipt.blockNumber}. View: ${explorerTxUrl(env, txHash)}`,
        });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
