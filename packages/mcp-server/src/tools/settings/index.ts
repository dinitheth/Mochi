import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import { getPolicy, setPolicy } from '../../config/policy.js';
import { auditLog } from '../../middleware/audit-log.js';
import { addTool, formatTokenUnits, textResult } from '../shared.js';

/** Per-user auto-approve switch: "don't ask me, just do it" — capped and revocable. */
export function registerSettingsTools(server: McpServer, env: Env): void {
  void env;
  addTool(
    server,
    'settings_set_auto_approve',
    'Enable or disable auto-approve: when ON, the agent executes matching transactions immediately without dashboard approval, up to a per-transaction cap. Default OFF. Every auto-decision is audit-logged.',
    {
      enabled: z.boolean().describe('true = execute without asking, false = require human approval'),
      maxMON: z.string().optional().describe('Max single-transaction value in MON. Omit to keep the current cap.'),
      actions: z.array(z.string()).optional().describe('Limit to these action names (e.g. ["transaction_send_mon"]). Omit for all actions.'),
      userId: z.string().optional().describe('User/session id owning this policy'),
    },
    async ({ enabled, maxMON, actions, userId }: { enabled: boolean; maxMON?: string; actions?: string[]; userId?: string }) => {
      try {
        const current = await getPolicy(userId);
        let maxWei = current.maxWei;
        let capLabel = formatTokenUnits(BigInt(current.maxWei), 18);
        if (maxMON !== undefined) {
          try {
            const [w, f = ''] = maxMON.split('.');
            if (!/^\d+$/.test(w) || (f && !/^\d+$/.test(f))) throw new Error('bad amount');
            maxWei = (BigInt(w) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18) || '0')).toString();
            capLabel = maxMON;
          } catch {
            throw new Error(`Invalid maxMON "${maxMON}".`);
          }
        }
        const policy = await setPolicy(userId, { autoApprove: enabled, maxWei, ...(actions ? { actions } : {}) });
        await auditLog({ tool: 'settings_set_auto_approve', userId, result: 'ok', params: { enabled, maxMON } });
        return textResult({
          ok: true,
          autoApprove: policy.autoApprove,
          maxMON: capLabel,
          actions: policy.actions,
          summary: enabled
            ? `Auto-approve ON: transactions up to ${capLabel} MON execute immediately${actions?.length ? ` for ${actions.join(', ')}` : ''}. Say the word and I turn it off.`
            : 'Auto-approve OFF: every gated transaction needs your dashboard approval again.',
        });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  addTool(
    server,
    'settings_get_policy',
    'Show the current auto-approve policy: on/off, per-transaction cap, scoped actions.',
    {
      userId: z.string().optional().describe('User/session id owning this policy'),
    },
    async ({ userId }: { userId?: string }) => {
      const policy = await getPolicy(userId);
      const capMON = formatTokenUnits(BigInt(policy.maxWei), 18);
      return textResult({
        ok: true,
        autoApprove: policy.autoApprove,
        maxMON: capMON,
        maxWei: policy.maxWei,
        actions: policy.actions,
        updatedAt: policy.updatedAt,
        summary: policy.autoApprove
          ? `Auto-approve is ON up to ${capMON} MON per transaction${policy.actions ? ` for: ${policy.actions.join(', ')}` : ' (all actions)'}.`
          : 'Auto-approve is OFF — gated actions wait for your dashboard approval.',
      });
    },
  );
}
