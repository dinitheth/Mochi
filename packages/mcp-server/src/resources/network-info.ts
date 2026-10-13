import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatEther } from 'viem';
import type { Env } from '../config/env.js';
import { explorerAddressUrl, getPublicClient, NETWORK_META } from '../config/monad.js';
import { getDefaultWallet } from '../config/privy.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyServer = any;

function addResource(server: McpServer, name: string, uri: string, description: string, mimeType: string, read: (u: URL) => Promise<string>): void {
  const s = server as AnyServer;
  const cb = async (u: URL) => ({ contents: [{ uri: u.href, mimeType, text: await read(u) }] });
  if (typeof s.registerResource === 'function') {
    s.registerResource(name, uri, { description, mimeType }, cb);
    return;
  }
  if (typeof s.resource === 'function') {
    s.resource(name, uri, cb);
    return;
  }
  console.error(`[monad-mcp] resource registration not supported; skipping ${uri}`);
}

export function registerResources(server: McpServer, env: Env): void {
  addResource(server, 'monad-mainnet', 'monad://network/mainnet', 'Monad mainnet config', 'application/json', async () => {
    const m = NETWORK_META.mainnet;
    return JSON.stringify({ network: 'mainnet', chainId: m.chainId, rpcEndpointConfigured: Boolean(env.MONAD_MAINNET_RPC_URL), explorerUrl: m.explorerUrl, currency: m.currency, wmon: m.wmon }, null, 2);
  });

  addResource(server, 'monad-testnet', 'monad://network/testnet', 'Monad testnet config', 'application/json', async () => {
    const m = NETWORK_META.testnet;
    return JSON.stringify({ network: 'testnet', chainId: m.chainId, rpcEndpointConfigured: Boolean(env.MONAD_RPC_URL), explorerUrl: m.explorerUrl, currency: m.currency, faucet: m.faucet, wmon: m.wmon }, null, 2);
  });

  addResource(server, 'wallet-status', 'monad://wallet/status', 'Current agent wallet address and balance', 'application/json', async () => {
    const wallet = await getDefaultWallet(env).catch(() => null);
    if (!wallet) return JSON.stringify({ initialized: false, hint: 'Call wallet_initialize first.' }, null, 2);
    let balanceWei = '0';
    try {
      const client = getPublicClient(env);
      balanceWei = (await client.getBalance({ address: wallet.address as `0x${string}` })).toString();
    } catch {
      balanceWei = '0';
    }
    return JSON.stringify(
      {
        initialized: true,
        address: wallet.address,
        network: env.MONAD_NETWORK,
        balanceWei,
        balanceMON: formatEther(BigInt(balanceWei)),
        explorerUrl: explorerAddressUrl(env, wallet.address),
      },
      null,
 2,
    );
  });

  addResource(server, 'docs-overview', 'monad://docs/overview', 'Monad docs entry points', 'application/json', async () => {
    return JSON.stringify(
      {
        docs: 'https://docs.monad.xyz',
        network: 'https://docs.monad.xyz/developer-essentials/network-information',
        testnet: 'https://docs.monad.xyz/developer-essentials/testnet',
        mcpGuide: 'https://docs.monad.xyz/guides/monad-mcp',
        faucet: 'https://faucet.monad.xyz',
      },
      null,
      2,
    );
  });
}
