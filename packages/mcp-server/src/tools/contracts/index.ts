import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { parseEther } from 'viem';
import type { Env } from '../../config/env.js';
import { explorerTxUrl, getPublicClient } from '../../config/monad.js';
import { privySendTransaction } from '../../config/privy.js';
import { approvalGate } from '../../middleware/approval-gate.js';
import { auditLog } from '../../middleware/audit-log.js';
import { addTool, assertAddress, resolveWallet, textResult } from '../shared.js';

const abiParam = z.array(z.any()).describe('ABI fragment (array) for the target function');

export function registerContractTools(server: McpServer, env: Env): void {
  addTool(
    server,
    'contract_read',
    'Call any view/pure function on any contract. Read-only, no approval needed.',
    {
      contractAddress: z.string().describe('Contract address (0x...)'),
      abi: abiParam,
      functionName: z.string().min(1).describe('Function name to call'),
      args: z.array(z.any()).optional().describe('Function arguments'),
    },
    async ({ contractAddress, abi, functionName, args }: { contractAddress: string; abi: Array<Record<string, unknown>>; functionName: string; args?: unknown[] }) => {
      try {
        assertAddress(contractAddress, 'contract');
        const client = getPublicClient(env);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await client.readContract({ address: contractAddress as `0x${string}`, abi: abi as any, functionName, args: (args ?? []) as any });
        await auditLog({ tool: 'contract_read', result: 'ok', params: { contractAddress, functionName } });
        return textResult({
          ok: true,
          contractAddress,
          functionName,
          result: typeof result === 'bigint' ? result.toString() : result,
          summary: `${functionName} on ${contractAddress} returned ${typeof result === 'bigint' ? result.toString() : JSON.stringify(result)}`,
        });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  addTool(
    server,
    'contract_write',
    'Call any state-changing function. Goes through the approval gate when value > 0 or always when flagged.',
    {
      contractAddress: z.string().describe('Contract address (0x...)'),
      abi: abiParam,
      functionName: z.string().min(1).describe('Function name to call'),
      args: z.array(z.any()).optional().describe('Function arguments'),
      value: z.string().optional().describe('MON value to send, e.g. "0.05"'),
      requireApproval: z.boolean().default(false).describe('Force human approval even for zero-value calls'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ contractAddress, abi, functionName, args, value, requireApproval, userId }: { contractAddress: string; abi: Array<Record<string, unknown>>; functionName: string; args?: unknown[]; value?: string; requireApproval?: boolean; userId?: string }) => {
      try {
        assertAddress(contractAddress, 'contract');
        const wallet = await resolveWallet(env, userId);
        const valueWei = value ? parseEther(value) : 0n;
        const client = getPublicClient(env);
        const { encodeFunctionData } = await import('viem');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = encodeFunctionData({ abi: abi as any, functionName, args: ((args ?? []) as any) });

        const gate = await approvalGate({
          action: 'contract_write',
          details: { from: wallet.address, contractAddress, functionName, args: args ?? [], valueMON: value ?? '0' },
          valueWei,
          env,
          forceApproval: requireApproval === true,
          userId,
        });
        if (gate.decision !== 'approved') {
          await auditLog({ tool: 'contract_write', userId, result: 'rejected', params: { contractAddress, functionName } });
          return textResult({
            ok: false,
            approvalRequired: true,
            requestId: gate.requestId,
            summary: `Contract call ${functionName} needs approval. ${gate.message} Approve in the dashboard to continue.`,
          });
        }

        const hash = await privySendTransaction(env, wallet, { to: contractAddress as `0x${string}`, value: valueWei, data });
        const receipt = await client.waitForTransactionReceipt({ hash });
        await auditLog({ tool: 'contract_write', userId, result: 'ok', txHash: hash, params: { contractAddress, functionName } });
        return textResult({
          ok: true,
          txHash: hash,
          explorerUrl: explorerTxUrl(env, hash),
          contractAddress,
          functionName,
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          summary: `${functionName} on ${contractAddress} executed. Tx ${hash}. View: ${explorerTxUrl(env, hash)}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'contract_write', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg });
      }
    },
  );

  addTool(
    server,
    'contract_deploy',
    'Deploy a new contract. ALWAYS requires explicit human approval. Returns address, tx hash and cost.',
    {
      bytecode: z.string().describe('Contract creation bytecode (0x...)'),
      abi: abiParam.describe('Contract ABI'),
      constructorArgs: z.array(z.any()).optional().describe('Constructor arguments'),
      userId: z.string().optional().describe('User/session id owning the wallet'),
    },
    async ({ bytecode, abi, constructorArgs, userId }: { bytecode: string; abi: Array<Record<string, unknown>>; constructorArgs?: unknown[]; userId?: string }) => {
      try {
        if (!bytecode.startsWith('0x') || bytecode.length < 10) throw new Error('Invalid bytecode. Expected 0x-prefixed creation code.');
        const wallet = await resolveWallet(env, userId);
        const { encodeDeployData } = await import('viem');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = encodeDeployData({ abi: abi as any, bytecode: bytecode as `0x${string}`, args: ((constructorArgs ?? []) as any) });

        const gate = await approvalGate({
          action: 'contract_deploy',
          details: { from: wallet.address, bytecodeBytes: (bytecode.length - 2) / 2, constructorArgs: constructorArgs ?? [] },
          valueWei: 0n,
          env,
          forceApproval: true,
          reason: 'Contract deployments always require explicit confirmation',
          userId,
        });
        if (gate.decision !== 'approved') {
          await auditLog({ tool: 'contract_deploy', userId, result: 'rejected' });
          return textResult({
            ok: false,
            approvalRequired: true,
            requestId: gate.requestId,
            summary: `Deployment needs your explicit approval. ${gate.message} Review the bytecode and approve in the dashboard.`,
          });
        }

        // Deploy = send a contract-creation transaction with no `to` field.
        const client = getPublicClient(env);
        if (!wallet.walletId.startsWith('local:')) {
          const hash = await privySendTransaction(env, wallet, { value: 0n, data });
          const receipt = await client.waitForTransactionReceipt({ hash });
          if (!receipt.contractAddress) throw new Error('Deployment receipt has no contract address.');
          await auditLog({ tool: 'contract_deploy', userId, result: 'ok', txHash: hash });
          return textResult({
            ok: true,
            txHash: hash,
            contractAddress: receipt.contractAddress,
            explorerUrl: explorerTxUrl(env, hash),
            gasUsed: receipt.gasUsed.toString(),
            summary: `Contract deployed at ${receipt.contractAddress}. Tx ${hash}. View: ${explorerTxUrl(env, hash)}`,
          });
        }
        if (wallet.walletId.startsWith('local:')) {
          const { createWalletClient, http } = await import('viem');
          const { privateKeyToAccount } = await import('viem/accounts');
          const { getChain, getRpcUrl, explorerTxUrl: txUrl } = await import('../../config/monad.js');
          const account = privateKeyToAccount(env.DEV_PRIVATE_KEY as `0x${string}`);
          const wc = createWalletClient({ account, chain: getChain(env), transport: http(getRpcUrl(env)) });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const realHash = await wc.deployContract({ abi: abi as any, bytecode: bytecode as `0x${string}`, args: ((constructorArgs ?? []) as any) });
          const rcpt = await getPublicClient(env).waitForTransactionReceipt({ hash: realHash });
          await auditLog({ tool: 'contract_deploy', userId, result: 'ok', txHash: realHash });
          return textResult({
            ok: true,
            txHash: realHash,
            contractAddress: rcpt.contractAddress,
            explorerUrl: txUrl(env, realHash),
            gasUsed: rcpt.gasUsed.toString(),
            summary: `Contract deployed at ${rcpt.contractAddress}. Tx ${realHash}. View: ${txUrl(env, realHash)}`,
          });
        }

        throw new Error('Unsupported wallet type for contract deployment.');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await auditLog({ tool: 'contract_deploy', userId, result: 'error', error: msg });
        return textResult({ ok: false, error: msg });
      }
    },
  );
}
