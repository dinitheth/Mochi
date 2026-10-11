import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env.js';
import { getPolicy, policyAllows } from '../config/policy.js';
import { isOverSpendingLimit } from './spending-policy.js';

export type ApprovalDecision = 'approved' | 'rejected';

export interface ApprovalRequest {
  action: string;
  details: Record<string, unknown>;
  valueWei: bigint;
  env: Env;
  /** Force the approval flow even when under the spending limit (e.g. NFT buys). */
  forceApproval?: boolean;
  reason?: string;
  userId?: string;
}

export interface ApprovalOutcome {
  decision: ApprovalDecision;
  /** true when the value was under the limit and no human was involved */
  autoApproved: boolean;
  /** true when the user's auto-approve switch covered this action */
  policyApproved?: boolean;
  requestId: string | null;
  message: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function checkApprovalStatus(requestId: string, env: Env): Promise<ApprovalDecision | 'pending'> {
  const base = env.APPROVAL_WEBHOOK_URL.replace(/\/$/, '');
  // Dashboard exposes GET /api/approvals/:id
  const candidates = [`${base}/${requestId}`, `${base}?id=${encodeURIComponent(requestId)}`];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: approvalHeaders(env) });
      if (!res.ok) continue;
      const data = (await res.json()) as { status?: string; decision?: string };
      const s = String(data.status ?? data.decision ?? '').toLowerCase();
      if (s === 'approved') return 'approved';
      if (s === 'rejected' || s === 'denied') return 'rejected';
      return 'pending';
    } catch {
      continue;
    }
  }
  return 'pending';
}

function approvalHeaders(env: Env): Record<string, string> {
  return {
    accept: 'application/json',
    ...(env.APPROVAL_API_TOKEN ? { authorization: `Bearer ${env.APPROVAL_API_TOKEN}` } : {}),
  };
}

/**
 * Human-in-the-loop gate. Under-limit actions auto-approve. Over-limit (or
 * forced) actions POST to the dashboard webhook and poll for a decision.
 * Poll timeout → rejected (fail closed).
 */
export async function approvalGate(req: ApprovalRequest): Promise<ApprovalOutcome> {
  const needsApproval = req.forceApproval === true || isOverSpendingLimit(req.valueWei, req.env);

  // Actions marked as mandatory human approvals cannot be overridden by the
  // general auto-approve policy.
  try {
    const policy = await getPolicy(req.userId);
    if (!req.forceApproval && policyAllows(policy, req.action, req.valueWei)) {
      return {
        decision: 'approved',
        autoApproved: true,
        policyApproved: true,
        requestId: null,
        message: `Auto-approved by user policy (cap ${policy.maxWei} wei). Disable anytime via settings_set_auto_approve.`,
      };
    }
  } catch {
    /* policy store unreadable → fall through to human gate (fail closed) */
  }

  if (!needsApproval) {
    return {
      decision: 'approved',
      autoApproved: true,
      requestId: null,
      message: `Auto-approved: ${req.valueWei.toString()} wei is under the spending limit.`,
    };
  }

  const requestId = randomUUID();
  const payload = {
    requestId,
    action: req.action,
    details: req.details,
    valueWei: req.valueWei.toString(),
    reason: req.reason ?? null,
    timestamp: Date.now(),
  };

  try {
    const response = await fetch(req.env.APPROVAL_WEBHOOK_URL, {
      method: 'POST',
      headers: { ...approvalHeaders(req.env), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      return {
        decision: 'rejected',
        autoApproved: false,
        requestId,
        message: `Approval service returned HTTP ${response.status}. Failing closed — transaction rejected.`,
      };
    }
  } catch (err) {
    return {
      decision: 'rejected',
      autoApproved: false,
      requestId,
      message: `Approval webhook unreachable (${err instanceof Error ? err.message : String(err)}). Failing closed — transaction rejected. Start the dashboard (packages/dashboard on :3001) and retry.`,
    };
  }

  const deadline = Date.now() + req.env.APPROVAL_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await checkApprovalStatus(requestId, req.env);
    if (status === 'approved') {
      return { decision: 'approved', autoApproved: false, requestId, message: `Human approved request ${requestId}.` };
    }
    if (status === 'rejected') {
      return { decision: 'rejected', autoApproved: false, requestId, message: `Human rejected request ${requestId}.` };
    }
    await sleep(2000);
  }

  return {
    decision: 'rejected',
    autoApproved: false,
    requestId,
    message: `Approval request ${requestId} timed out after ${Math.round(req.env.APPROVAL_POLL_TIMEOUT_MS / 1000)}s. Failing closed — transaction rejected.`,
  };
}
