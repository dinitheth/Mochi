import type { Env } from '../config/env.js';

export function isOverSpendingLimit(valueWei: bigint, env: Env): boolean {
  return valueWei >= env.spendingLimitWei;
}

export function formatWeiAsMon(valueWei: bigint): string {
  const neg = valueWei < 0n;
  const abs = neg ? -valueWei : valueWei;
  const whole = abs / 10n ** 18n;
  const frac = abs % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '').slice(0, 6) || '0';
  return `${neg ? '-' : ''}${whole.toString()}.${fracStr}`;
}

export function spendingPolicyMessage(valueWei: bigint, env: Env): string {
  const mon = formatWeiAsMon(valueWei);
  if (isOverSpendingLimit(valueWei, env)) {
    return `Value ${mon} MON meets/exceeds the spending limit of ${formatWeiAsMon(env.spendingLimitWei)} MON — human approval required.`;
  }
  return `Value ${mon} MON is under the spending limit of ${formatWeiAsMon(env.spendingLimitWei)} MON — auto-approved by policy.`;
}
