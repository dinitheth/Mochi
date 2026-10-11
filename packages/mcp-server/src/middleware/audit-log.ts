import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AuditEntry {
  ts?: string;
  tool: string;
  userId?: string;
  intent?: string;
  params?: Record<string, unknown>;
  result?: 'ok' | 'error' | 'approval-required' | 'rejected';
  txHash?: string;
  error?: string;
}

const LOG_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'audit-log.jsonl');

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/private[_-]?key|secret|mnemonic|seed/i.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = sanitize(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'bigint') return `${value.toString()}n`;
  return value;
}

export async function auditLog(entry: AuditEntry): Promise<void> {
  try {
    await mkdir(dirname(LOG_FILE), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...(sanitize(entry) as object) });
    await appendFile(LOG_FILE, line + '\n', 'utf8');
  } catch (err) {
    console.error('[audit] failed to write log:', err instanceof Error ? err.message : err);
  }
}

export async function readRecentAudit(limit = 50): Promise<AuditEntry[]> {
  try {
    const raw = await readFile(LOG_FILE, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l) as AuditEntry);
  } catch {
    return [];
  }
}

export async function clearAuditLog(): Promise<void> {
  await writeFile(LOG_FILE, '', 'utf8');
}
