import { NextRequest, NextResponse } from 'next/server';
import { createDashboardSession, SESSION_COOKIE, verifyDashboardPassword } from '@/lib/auth';

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { password?: string };
  if (!body.password || !verifyDashboardPassword(body.password)) {
    return NextResponse.json({ ok: false, error: 'Invalid dashboard password.' }, { status: 401 });
  }
  const session = createDashboardSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'DASHBOARD_SESSION_SECRET is not configured.' }, { status: 503 });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, session.value, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: session.maxAge,
  });
  return response;
}
