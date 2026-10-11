import { describe, expect, it } from 'vitest';
import { validateEnv } from './config/env.js';
import { NETWORK_META, explorerTxUrl } from './config/monad.js';
import { formatWeiAsMon, isOverSpendingLimit } from './middleware/spending-policy.js';

describe('env', () => {
  it('parses defaults without Privy configured', () => {
    const env = validateEnv({ ...process.env, PRIVY_APP_ID: '', PRIVY_APP_SECRET: '' });
    expect(env.MONAD_NETWORK).toBe('testnet');
    expect(env.privyConfigured).toBe(false);
    expect(env.spendingLimitWei).toBe(1000000000000000000n);
  });
});

describe('network meta', () => {
  it('uses verified chain ids and RPCs', () => {
    expect(NETWORK_META.mainnet.chainId).toBe(143);
    expect(NETWORK_META.testnet.chainId).toBe(10143);
    expect(NETWORK_META.testnet.rpcUrl).toBe('https://testnet-rpc.monad.xyz');
    expect(NETWORK_META.mainnet.rpcUrl).toBe('https://rpc.monad.xyz');
  });

  it('builds explorer links', () => {
    const env = validateEnv({ ...process.env, PRIVY_APP_ID: '', PRIVY_APP_SECRET: '' });
    expect(explorerTxUrl(env, '0xabc')).toContain('/tx/0xabc');
  });
});

describe('spending policy', () => {
  it('flags over-limit values', () => {
    const env = validateEnv({ ...process.env, PRIVY_APP_ID: '', PRIVY_APP_SECRET: '' });
    expect(isOverSpendingLimit(env.spendingLimitWei, env)).toBe(true);
    expect(isOverSpendingLimit(env.spendingLimitWei - 1n, env)).toBe(false);
    expect(formatWeiAsMon(1500000000000000000n)).toContain('1.5');
  });
});
