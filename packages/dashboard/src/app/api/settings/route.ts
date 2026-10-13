import { NextRequest, NextResponse } from 'next/server';
import { getPolicy, setPolicy, monToWei, weiToMon2 } from '@/lib/policy';
import { dashboardActorFromRequest, isDashboardSessionRequest, unauthorized } from '@/lib/auth';

export async function GET(req: NextRequest) {
  if (!isDashboardSessionRequest(req)) return unauthorized();
  const actor = dashboardActorFromRequest(req);
  if (!actor) return unauthorized();
  const userId = actor.walletUserId ?? actor.id;
  const policy = await getPolicy(userId);
  return NextResponse.json({ ok: true, ...policy, maxMON: weiToMon2(policy.maxWei) });
}

export async function POST(req: NextRequest) {
  if (!isDashboardSessionRequest(req)) return unauthorized();
  const actor = dashboardActorFromRequest(req);
  if (!actor) return unauthorized();
  try {
    const body = (await req.json()) as { autoApprove?: boolean; maxMON?: string };
    const patch: { autoApprove?: boolean; maxWei?: string } = {};
    if (typeof body.autoApprove === 'boolean') patch.autoApprove = body.autoApprove;
    if (body.maxMON !== undefined) patch.maxWei = monToWei(body.maxMON);
    const policy = await setPolicy(actor.walletUserId ?? actor.id, patch);
    return NextResponse.json({ ok: true, ...policy, maxMON: weiToMon2(policy.maxWei) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
