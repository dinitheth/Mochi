import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import { explorerAddressUrl } from '../../config/monad.js';
import { listContacts, removeContact, saveContact } from '../../config/contacts.js';
import { auditLog } from '../../middleware/audit-log.js';
import { addTool, textResult } from '../shared.js';

/**
 * Phone-book for wallets: `/save sam 0x...` style usage via chat —
 * "save sam as 0x...", then "send 1 MON to sam".
 */
export function registerContactTools(server: McpServer, env: Env): void {
  void env;
  addTool(
    server,
    'contacts_save',
    'Save a contact: link a person name to a wallet address so you can say "send to sam" instead of pasting 0x addresses.',
    {
      name: z.string().describe('Person name, e.g. "sam"'),
      address: z.string().describe('Wallet address (0x...)'),
      userId: z.string().optional().describe('Owner of this address book entry'),
    },
    async ({ name, address, userId }: { name: string; address: string; userId?: string }) => {
      try {
        const { contact, updated } = await saveContact(userId, name, address);
        await auditLog({ tool: 'contacts_save', userId, result: 'ok', params: { name: contact.name } });
        return textResult({
          ok: true,
          name: contact.name,
          address: contact.address,
          updated,
          explorerUrl: explorerAddressUrl(env, contact.address),
          summary: `${updated ? 'Updated' : 'Saved'} contact "${contact.name}" → ${contact.address}. You can now say "send to ${contact.name}".`,
        });
      } catch (err) {
        return textResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  addTool(
    server,
    'contacts_list',
    'List all saved contacts (name → address).',
    {
      userId: z.string().optional().describe('Owner of the address book'),
    },
    async ({ userId }: { userId?: string }) => {
      const contacts = await listContacts(userId);
      return textResult({
        ok: true,
        count: contacts.length,
        contacts: contacts.map((c) => ({ name: c.name, address: c.address, explorerUrl: explorerAddressUrl(env, c.address) })),
        summary: contacts.length ? contacts.map((c) => `${c.name} → ${c.address}`).join(', ') : 'Address book is empty. Save one with contacts_save.',
      });
    },
  );

  addTool(
    server,
    'contacts_remove',
    'Remove a contact by name.',
    {
      name: z.string().describe('Contact name to remove'),
      userId: z.string().optional().describe('Owner of the address book'),
    },
    async ({ name, userId }: { name: string; userId?: string }) => {
      const removed = await removeContact(userId, name);
      await auditLog({ tool: 'contacts_remove', userId, result: removed ? 'ok' : 'error', params: { name }, error: removed ? undefined : 'not found' });
      return textResult(
        removed
          ? { ok: true, summary: `Removed contact "${name}".` }
          : { ok: false, error: `No contact named "${name}".` },
      );
    },
  );
}
