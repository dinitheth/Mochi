import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'monadmcp_dashboard_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
export type DashboardRole = 'admin' | 'approver' | 'preparer' | 'viewer';
export interface DashboardMember { id: string; password: string; role: DashboardRole }

function teamMembers(): DashboardMember[] {
  const raw = process.env.DASHBOARD_TEAM_MEMBERS;
  if (!raw) {
    const password = process.env.DASHBOARD_PASSWORD;
    return password ? [{ id: 'owner', password, role: 'admin' }] : [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter((member): member is DashboardMember => Boolean(member && typeof member === 'object'
      && typeof (member as DashboardMember).id === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test((member as DashboardMember).id)
      && typeof (member as DashboardMember).password === 'string' && (member as DashboardMember).password.length >= 12
      && ['admin', 'approver', 'preparer', 'viewer'].includes((member as DashboardMember).role)));
    const ids = new Set<string>();
    return valid.filter((member) => ids.has(member.id) ? false : (ids.add(member.id), true));
  } catch { return []; }
}

export function dashboardApproverCount(): number {
  return teamMembers().filter((member) => member.role === 'admin' || member.role === 'approver').length;
}

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
  return authenticateDashboardPassword(password) !== null;
}

export function authenticateDashboardPassword(password: string): Omit<DashboardMember, 'password'> | null {
  const member = teamMembers().find((candidate) => safeEqual(password, candidate.password));
  return member ? { id: member.id, role: member.role } : null;
}

export interface DashboardActor { id: string; role: DashboardRole; provider?: 'cognito'; walletUserId?: string }

export function createDashboardSession(actor: DashboardActor = { id: 'owner', role: 'admin' }): { value: string; maxAge: number } | null {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ expiry, ...actor })).toString('base64url');
  const sig = signature(payload);
  return sig ? { value: `${payload}.${sig}`, maxAge: SESSION_TTL_SECONDS } : null;
}

export function getDashboardSessionActor(value?: string): DashboardActor | null {
  if (!value) return null;
  const [payload, supplied, extra] = value.split('.');
  if (!payload || !supplied || extra !== undefined) return null;
  const expected = signature(payload);
  if (!expected || !safeEqual(supplied, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { expiry?: number; id?: string; role?: DashboardRole; provider?: 'cognito'; walletUserId?: string };
    if (!parsed.expiry || parsed.expiry <= Math.floor(Date.now() / 1000) || !parsed.id || !['admin', 'approver', 'preparer', 'viewer'].includes(parsed.role ?? '')) return null;
    if (parsed.provider === 'cognito') {
      if (!parsed.id.startsWith('user_') || parsed.role !== 'admin'
        || (parsed.walletUserId !== undefined && parsed.walletUserId !== 'owner')) return null;
      return { id: parsed.id, role: parsed.role!, provider: 'cognito', ...(parsed.walletUserId ? { walletUserId: parsed.walletUserId } : {}) };
    }
    const member = teamMembers().find((candidate) => candidate.id === parsed.id);
    if (!member || member.role !== parsed.role) return null;
    return { id: parsed.id, role: parsed.role! };
  } catch { return null; }
}

export function isValidDashboardSession(value?: string): boolean {
  return getDashboardSessionActor(value) !== null;
}

export function isDashboardSessionRequest(request: Request): boolean {
  const cookie = request.headers.get('cookie') ?? '';
  const hit = cookie.split(';').map((v) => v.trim()).find((v) => v.startsWith(`${SESSION_COOKIE}=`));
  return isValidDashboardSession(hit?.slice(SESSION_COOKIE.length + 1));
}

export function dashboardActorFromRequest(request: Request): DashboardActor | null {
  const cookie = request.headers.get('cookie') ?? '';
  const hit = cookie.split(';').map((v) => v.trim()).find((v) => v.startsWith(`${SESSION_COOKIE}=`));
  return getDashboardSessionActor(hit?.slice(SESSION_COOKIE.length + 1));
}

export function isMcpApprovalRequest(request: Request): boolean {
  const expected = process.env.APPROVAL_API_TOKEN;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  return Boolean(expected && supplied && safeEqual(supplied, expected));
}

export function unauthorized() {
  return Response.json({ ok: false, error: 'Authentication required.' }, { status: 401 });
}
