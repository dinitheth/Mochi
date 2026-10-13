import { NextRequest, NextResponse } from 'next/server';
import { decideApproval, getApproval } from '@/lib/approvals';
import { dashboardActorFromRequest, isDashboardSessionRequest, unauthorized } from '@/lib/auth';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isDashboardSessionRequest(req)) return unauthorized();
  const actor = dashboardActorFromRequest(req);
  if (!actor || !['admin', 'approver'].includes(actor.role)) {
    return NextResponse.json({ ok: false, error: 'Only configured approvers can decide payment requests.' }, { status: 403 });
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { decision?: string };
  const decision = String(body.decision ?? '').toLowerCase();
  if (decision !== 'approved' && decision !== 'rejected') {
    return NextResponse.json({ ok: false, error: 'decision must be "approved" or "rejected"' }, { status: 400 });
  }
  const rec = getApproval(id);
  if (!rec) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  if (rec.userId !== (actor.walletUserId ?? actor.id)) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  if (rec.status !== 'pending') {
    return NextResponse.json({ ok: false, error: `already ${rec.status}`, approval: rec }, { status: 409 });
  }
  if (rec.decisions.some((entry) => entry.actorId === actor.id)) {
    return NextResponse.json({ ok: false, error: 'This approver has already voted on this request.', approval: rec }, { status: 409 });
  }
  const updated = decideApproval(id, decision, actor.id);
  return NextResponse.json({ ok: true, approval: updated, remainingApprovals: Math.max(0, (updated?.requiredApprovals ?? 1) - (updated?.decisions.filter((entry) => entry.decision === 'approved').length ?? 0)) });
}
