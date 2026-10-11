import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { encodeFunctionData, formatEther, parseEther } from 'viem';
import type { Env } from '../../config/env.js';
import { explorerAddressUrl, explorerTxUrl, getPublicClient } from '../../config/monad.js';
import { getLendingPool } from '../../config/lending.js';
import { privySendTransaction } from '../../config/privy.js';
import { approvalGate } from '../../middleware/approval-gate.js';
import { auditLog } from '../../middleware/audit-log.js';
import { simulateTx } from '../../middleware/simulate.js';
import { addTool, assertAddress, resolveWallet, textResult } from '../shared.js';

const POOL_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [] },
  {
    type: 'function', name: 'borrow', stateMutability: 'nonpayable',
    inputs: [{ name: 'nft', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  { type: 'function', name: 'repay', stateMutability: 'payable', inputs: [{ name: 'loanId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'debtOf', stateMutability: 'view', inputs: [{ name: 'loanId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'getLoan', stateMutability: 'view', inputs: [{ name: 'loanId', type: 'uint256' }],
    outputs: [{ name: 'borrower', type: 'address' }, { name: 'nft', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'principal', type: 'uint256' }, { name: 'startTime', type: 'uint64' }, { name: 'repaid', type: 'bool' }] },
  { type: 'function', name: 'loanCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'floorOf', stateMutability: 'view', inputs: [{ name: 'nft', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'poolAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'sharePrice', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'utilizationBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'sharesOf', stateMutability: 'view', inputs: [{ name: 'who', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalShares', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalOutstanding', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'borrowRateBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

const NFT_APPROVE_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'getApproved', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
] as const;

function pool(env: Env): `0x${string}` {
  const p = getLendingPool(env);
  if (!p) throw new Error('No lending pool configured. Set LENDING_POOL_ADDRESS.');
  return p;
}

export function registerLendingTools(server: McpServer, env: Env): void {
  addTool(
    server,
    'lending_deposit',
    'Supply MON to the NFT lending pool and earn borrower interest (share price grows). Above the spending limit needs dashboard approval.',
    {
      amount: z.string().describe('MON to supply, e.g. "1"'),
      userId: z.string().optional(),
    },
    async ({ amount, userId }: { amount: string; userId?: string }) => {
      try {
        const poolAddr = pool(env);
        const wallet = await resolveWallet(env, userId);
        const valueWei = parseEther(amount);
        if (valueWei <= 0n) throw new Error('Amount must be > 0.');
        const data = encodeFunctionData({ abi: POOL_ABI, functionName: 'deposit', args: [] });
        const sim = await simulateTx(env, { from: wallet.address, to: poolAddr, value: valueWei, data });
        if (!sim.ok) return textResult({ ok: false, error: `Pre-flight failed: ${sim.reason}`, summary: `Deposit blocked: ${sim.reason}.` });
        const gate = await approvalGate({ action: 'lending_deposit', details: { lender: wallet.address, amountMON: amount, simulation: `${sim.verdict}, fee ≈ ${formatEther(sim.feeWei)} MON` }, valueWei, env, reason: `Supply ${amount} MON to lending pool`, userId });
        if (gate.decision !== 'approved') {
          await auditLog({ tool: 'lending_deposit', userId, result: 'rejected', params: { amount } });
          return textResult({ ok: false, approvalRequired: true, requestId: gate.requestId, summary: `Deposit needs approval. ${gate.message}` });
        }
        const hash = await privySendTransaction(env, wallet, { to: poolAddr, value: valueWei, data });
        const receipt = await getPublicClient(env).waitForTransactionReceipt({ hash });
        await auditLog({ tool: 'lending_deposit', userId, result: 'ok', txHash: hash, params: { amount } });
        return textResult({
          ok: true, txHash: hash, explorerUrl: explorerTxUrl(env, hash), amountMON: amount,
          blockNumber: receipt.blockNumber.toString(),
          summary: `Supplied ${amount} MON to the lending pool. Earning borrower interest from here. Tx ${hash}. View: ${explorerTxUrl(env, hash)}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'lending_deposit', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg });
      }
    },
  );

  addTool(
    server,
    'lending_withdraw',
    'Withdraw pool shares back to MON (principal + earned interest).',
    {
      shares: z.string().describe('Shares to redeem in raw units, or "max" for everything'),
      userId: z.string().optional(),
    },
    async ({ shares, userId }: { shares: string; userId?: string }) => {
      try {
        const poolAddr = pool(env);
        const wallet = await resolveWallet(env, userId);
        const client = getPublicClient(env);
        let sharesRaw: bigint;
        if (shares === 'max') {
          sharesRaw = (await client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'sharesOf', args: [wallet.address as `0x${string}`] })) as bigint;
          if (sharesRaw <= 0n) throw new Error('No shares to withdraw.');
        } else {
          sharesRaw = BigInt(shares);
          if (sharesRaw <= 0n) throw new Error('Shares must be > 0.');
        }
        const data = encodeFunctionData({ abi: POOL_ABI, functionName: 'withdraw', args: [sharesRaw] });
        const hash = await privySendTransaction(env, wallet, { to: poolAddr, value: 0n, data });
        const receipt = await client.waitForTransactionReceipt({ hash });
        await auditLog({ tool: 'lending_withdraw', userId, result: 'ok', txHash: hash, params: { shares: sharesRaw.toString() } });
        return textResult({
          ok: true, txHash: hash, explorerUrl: explorerTxUrl(env, hash),
          blockNumber: receipt.blockNumber.toString(),
          summary: `Withdrew ${sharesRaw.toString()} shares as MON (principal + earned interest). Tx ${hash}.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'lending_withdraw', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg });
      }
    },
  );

  addTool(
    server,
    'lending_borrow',
    'Borrow MON against a whitelisted NFT (up to 50% of floor). NFT escrows in the pool until repaid. ALWAYS requires explicit human approval.',
    {
      nft: z.string().describe('NFT contract address (0x...)'),
      tokenId: z.string().describe('Token id to lock as collateral'),
      amount: z.string().describe('MON to borrow, e.g. "0.2"'),
      userId: z.string().optional(),
    },
    async ({ nft, tokenId, amount, userId }: { nft: string; tokenId: string; amount: string; userId?: string }) => {
      try {
        assertAddress(nft, 'nft');
        const poolAddr = pool(env);
        const wallet = await resolveWallet(env, userId);
        const amountWei = parseEther(amount);
        if (amountWei <= 0n) throw new Error('Amount must be > 0.');
        const client = getPublicClient(env);
        const nftAddr = nft as `0x${string}`;
        const tid = BigInt(tokenId);
        const owner = (await client.readContract({ address: nftAddr, abi: NFT_APPROVE_ABI, functionName: 'ownerOf', args: [tid] }).catch(() => null)) as string | null;
        if (!owner) throw new Error(`Token #${tokenId} does not exist.`);
        if (owner.toLowerCase() !== wallet.address.toLowerCase()) throw new Error(`You don't own ${nft} #${tokenId}.`);
        const floor = (await client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'floorOf', args: [nftAddr] })) as bigint;
        if (floor <= 0n) throw new Error('Collection not whitelisted for borrowing.');
        const maxBorrow = (floor * 5000n) / 10000n;
        if (amountWei > maxBorrow) {
          return textResult({ ok: false, error: `Max borrow is ${formatEther(maxBorrow)} MON (50% of ${formatEther(floor)} MON floor).`, summary: `Borrow blocked: ${amount} MON exceeds 50% LTV (${formatEther(maxBorrow)} MON max).` });
        }
        // Check authorization without changing chain state. The human gate must
        // happen before the ERC-721 approval transaction as well as the borrow.
        const approved = (await client.readContract({ address: nftAddr, abi: NFT_APPROVE_ABI, functionName: 'getApproved', args: [tid] }).catch(() => '0x0000000000000000000000000000000000000000')) as string;
        const needsNftApproval = approved.toLowerCase() !== poolAddr.toLowerCase();
        const data = encodeFunctionData({ abi: POOL_ABI, functionName: 'borrow', args: [nftAddr, tid, amountWei] });
        // This call can be simulated before approval only when the pool is
        // already authorized; otherwise the expected missing-approval revert
        // would hide whether the borrow itself is valid.
        const sim = needsNftApproval ? null : await simulateTx(env, { from: wallet.address, to: poolAddr, value: 0n, data });
        if (sim && !sim.ok) {
          return textResult({ ok: false, error: `Pre-flight failed: ${sim.reason}`, summary: `Borrow blocked before approval: ${sim.reason}.` });
        }
        const gate = await approvalGate({
          action: 'lending_borrow',
          details: {
            borrower: wallet.address,
            nft,
            tokenId,
            amountMON: amount,
            maxLTV: `${formatEther(maxBorrow)} MON`,
            nftApprovalRequired: needsNftApproval,
            simulation: sim ? `${sim.verdict}, fee ≈ ${formatEther(sim.feeWei)} MON` : 'Borrow will be simulated after the approved NFT authorization.',
          },
          valueWei: 0n,
          env,
          forceApproval: true,
          reason: `Borrow ${amount} MON against ${nft} #${tokenId} (debt + 10% APR)`,
          userId,
        });
        if (gate.decision !== 'approved') {
          await auditLog({ tool: 'lending_borrow', userId, result: 'rejected', params: { nft, tokenId, amount } });
          return textResult({ ok: false, approvalRequired: true, requestId: gate.requestId, summary: `Borrow needs approval. ${gate.message} No funds moved, NFT stays with you.` });
        }
        let approvalTxHash: `0x${string}` | null = null;
        if (needsNftApproval) {
          const approvalData = encodeFunctionData({ abi: NFT_APPROVE_ABI, functionName: 'approve', args: [poolAddr, tid] });
          approvalTxHash = await privySendTransaction(env, wallet, { to: nftAddr, value: 0n, data: approvalData });
          await client.waitForTransactionReceipt({ hash: approvalTxHash });
        }
        const finalSim = sim ?? await simulateTx(env, { from: wallet.address, to: poolAddr, value: 0n, data });
        if (!finalSim.ok) {
          let revokeMessage = '';
          if (approvalTxHash) {
            try {
              const revokeData = encodeFunctionData({ abi: NFT_APPROVE_ABI, functionName: 'approve', args: ['0x0000000000000000000000000000000000000000', tid] });
              const revokeHash = await privySendTransaction(env, wallet, { to: nftAddr, value: 0n, data: revokeData });
              await client.waitForTransactionReceipt({ hash: revokeHash });
              revokeMessage = ' The temporary NFT approval was revoked.';
            } catch {
              revokeMessage = ' The pool approval could not be revoked automatically; revoke it manually.';
            }
          }
          return textResult({ ok: false, error: `Pre-flight failed: ${finalSim.reason}`, summary: `Borrow was not sent: ${finalSim.reason}.${revokeMessage}` });
        }
        const hash = await privySendTransaction(env, wallet, { to: poolAddr, value: 0n, data });
        const receipt = await client.waitForTransactionReceipt({ hash });
        await auditLog({ tool: 'lending_borrow', userId, result: 'ok', txHash: hash, params: { nft, tokenId, amount } });
        return textResult({
          ok: true, txHash: hash, explorerUrl: explorerTxUrl(env, hash), nftApprovalTxHash: approvalTxHash,
          blockNumber: receipt.blockNumber.toString(),
          summary: `Borrowed ${amount} MON against ${nft} #${tokenId} at 10% APR. NFT escrowed; repay via lending_repay to reclaim. Tx ${hash}.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'lending_borrow', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg });
      }
    },
  );

  addTool(
    server,
    'lending_repay',
    'Repay an NFT loan (partial or full). Full repayment + interest releases the NFT.',
    {
      loanId: z.string().describe('Loan id to repay'),
      amount: z.string().optional().describe('MON to repay. Defaults to the full current debt.'),
      userId: z.string().optional(),
    },
    async ({ loanId, amount, userId }: { loanId: string; amount?: string; userId?: string }) => {
      try {
        const poolAddr = pool(env);
        const wallet = await resolveWallet(env, userId);
        const client = getPublicClient(env);
        const loan = (await client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'getLoan', args: [BigInt(loanId)] }).catch(() => null)) as unknown as [string, string, bigint, bigint, bigint, boolean] | null;
        if (!loan || loan[0] === '0x0000000000000000000000000000000000000000') throw new Error(`Loan #${loanId} does not exist.`);
        if (loan[5]) throw new Error(`Loan #${loanId} already repaid.`);
        const debt = (await client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'debtOf', args: [BigInt(loanId)] })) as bigint;
        // Dust state (zero principal, still open): release costs nothing but gas.
        const payWei = amount ? parseEther(amount) : debt;
        if (payWei <= 0n && loan[3] > 0n) throw new Error(`Loan #${loanId} owes ${formatEther(debt)} MON — pass an amount.`);
        if (payWei <= 0n && loan[3] <= 0n && amount) throw new Error('Amount must be > 0.');
        const data = encodeFunctionData({ abi: POOL_ABI, functionName: 'repay', args: [BigInt(loanId)] });
        const sim = await simulateTx(env, { from: wallet.address, to: poolAddr, value: payWei, data });
        if (!sim.ok) return textResult({ ok: false, error: `Pre-flight failed: ${sim.reason}`, summary: `Repay blocked: ${sim.reason}.` });
        const gate = await approvalGate({
          action: 'lending_repay',
          details: { payer: wallet.address, loanId, payMON: formatEther(payWei), fullDebtMON: formatEther(debt), closes: payWei >= debt, simulation: `${sim.verdict}, fee ≈ ${formatEther(sim.feeWei)} MON` },
          valueWei: payWei,
          env,
          reason: `Repay ${formatEther(payWei)} MON on loan #${loanId}`,
          userId,
        });
        if (gate.decision !== 'approved') {
          await auditLog({ tool: 'lending_repay', userId, result: 'rejected', params: { loanId } });
          return textResult({ ok: false, approvalRequired: true, requestId: gate.requestId, summary: `Repay needs approval. ${gate.message}` });
        }
        const hash = await privySendTransaction(env, wallet, { to: poolAddr, value: payWei, data });
        const receipt = await client.waitForTransactionReceipt({ hash });
        await auditLog({ tool: 'lending_repay', userId, result: 'ok', txHash: hash, params: { loanId } });
        return textResult({
          ok: true, txHash: hash, explorerUrl: explorerTxUrl(env, hash),
          paidMON: formatEther(payWei),
          closed: payWei >= debt,
          blockNumber: receipt.blockNumber.toString(),
          summary: payWei >= debt
            ? `Loan #${loanId} fully repaid (${formatEther(payWei)} MON). NFT released to you. Tx ${hash}.`
            : `Repaid ${formatEther(payWei)} MON on loan #${loanId}. Remainder still accrues. Tx ${hash}.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'lending_repay', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg });
      }
    },
  );

  addTool(
    server,
    'lending_positions',
    'Pool overview + your loans and shares: utilization, share price, debts, health.',
    {
      address: z.string().optional().describe('Address to inspect. Defaults to the agent wallet.'),
      userId: z.string().optional(),
    },
    async ({ address, userId }: { address?: string; userId?: string }) => {
      try {
        const poolAddr = pool(env);
        let target = address;
        if (!target) target = (await resolveWallet(env, userId)).address;
        assertAddress(target);
        const client = getPublicClient(env);
        const tAddr = target as `0x${string}`;
        const [assets, shares, util, price, rate, myShares, count] = await Promise.all([
          client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'poolAssets' }) as Promise<bigint>,
          client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'totalShares' }) as Promise<bigint>,
          client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'utilizationBps' }) as Promise<bigint>,
          client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'sharePrice' }) as Promise<bigint>,
          client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'borrowRateBps' }) as Promise<bigint>,
          client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'sharesOf', args: [tAddr] }) as Promise<bigint>,
          client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'loanCount' }) as Promise<bigint>,
        ]);
        const myValue = shares > 0n ? (myShares * assets) / shares : 0n;
        const loans: Array<Record<string, string>> = [];
        const cap = count > 50n ? 50n : count;
        for (let i = 1n; i <= cap; i++) {
          try {
            const l = (await client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'getLoan', args: [i] })) as unknown as [string, string, bigint, bigint, bigint, boolean];
            if (l[0].toLowerCase() !== target.toLowerCase() || l[5]) continue;
            const debt = (await client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'debtOf', args: [i] })) as bigint;
            loans.push({ loanId: i.toString(), nft: l[1], tokenId: l[2].toString(), principalMON: formatEther(l[3]), debtMON: formatEther(debt) });
          } catch {
            continue;
          }
        }
        await auditLog({ tool: 'lending_positions', userId, result: 'ok', params: { address: target } });
        return textResult({
          ok: true,
          pool: poolAddr,
          poolExplorerUrl: explorerAddressUrl(env, poolAddr),
          poolAssetsMON: formatEther(assets),
          utilizationPct: (Number(util) / 100).toFixed(2),
          sharePriceMON: formatEther(price),
          borrowAprPct: (Number(rate) / 100).toFixed(2),
          myShares: myShares.toString(),
          myPositionMON: formatEther(myValue),
          loans,
          summary: `Pool holds ${formatEther(assets)} MON at ${(Number(util) / 100).toFixed(2)}% utilization (${(Number(rate) / 100).toFixed(2)}% APR). You hold ${formatEther(myValue)} MON in shares across ${loans.length} open loan(s).`,
        });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
