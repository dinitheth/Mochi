import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticateDashboardPassword, createDashboardSession, dashboardApproverCount, dashboardActorFromRequest, getDashboardSessionActor } from '../packages/dashboard/src/lib/auth.js';
import { createApproval, decideApproval, pollStatus } from '../packages/dashboard/src/lib/approvals.js';

afterEach(() => vi.unstubAllEnvs());

describe('team dashboard authentication', () => {
  it('authenticates configured distinct team members and signs their roles into the session', () => {
    vi.stubEnv('DASHBOARD_SESSION_SECRET', 'a-long-random-session-signing-secret-for-tests');
    vi.stubEnv('DASHBOARD_TEAM_MEMBERS', JSON.stringify([
      { id: 'owner', password: 'owner-password-long-test', role: 'admin' },
      { id: 'finance', password: 'finance-password-long-test', role: 'approver' },
      { id: 'staff', password: 'staff-password-long-test', role: 'preparer' },
      { id: 'bad', password: 'short', role: 'approver' },
    ]));
    expect(dashboardApproverCount()).toBe(2);
    expect(authenticateDashboardPassword('finance-password-long-test')).toEqual({ id: 'finance', role: 'approver' });
    expect(authenticateDashboardPassword('short')).toBeNull();
    const session = createDashboardSession({ id: 'finance', role: 'approver' });
    expect(session).not.toBeNull();
    expect(getDashboardSessionActor(session!.value)).toEqual({ id: 'finance', role: 'approver' });
    expect(getDashboardSessionActor(`${session!.value}tampered`)).toBeNull();
    const request = new Request('https://dashboard.test/', { headers: { cookie: `monadmcp_dashboard_session=${session!.value}` } });
    expect(dashboardActorFromRequest(request)).toEqual({ id: 'finance', role: 'approver' });
  });

  it('preserves the original single-password admin setup when no team list is configured', () => {
    vi.stubEnv('DASHBOARD_SESSION_SECRET', 'a-long-random-session-signing-secret-for-tests');
    vi.stubEnv('DASHBOARD_TEAM_MEMBERS', '');
    vi.stubEnv('DASHBOARD_PASSWORD', 'owner-test-password');
    expect(dashboardApproverCount()).toBe(1);
    expect(authenticateDashboardPassword('owner-test-password')).toEqual({ id: 'owner', role: 'admin' });
  });
});

describe('distinct approval quorum', () => {
  it('keeps a request pending until separate approvers vote and rejects duplicate votes', () => {
    const record = createApproval({ requestId: `test-${Date.now()}`, action: 'payments_send_payout_batch', details: {}, valueWei: '0', requiredApprovals: 2 });
    expect(record.status).toBe('pending');
    const first = decideApproval(record.requestId, 'approved', 'owner');
    expect(first?.status).toBe('pending');
    expect(first?.decisions).toHaveLength(1);
    expect(decideApproval(record.requestId, 'approved', 'owner')?.decisions).toHaveLength(1);
    const second = decideApproval(record.requestId, 'approved', 'finance');
    expect(second?.status).toBe('approved');
    expect(second?.decisions).toHaveLength(2);
    expect(pollStatus(record.requestId)).toEqual({ status: 'approved' });
  });

  it('lets any distinct approver reject immediately', () => {
    const record = createApproval({ requestId: `reject-${Date.now()}`, action: 'payments_refund_request', details: {}, valueWei: '0', requiredApprovals: 3 });
    expect(decideApproval(record.requestId, 'rejected', 'approver-1')?.status).toBe('rejected');
  });
});
