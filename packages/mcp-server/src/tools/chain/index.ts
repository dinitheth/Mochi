import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatEther, formatGwei } from 'viem';
import type { Env } from '../../config/env.js';
import { getPublicClient, NETWORK_META } from '../../config/monad.js';
import { hyperRpcLogs } from '../../config/hyperrpc.js';
import { hyperSyncLogs } from '../../config/hypersync.js';
import { auditLog } from '../../middleware/audit-log.js';
import { addTool, assertAddress, textResult } from '../shared.js';

export function registerChainTools(server: McpServer, env: Env): void {
  addTool(
    server,
    'chain_get_network_stats',
    'Live Monad network stats: latest block, gas price, chain id, RPC and explorer.',
    {},
    async () => {
      try {
        const client = getPublicClient(env);
        const [blockNumber, gasPrice, block] = await Promise.all([
          client.getBlockNumber(),
          client.getGasPrice().catch(() => 0n),
          client.getBlock({ blockTag: 'latest' }).catch(() => null),
        ]);
        const meta = NETWORK_META[env.MONAD_NETWORK];
        await auditLog({ tool: 'chain_get_network_stats', result: 'ok' });
        return textResult({
          ok: true,
          network: env.MONAD_NETWORK,
          chainId: meta.chainId,
          latestBlock: blockNumber.toString(),
          blockTimestamp: block ? Number(block.timestamp) : null,
          txCountLatestBlock: block ? block.transactions.length : null,
          gasPriceWei: gasPrice.toString(),
          gasPriceGwei: formatGwei(gasPrice),
          advertisedTps: meta.tps,
          advertisedBlockTimeMs: meta.blockTimeMs,
          rpcUrl: meta.rpcUrl,
          explorerUrl: meta.explorerUrl,
          summary: `${meta.name} (chain ${meta.chainId}): block ${blockNumber}, gas ${formatGwei(gasPrice)} gwei, ~${meta.blockTimeMs}ms blocks, ~${meta.tps} TPS advertised.`,
        });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  addTool(
    server,
    'chain_get_block',
    'Get a block by number, or the latest block by default.',
    {
      blockNumber: z.number().int().nonnegative().optional().describe('Block number. Defaults to latest.'),
    },
    async ({ blockNumber }: { blockNumber?: number }) => {
      try {
        const client = getPublicClient(env);
        const block =
          blockNumber === undefined
            ? await client.getBlock({ blockTag: 'latest' })
            : await client.getBlock({ blockNumber: BigInt(blockNumber) });
        return textResult({
          ok: true,
          number: block.number.toString(),
          hash: block.hash,
          parentHash: block.parentHash,
          timestamp: Number(block.timestamp),
          gasUsed: block.gasUsed.toString(),
          gasLimit: block.gasLimit.toString(),
          baseFeePerGas: block.baseFeePerGas ? formatGwei(block.baseFeePerGas) + ' gwei' : null,
          txCount: block.transactions.length,
          summary: `Block ${block.number}: ${block.transactions.length} txs, gas ${block.gasUsed}/${block.gasLimit}, ts ${Number(block.timestamp)}. Hash ${block.hash}.`,
        });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  addTool(
    server,
    'chain_get_gas_price',
    'Current gas price on Monad with a MON-denominated transfer cost hint.',
    {},
    async () => {
      const client = getPublicClient(env);
      const gasPrice = await client.getGasPrice();
      const transferCost = gasPrice * 21000n;
      return textResult({
        ok: true,
        gasPriceWei: gasPrice.toString(),
        gasPriceGwei: formatGwei(gasPrice),
        typicalTransferMON: formatEther(transferCost),
        summary: `Gas ${formatGwei(gasPrice)} gwei — a 21k transfer costs ≈ ${formatEther(transferCost)} MON.`,
      });
    },
  );

  addTool(
    server,
    'chain_get_logs',
    'Query contract event logs over a block range. Tries HyperSync, then HyperRPC, then plain RPC — fastest available wins.',
    {
      address: z.string().describe('Contract address (0x...)'),
      topic0: z.string().optional().describe('Event signature hash (topic0). Omit for all events.'),
      fromBlock: z.number().int().nonnegative().describe('Start block number'),
      toBlock: z.number().int().nonnegative().optional().describe('End block number. Defaults to latest.'),
      limit: z.number().int().min(1).max(100).default(20).describe('Max logs to return'),
    },
    async ({ address, topic0, fromBlock, toBlock, limit }: { address: string; topic0?: string; fromBlock: number; toBlock?: number; limit: number; userId?: string }) => {
      try {
        assertAddress(address, 'contract');
        if (topic0 && !/^0x[0-9a-fA-F]{64}$/.test(topic0)) throw new Error('topic0 must be a 32-byte hash.');
        const client = getPublicClient(env);
        const latest = await client.getBlockNumber().catch(() => null);
        const end = toBlock !== undefined ? BigInt(toBlock) : (latest ?? BigInt(fromBlock));
        if (end < BigInt(fromBlock)) throw new Error('toBlock < fromBlock.');

        // 1) HyperSync (full-history engine).
        const hs = await hyperSyncLogs(env, {
          address,
          ...(topic0 ? { topics: [topic0] } : {}),
          fromBlock,
          toBlock: Number(end),
        }).catch(() => null);
        if (hs && hs.logs.length > 0) {
          const logs = hs.logs.slice(0, limit).map((l) => ({
            address: l.address,
            blockNumber: String(l.block_number),
            txHash: l.transaction_hash,
            topic0: l.topic0,
            data: l.data,
          }));
          return textResult({
            ok: true,
            source: 'hypersync',
            address,
            count: logs.length,
            archiveHeight: hs.archiveHeight,
            logs,
            summary: `${logs.length} log(s) for ${address} via HyperSync (archive height ${hs.archiveHeight}).`,
          });
        }

        // 2) HyperRPC fast path.
        const hr = await hyperRpcLogs(env, {
          address,
          ...(topic0 ? { topics: [topic0] } : {}),
          fromBlock: `0x${BigInt(fromBlock).toString(16)}`,
          toBlock: `0x${end.toString(16)}`,
        }).catch(() => null);
        if (hr) {
          const logs = hr.slice(0, limit).map((l: { address: string; blockNumber: string; transactionHash: string; topics: string[]; data: string }) => ({
            address: l.address,
            blockNumber: BigInt(l.blockNumber).toString(),
            txHash: l.transactionHash,
            topic0: l.topics?.[0] ?? null,
            data: l.data,
          }));
          await auditLog({ tool: 'chain_get_logs', result: 'ok', params: { address, fromBlock } });
          return textResult({ ok: true, source: 'hyperrpc', address, count: logs.length, logs, summary: `${logs.length} log(s) for ${address} via HyperRPC.` });
        }

        // 3) Plain RPC fallback.
        const rpcLogs = await client.getLogs({
          address: address as `0x${string}`,
          ...(topic0 ? { topics: [topic0 as `0x${string}`] } : {}),
          fromBlock: BigInt(fromBlock),
          toBlock: end,
        });
        const logs = rpcLogs.slice(0, limit).map((l) => ({
          address: l.address,
          blockNumber: l.blockNumber.toString(),
          txHash: l.transactionHash,
          topic0: l.topics[0] ?? null,
          data: l.data,
        }));
        await auditLog({ tool: 'chain_get_logs', result: 'ok', params: { address, fromBlock } });
        return textResult({ ok: true, source: 'rpc', address, count: logs.length, logs, summary: `${logs.length} log(s) for ${address} via RPC fallback.` });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
