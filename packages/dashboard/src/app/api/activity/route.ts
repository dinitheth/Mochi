import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { isDashboardSessionRequest, unauthorized } from '@/lib/auth';

export async function GET(req: Request) {
  if (!isDashboardSessionRequest(req)) return unauthorized();
  const candidates = [
    join(process.cwd(), '..', 'mcp-server', 'audit-log.jsonl'),
    join(process.cwd(), 'audit-log.jsonl'),
  ];
  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      const entries = lines.slice(-50).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).filter(Boolean);
      return NextResponse.json({ ok: true, entries: entries.reverse() });
    } catch {
      continue;
    }
  }
  return NextResponse.json({ ok: true, entries: [] });
}
