export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalRecord {
  requestId: string;
  userId: string;
  action: string;
  details: Record<string, unknown>;
  valueWei: string;
  reason: string | null;
  timestamp: number;
  status: ApprovalStatus;
  decidedAt: number | null;
  requiredApprovals: number;
  decisions: Array<{ actorId: string; decision: 'approved' | 'rejected'; decidedAt: number }>;
}

const store = new Map<string, ApprovalRecord>();

function gc(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now - v.timestamp > 30 * 60 * 1000) store.delete(k);
    if (v.status === 'pending' && now - v.timestamp > 5 * 60 * 1000) {
      v.status = 'expired';
    }
  }
}

export function createApproval(input: {
  requestId: string;
  userId?: string;
  action: string;
  details: Record<string, unknown>;
  valueWei: string;
  reason?: string | null;
  timestamp?: number;
  requiredApprovals?: number;
}): ApprovalRecord {
  gc();
  const rec: ApprovalRecord = {
    requestId: input.requestId,
    userId: input.userId ?? 'owner',
    action: input.action,
    details: input.details ?? {},
    valueWei: input.valueWei,
    reason: input.reason ?? null,
    timestamp: input.timestamp ?? Date.now(),
    status: 'pending',
    decidedAt: null,
    requiredApprovals: Math.max(1, Math.min(10, Math.floor(input.requiredApprovals ?? 1))),
    decisions: [],
  };
  store.set(rec.requestId, rec);
  return rec;
}

export function getApproval(id: string): ApprovalRecord | null {
  gc();
  return store.get(id) ?? null;
}

export function listApprovals(userId?: string): ApprovalRecord[] {
  gc();
  return [...store.values()].filter((record) => userId === undefined || record.userId === userId).sort((a, b) => b.timestamp - a.timestamp);
}

export function decideApproval(id: string, decision: 'approved' | 'rejected', actorId = 'owner'): ApprovalRecord | null {
  const rec = store.get(id);
  if (!rec || rec.status !== 'pending') return rec ?? null;
  if (rec.decisions.some((entry) => entry.actorId === actorId)) return rec;
  const decidedAt = Date.now();
  rec.decisions.push({ actorId, decision, decidedAt });
  if (decision === 'rejected') {
    rec.status = 'rejected';
    rec.decidedAt = decidedAt;
  } else if (rec.decisions.filter((entry) => entry.decision === 'approved').length >= rec.requiredApprovals) {
    rec.status = 'approved';
    rec.decidedAt = decidedAt;
  }
  return rec;
}

/** Status view polled by the MCP server. Expired/timeout counts as rejected (fail closed). */
export function pollStatus(id: string): { status: ApprovalStatus } | null {
  const rec = getApproval(id);
  if (!rec) return null;
  if (rec.status === 'expired') return { status: 'rejected' };
  return { status: rec.status };
}
