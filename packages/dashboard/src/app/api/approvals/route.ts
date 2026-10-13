import { NextRequest, NextResponse } from 'next/server';
import { createApproval, listApprovals } from '@/lib/approvals';
import { dashboardActorFromRequest, dashboardApproverCount, isDashboardSessionRequest, isMcpApprovalRequest, unauthorized } from '@/lib/auth';

export async function GET(req: NextRequest) {
  if (!isDashboardSessionRequest(req)) return unauthorized();
  const viewer = dashboardActorFromRequest(req);
  if (!viewer) return unauthorized();
  return NextResponse.json({ ok: true, approvals: listApprovals(viewer.walletUserId ?? viewer.id), viewer });
}

export async function POST(req: NextRequest) {
  if (!isMcpApprovalRequest(req)) return unauthorized();
  try {
    const body = (await req.json()) as {
      requestId?: string;
      userId?: string;
      action?: string;
      details?: Record<string, unknown>;
      valueWei?: string;
      reason?: string | null;
      timestamp?: number;
      requiredApprovals?: number;
    };
    if (!body.requestId || !body.action) {
      return NextResponse.json({ ok: false, error: 'requestId and action are required' }, { status: 400 });
    }
    const rawQuorum = body.requiredApprovals ?? 1;
    if (!Number.isInteger(rawQuorum) || rawQuorum < 1 || rawQuorum > 10) {
      return NextResponse.json({ ok: false, error: 'requiredApprovals must be an integer from 1 to 10.' }, { status: 400 });
    }
    const requiredApprovals = rawQuorum;
    if (requiredApprovals > dashboardApproverCount()) {
      return NextResponse.json({ ok: false, error: `Approval quorum requires ${requiredApprovals} distinct approvers, but only ${dashboardApproverCount()} are configured.` }, { status: 400 });
    }
    const rec = createApproval({
      requestId: body.requestId,
      userId: body.userId,
      action: body.action,
      details: body.details ?? {},
      valueWei: body.valueWei ?? '0',
      reason: body.reason ?? null,
      timestamp: body.timestamp,
      requiredApprovals,
    });
    return NextResponse.json({ ok: true, approval: rec }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
