import { NextRequest, NextResponse } from 'next/server';
import { createApproval, listApprovals } from '@/lib/approvals';
import { isDashboardSessionRequest, isMcpApprovalRequest, unauthorized } from '@/lib/auth';

export async function GET(req: NextRequest) {
  if (!isDashboardSessionRequest(req)) return unauthorized();
  return NextResponse.json({ ok: true, approvals: listApprovals() });
}

export async function POST(req: NextRequest) {
  if (!isMcpApprovalRequest(req)) return unauthorized();
  try {
    const body = (await req.json()) as {
      requestId?: string;
      action?: string;
      details?: Record<string, unknown>;
      valueWei?: string;
      reason?: string | null;
      timestamp?: number;
    };
    if (!body.requestId || !body.action) {
      return NextResponse.json({ ok: false, error: 'requestId and action are required' }, { status: 400 });
    }
    const rec = createApproval({
      requestId: body.requestId,
      action: body.action,
      details: body.details ?? {},
      valueWei: body.valueWei ?? '0',
      reason: body.reason ?? null,
      timestamp: body.timestamp,
    });
    return NextResponse.json({ ok: true, approval: rec }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
