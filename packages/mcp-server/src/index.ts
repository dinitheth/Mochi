#!/usr/bin/env node
import dns from 'node:dns';
// Prefer IPv4: some networks (notably certain Windows/ISP setups) blackhole
// IPv6 routes to wallet APIs, hanging outbound HTTPS until timeout. Setting
// this in-code (rather than via node CLI flags) makes it hold no matter how
// the server is launched (Claude Desktop, Codex, manual).
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  /* non-critical on older runtimes */
}
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { validateEnv, type Env } from './config/env.js';
import { registerWalletTools } from './tools/wallet/index.js';
import { registerTransactionTools } from './tools/transactions/index.js';
import { registerContractTools } from './tools/contracts/index.js';
import { registerNFTTools } from './tools/nft/index.js';
import { registerDeFiTools } from './tools/defi/index.js';
import { registerLendingTools } from './tools/lending/index.js';
import { registerContactTools } from './tools/contacts/index.js';
import { registerAppUI } from './apps/index.js';
import { registerSettingsTools } from './tools/settings/index.js';
import { registerChainTools } from './tools/chain/index.js';
import { registerPrompts } from './prompts/monad-agent.js';
import { registerResources } from './resources/network-info.js';

export function createServer(env: Env): McpServer {
  const server = new McpServer({ name: 'monad-mcp', version: '1.0.0' });
  registerWalletTools(server, env);
  registerTransactionTools(server, env);
  registerContractTools(server, env);
  registerNFTTools(server, env);
  registerDeFiTools(server, env);
  registerLendingTools(server, env);
  registerContactTools(server, env);
  registerAppUI(server);
  registerSettingsTools(server, env);
  registerChainTools(server, env);
  registerPrompts(server);
  registerResources(server, env);
  return server;
}

async function runStdio(env: Env): Promise<void> {
  const server = createServer(env);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Mochi is running (stdio) on ${env.MONAD_NETWORK}. Monad ecosystem at your fingertips.`);
}

async function runHttp(env: Env): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'monad-mcp', network: env.MONAD_NETWORK });
  });

  // Stateless Streamable HTTP: fresh server+transport per request (simple, horizontally scalable).
  app.post('/mcp', async (req, res) => {
    try {
      const server = createServer(env);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => transport.close?.());
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[http] /mcp error:', err instanceof Error ? err.message : err);
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'Internal MCP error' });
    }
  });

  app.get('/mcp', async (req, res) => {
    res.status(405).json({ ok: false, error: 'Use POST /mcp for Streamable HTTP requests.' });
  });

  app.listen(env.MCP_HTTP_PORT, () => {
    console.error(`Mochi HTTP listening on :${env.MCP_HTTP_PORT} (POST /mcp). Network: ${env.MONAD_NETWORK}.`);
  });
}

async function main(): Promise<void> {
  const env = validateEnv();
  const wantsHttp = process.argv.includes('--http') || env.MCP_TRANSPORT === 'http';
  if (wantsHttp) await runHttp(env);
  else await runStdio(env);
}

main().catch((err) => {
  console.error('[monad-mcp] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
