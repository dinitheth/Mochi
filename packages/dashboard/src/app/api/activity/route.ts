import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { dashboardActorFromRequest, isDashboardSessionRequest, unauthorized } from '@/lib/auth';

export async function GET(req: Request) {
  if (!isDashboardSessionRequest(req)) return unauthorized();
  const actor = dashboardActorFromRequest(req);
  if (!actor) return unauthorized();
  const userId = actor.walletUserId ?? actor.id;
  const candidates = [
    join(process.cwd(), '..', 'mcp-server', 'audit-log.jsonl'),
    join(process.cwd(), 'audit-log.jsonl'),
  ];
  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      const entries = lines.map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
        .filter((entry) => (entry.userId ?? 'owner') === userId)
        .slice(-50);
      return NextResponse.json({ ok: true, entries: entries.reverse() });
    } catch {
      continue;
    }
  }
  return NextResponse.json({ ok: true, entries: [] });
}
