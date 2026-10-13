import { NextResponse } from 'next/server';
import { activeNetwork, ethBlockNumber, ethGasPrice, NETWORKS, weiToGwei } from '@/lib/monad';

export async function GET() {
  const network = activeNetwork();
  const meta = NETWORKS[network];
  try {
    const [block, gas] = await Promise.all([ethBlockNumber(meta.rpcUrl), ethGasPrice(meta.rpcUrl)]);
    return NextResponse.json({
      ok: true,
      network,
      chainId: meta.chainId,
      latestBlock: block.toString(),
      gasPriceWei: gas.toString(),
      gasPriceGwei: weiToGwei(gas),
      explorerUrl: meta.explorerUrl,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, network, error: 'Unable to read network status from the configured RPC.' },
      { status: 502 },
    );
  }
}
