import { describe, expect, it } from 'vitest';
import { findWalletIdInPrivyApi } from '../packages/mcp-server/src/config/privy.js';

const legacyAddress = '0xbcEE35caD52640C02f25Ea9b318737822DA2d10C';

describe('legacy Privy wallet recovery', () => {
  it('finds an exact Ethereum address match across pages', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const walletApi = {
      async getWallets(input: { chainType: 'ethereum'; limit: number; cursor?: string }) {
        calls.push(input);
        return input.cursor
          ? { data: [{ id: 'wallet-legacy', address: legacyAddress.toLowerCase() }] }
          : { data: [{ id: 'other-wallet', address: '0x1111111111111111111111111111111111111111' }], nextCursor: 'next' };
      },
    };

    await expect(findWalletIdInPrivyApi(walletApi, legacyAddress)).resolves.toBe('wallet-legacy');
    expect(calls).toEqual([
      { chainType: 'ethereum', limit: 100 },
      { chainType: 'ethereum', limit: 100, cursor: 'next' },
    ]);
  });

  it('refuses to link when no Privy wallet exactly matches', async () => {
    const walletApi = { async getWallets() { return { data: [] }; } };
    await expect(findWalletIdInPrivyApi(walletApi, legacyAddress)).rejects.toThrow(/No Privy-managed Ethereum wallet matches/);
  });

  it('refuses ambiguous duplicate address matches', async () => {
    const walletApi = {
      async getWallets() {
        return { data: [
          { id: 'wallet-1', address: legacyAddress },
          { id: 'wallet-2', address: legacyAddress.toLowerCase() },
        ] };
      },
    };
    await expect(findWalletIdInPrivyApi(walletApi, legacyAddress)).rejects.toThrow(/More than one Privy wallet/);
  });
});
