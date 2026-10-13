import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateEnv } from '../packages/mcp-server/src/config/env.js';
import { getStoredWallet, importWalletRecord } from '../packages/mcp-server/src/config/privy.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('persistent wallet records', () => {
  it('keeps wallet mappings in MOCHI_DATA_DIR so they survive a service restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mochi-wallet-state-'));
    cleanup.push(dataDir);
    const env = validateEnv({ ...process.env, MOCHI_DATA_DIR: dataDir });
    const wallet = await importWalletRecord(
      env,
      'owner',
      '0xbcEE35caD52640C02f25Ea9b318737822DA2d10C',
      'privy:legacy-wallet',
      'mainnet',
    );

    const restartedEnv = validateEnv({ ...process.env, MOCHI_DATA_DIR: dataDir });
    await expect(getStoredWallet('owner', restartedEnv)).resolves.toEqual(wallet);
    await expect(readFile(join(dataDir, 'wallet-state.json'), 'utf8')).resolves.toContain('privy:legacy-wallet');
  });
});
