import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ContractArtifact {
  abi: Array<Record<string, unknown>>;
  bytecode: `0x${string}`;
}

const cache = new Map<string, ContractArtifact>();

/**
 * Load a forge artifact (ABI + creation bytecode) at runtime by path
 * resolution — no static imports, so tsconfig rootDir stays intact and the
 * same code works under tsx (src) and node (dist).
 */
export async function loadArtifact(contractFile: string, contractName?: string): Promise<ContractArtifact> {
  const name = contractName ?? contractFile.replace(/\.sol$/, '');
  const key = `${contractFile}:${name}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // src/tools/nft -> mcp-server root is 3 levels up; dist mirrors src depth.
  const modDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(modDir, '..', '..', '..', 'contracts', 'out', `${contractFile}`, `${name}.json`),
    join(modDir, '..', '..', '..', '..', 'contracts', 'out', `${contractFile}`, `${name}.json`),
    join(process.cwd(), 'packages', 'contracts', 'out', `${contractFile}`, `${name}.json`),
  ];
  let lastErr: unknown = null;
  for (const p of candidates) {
    try {
      const raw = JSON.parse(await fs.readFile(p, 'utf8')) as {
        abi?: Array<Record<string, unknown>>;
        bytecode?: { object?: string };
      };
      if (!raw.abi || !raw.bytecode?.object) throw new Error(`artifact at ${p} lacks abi/bytecode`);
      const artifact: ContractArtifact = { abi: raw.abi, bytecode: raw.bytecode.object as `0x${string}` };
      cache.set(key, artifact);
      return artifact;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `Contract artifact ${contractFile}:${name} not found. Run \`forge build\` in packages/contracts. (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`,
  );
}
