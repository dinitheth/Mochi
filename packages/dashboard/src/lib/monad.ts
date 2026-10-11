export const NETWORKS = {
  testnet: {
    chainId: 10143,
    name: 'Monad Testnet',
    rpcUrl: process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz',
    explorerUrl: 'https://testnet.monadscan.com',
  },
  mainnet: {
    chainId: 143,
    name: 'Monad',
    rpcUrl: process.env.MONAD_MAINNET_RPC_URL || 'https://rpc.monad.xyz',
    explorerUrl: 'https://monadscan.com',
  },
} as const;

export type NetworkName = keyof typeof NETWORKS;

export function activeNetwork(): NetworkName {
  return process.env.MONAD_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
}

async function rpc<T>(rpcUrl: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status}`);
  const data = (await res.json()) as { result?: T; error?: { message?: string } };
  if (data.error) throw new Error(`RPC ${method} error: ${data.error.message}`);
  return data.result as T;
}

export async function ethBlockNumber(rpcUrl: string): Promise<bigint> {
  return BigInt(await rpc<string>(rpcUrl, 'eth_blockNumber'));
}

export async function ethGasPrice(rpcUrl: string): Promise<bigint> {
  return BigInt(await rpc<string>(rpcUrl, 'eth_gasPrice'));
}

export async function ethGetBalance(rpcUrl: string, address: string): Promise<bigint> {
  return BigInt(await rpc<string>(rpcUrl, 'eth_getBalance', [address, 'latest']));
}

export async function ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
  return rpc<string>(rpcUrl, 'eth_call', [{ to, data }, 'latest']);
}

export async function ethChainNow(rpcUrl: string): Promise<number> {
  const block = await rpc<{ timestamp?: string }>(rpcUrl, 'eth_getBlockByNumber', ['latest', false]);
  return block?.timestamp ? parseInt(block.timestamp, 16) : Math.floor(Date.now() / 1000);
}

export function weiToMon(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 2).padEnd(2, '0');
  return `${whole}.${frac}`;
}

export function weiToGwei(wei: bigint): string {
  const whole = wei / 10n ** 9n;
  const frac = (wei % 10n ** 9n).toString().padStart(9, '0').replace(/0+$/, '').slice(0, 2);
  return frac ? `${whole}.${frac}` : whole.toString();
}
