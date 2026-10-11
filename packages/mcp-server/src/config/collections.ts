import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LaunchedCollection {
  symbol: string;
  name: string;
  address: string;
  deployTx: string;
  supply: number;
  listed: number;
  floorPriceMON: string | null;
  launchedAt: string;
  launchedBy: string;
}

function registryPath(): string {
  // src/config -> mcp-server root is 2 levels up; dist mirrors src depth.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'collections.json');
}

export async function readRegistry(): Promise<Record<string, LaunchedCollection>> {
  try {
    return JSON.parse(await fs.readFile(registryPath(), 'utf8')) as Record<string, LaunchedCollection>;
  } catch {
    return {};
  }
}

export async function addToRegistry(entry: LaunchedCollection): Promise<void> {
  const reg = await readRegistry();
  reg[entry.address.toLowerCase()] = entry;
  await fs.writeFile(registryPath(), JSON.stringify(reg, null, 2), 'utf8');
}
