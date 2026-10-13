import { NextResponse } from 'next/server';
import { getApproval, pollStatus } from '@/lib/approvals';
import { dashboardActorFromRequest, isDashboardSessionRequest, isMcpApprovalRequest, unauthorized } from '@/lib/auth';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isMcpApprovalRequest(req) && !isDashboardSessionRequest(req)) return unauthorized();
  const { id } = await params;
  const rec = getApproval(id);
  if (!rec) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  if (!isMcpApprovalRequest(req)) {
    const actor = dashboardActorFromRequest(req);
    if (!actor || rec.userId !== (actor.walletUserId ?? actor.id)) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  }
  // Polled by the MCP server — keep the shape stable.
  const polled = pollStatus(id);
  return NextResponse.json({ ok: true, status: polled?.status ?? rec.status, approval: rec });
}
