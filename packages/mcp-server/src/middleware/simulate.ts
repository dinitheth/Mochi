import { formatEther, formatGwei, getAddress, parseEther } from 'viem';
import type { Env } from '../config/env.js';
import { getPublicClient } from '../config/monad.js';

export interface SimResult {
  ok: boolean;
  /** eth_call + estimate passed (ignoring affordability). */
  callOk: boolean;
  verdict: 'SAFE_TO_SEND' | 'DO_NOT_SEND';
  reason: string | null;
  returnData: string | null;
  gasUnits: string | null;
  gasPriceGwei: string | null;
  feeWei: bigint;
  balanceWei: bigint;
}

export function shortRevert(message: string): string {
  const m = message.match(/reverted(?::\s*([^.\n]*))?/i) ?? message.match(/execution reverted(?::\s*([^\n]*))?/i);
  if (m && m[1]) return m[1].trim().slice(0, 300);
  return message.split('\n')[0].slice(0, 300);
}

/**
 * Dry-run a transaction: eth_call revert check + gas estimate + affordability.
 * Read-only. Shared by transaction_simulate and the pre-flight checks inside
 * nft_buy / defi_swap_tokens.
 */
export async function simulateTx(
  env: Env,
  args: { from: string; to: string; value?: bigint; data?: `0x${string}` },
): Promise<SimResult> {
  const client = getPublicClient(env);
  const from = getAddress(args.from);
  const to = getAddress(args.to);
  const valueWei = args.value ?? 0n;
  const tx = { account: from, to, value: valueWei, ...(args.data ? { data: args.data } : {}) };

  let callOk = true;
  let reason: string | null = null;
  let returnData: string | null = null;
  try {
    const out = await client.call({ ...tx, blockTag: 'latest' });
    returnData = (out.data as string | undefined) ?? null;
  } catch (e) {
    callOk = false;
    reason = e instanceof Error ? shortRevert(e.message) : String(e);
  }

  let gasUnits: string | null = null;
  let gasPriceWei: bigint | null = null;
  try {
    gasUnits = (await client.estimateGas(tx)).toString();
    gasPriceWei = await client.getGasPrice();
  } catch (e) {
    if (!reason) reason = e instanceof Error ? shortRevert(e.message) : String(e);
    callOk = false;
  }

  const balanceWei = await client.getBalance({ address: from }).catch(() => 0n);
  const feeWei = gasUnits && gasPriceWei ? BigInt(gasUnits) * gasPriceWei : 0n;
  const affordable = balanceWei >= valueWei + feeWei;
  const ok = callOk && affordable;
  return {
    ok,
    callOk,
    verdict: ok ? 'SAFE_TO_SEND' : 'DO_NOT_SEND',
    reason: ok ? null : (reason ?? `insufficient funds (need ${formatEther(valueWei + feeWei)} MON, hold ${formatEther(balanceWei)} MON)`),
    returnData,
    gasUnits,
    gasPriceGwei: gasPriceWei ? formatGwei(gasPriceWei) : null,
    feeWei,
    balanceWei,
  };
}

export function simSummary(sim: SimResult, what: string): string {
  if (sim.verdict === 'SAFE_TO_SEND') {
    return `Pre-flight passed for ${what}: fee ≈ ${formatEther(sim.feeWei)} MON, wallet holds ${formatEther(sim.balanceWei)} MON.`;
  }
  return `Pre-flight FAILED for ${what}: ${sim.reason}`;
}

export { formatEther, parseEther };
