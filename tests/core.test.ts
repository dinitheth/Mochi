import { describe, expect, it } from 'vitest';
import { validateEnv } from '../packages/mcp-server/src/config/env.js';
import { NETWORK_META, explorerTxUrl } from '../packages/mcp-server/src/config/monad.js';
import { formatWeiAsMon, isOverSpendingLimit } from '../packages/mcp-server/src/middleware/spending-policy.js';

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

describe('spending policy helpers', () => {
  it('compares values against the configured approval threshold', () => {
    const env = validateEnv({ ...process.env, PRIVY_APP_ID: '', PRIVY_APP_SECRET: '' });
    expect(isOverSpendingLimit(env.spendingLimitWei, env)).toBe(true);
    expect(isOverSpendingLimit(env.spendingLimitWei - 1n, env)).toBe(false);
    expect(formatWeiAsMon(1_500_000_000_000_000_000n)).toContain('1.5');
  });
});
