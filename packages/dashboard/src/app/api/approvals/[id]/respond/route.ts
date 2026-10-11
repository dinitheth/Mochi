import { NextRequest, NextResponse } from 'next/server';
import { decideApproval, getApproval } from '@/lib/approvals';
import { isDashboardSessionRequest, unauthorized } from '@/lib/auth';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isDashboardSessionRequest(req)) return unauthorized();
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { decision?: string };
  const decision = String(body.decision ?? '').toLowerCase();
  if (decision !== 'approved' && decision !== 'rejected') {
    return NextResponse.json({ ok: false, error: 'decision must be "approved" or "rejected"' }, { status: 400 });
  }
  const rec = getApproval(id);
  if (!rec) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  if (rec.status !== 'pending') {
    return NextResponse.json({ ok: false, error: `already ${rec.status}`, approval: rec }, { status: 409 });
  }
  const updated = decideApproval(id, decision);
  return NextResponse.json({ ok: true, approval: updated });
}
