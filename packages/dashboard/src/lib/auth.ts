import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'monadmcp_dashboard_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function signature(payload: string): string | null {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!secret) return null;
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function verifyDashboardPassword(password: string): boolean {
  const configured = process.env.DASHBOARD_PASSWORD;
  return Boolean(configured && safeEqual(password, configured));
}

export function createDashboardSession(): { value: string; maxAge: number } | null {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = String(expiry);
  const sig = signature(payload);
  return sig ? { value: `${payload}.${sig}`, maxAge: SESSION_TTL_SECONDS } : null;
}

export function isValidDashboardSession(value?: string): boolean {
  if (!value) return false;
  const [payload, supplied, extra] = value.split('.');
  if (!payload || !supplied || extra !== undefined || Number(payload) <= Math.floor(Date.now() / 1000)) return false;
  const expected = signature(payload);
  return Boolean(expected && safeEqual(supplied, expected));
}

export function isDashboardSessionRequest(request: Request): boolean {
  const cookie = request.headers.get('cookie') ?? '';
  const hit = cookie.split(';').map((v) => v.trim()).find((v) => v.startsWith(`${SESSION_COOKIE}=`));
  return isValidDashboardSession(hit?.slice(SESSION_COOKIE.length + 1));
}

export function isMcpApprovalRequest(request: Request): boolean {
  const expected = process.env.APPROVAL_API_TOKEN;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  return Boolean(expected && supplied && safeEqual(supplied, expected));
}

export function unauthorized() {
  return Response.json({ ok: false, error: 'Authentication required.' }, { status: 401 });
}
