import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateEnv } from '../packages/mcp-server/src/config/env.js';
import { NETWORK_META, explorerTxUrl } from '../packages/mcp-server/src/config/monad.js';
import { formatWeiAsMon, isOverSpendingLimit } from '../packages/mcp-server/src/middleware/spending-policy.js';
import { textResult } from '../packages/mcp-server/src/tools/shared.js';
import { registerResources } from '../packages/mcp-server/src/resources/network-info.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

afterEach(() => vi.unstubAllEnvs());

describe('environment configuration', () => {
  it('uses safe defaults without Privy configured', () => {
    const env = validateEnv({ ...process.env, MONAD_NETWORK: undefined, PRIVY_APP_ID: '', PRIVY_APP_SECRET: '' });
    expect(env.MONAD_NETWORK).toBe('testnet');
    expect(env.privyConfigured).toBe(false);
    expect(env.spendingLimitWei).toBe(1_000_000_000_000_000_000n);
  });
});

describe('Monad network metadata', () => {
  it('uses configured chain ids and canonical RPCs', () => {
    expect(NETWORK_META.mainnet.chainId).toBe(143);
    expect(NETWORK_META.testnet.chainId).toBe(10143);
    expect(NETWORK_META.testnet.rpcUrl).toBe('https://testnet-rpc.monad.xyz');
    expect(NETWORK_META.mainnet.rpcUrl).toBe('https://rpc.monad.xyz');
  });

  it('builds an explorer transaction link for the selected network', () => {
    const env = validateEnv({ ...process.env, PRIVY_APP_ID: '', PRIVY_APP_SECRET: '' });
    expect(explorerTxUrl(env, '0xabc')).toContain('/tx/0xabc');
  });
});

describe('private RPC credential handling', () => {
  it('redacts configured secret values and endpoint fields from MCP text results', () => {
    const rpcUrl = 'https://rpc.example.invalid/private-token';
    vi.stubEnv('MONAD_MAINNET_RPC_URL', rpcUrl);
    const result = textResult({ rpcUrl, error: `Request failed for ${rpcUrl}` });
    const text = result.content[0].text;
    expect(text).not.toContain(rpcUrl);
    expect(text).toContain('[redacted]');
  });

  it('does not expose private RPC URLs through the mainnet network resource', async () => {
    const rpcUrl = 'https://rpc.example.invalid/private-token';
    vi.stubEnv('MONAD_MAINNET_RPC_URL', rpcUrl);
    const registered: Array<{ name: string; read: (url: URL) => Promise<{ contents: Array<{ text: string }> }> }> = [];
    const mockServer = {
      registerResource: (name: string, _uri: string, _metadata: unknown, read: (url: URL) => Promise<{ contents: Array<{ text: string }> }>) => {
        registered.push({ name, read });
      },
    } as unknown as McpServer;
    registerResources(mockServer, validateEnv({ ...process.env, MONAD_MAINNET_RPC_URL: rpcUrl }));
    const mainnet = registered.find((resource) => resource.name === 'monad-mainnet');
    const result = await mainnet!.read(new URL('monad://network/mainnet'));
    expect(result.contents[0].text).not.toContain(rpcUrl);
    expect(JSON.parse(result.contents[0].text)).toMatchObject({ rpcEndpointConfigured: true, chainId: 143 });
  });
});

describe('spending policy helpers', () => {
  it('compares values against the configured approval threshold', () => {
    const env = validateEnv({ ...process.env, PRIVY_APP_ID: '', PRIVY_APP_SECRET: '' });
    expect(isOverSpendingLimit(env.spendingLimitWei, env)).toBe(true);
    expect(isOverSpendingLimit(env.spendingLimitWei - 1n, env)).toBe(false);
    expect(formatWeiAsMon(1_500_000_000_000_000_000n)).toContain('1.5');
  });
});
