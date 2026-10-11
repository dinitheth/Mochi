import type { Env } from './env.js';

export function getLendingPool(env: Env): `0x${string}` | null {
  const fallback = '0x88569f3B17448872A55Ee36685BcE6B006dd803A'; // V2 (true build, dust-lock fix)
  const addr = (env.LENDING_POOL_ADDRESS || fallback || '') as string;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
  return addr as `0x${string}`;
}
