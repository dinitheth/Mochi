import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Contact {
  name: string;
  address: string;
  addedAt: string;
  addressHistory?: Array<{ address: string; changedAt: string }>;
}

type Book = Record<string, Record<string, Contact>>; // userId -> lowerName -> contact

function bookPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'contacts.json');
}

async function readBook(): Promise<Book> {
  try {
    return JSON.parse(await fs.readFile(bookPath(), 'utf8')) as Book;
  } catch {
    return {};
  }
}

async function writeBook(book: Book): Promise<void> {
  await fs.writeFile(bookPath(), JSON.stringify(book, null, 2), 'utf8');
}

export function normalizeUser(userId?: string): string {
  return (userId ?? 'default').toLowerCase();
}

export function isEvmAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

export function validContactName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(name.trim());
}

export async function saveContact(userId: string | undefined, name: string, address: string): Promise<{ contact: Contact; updated: boolean }> {
  const clean = name.trim();
  if (!validContactName(clean)) {
    throw new Error(`Invalid name "${name}". Use 1-32 chars: letters, numbers, spaces, _ or -.`);
  }
  if (!isEvmAddress(address)) throw new Error(`Invalid address "${address}".`);
  const book = await readBook();
  const u = normalizeUser(userId);
  book[u] = book[u] ?? {};
  const previous = book[u][clean.toLowerCase()];
  const updated = Boolean(previous);
  const changedAt = new Date().toISOString();
  const addressHistory = previous?.addressHistory ? [...previous.addressHistory] : [];
  if (previous && previous.address.toLowerCase() !== address.toLowerCase()) addressHistory.push({ address: previous.address, changedAt });
  const contact: Contact = { name: clean, address, addedAt: previous?.addedAt ?? changedAt, ...(addressHistory.length ? { addressHistory } : {}) };
  book[u][clean.toLowerCase()] = contact;
  await writeBook(book);
  return { contact, updated };
}

export async function listContacts(userId?: string): Promise<Contact[]> {
  const book = await readBook();
  return Object.values(book[normalizeUser(userId)] ?? {}).sort((a, b) => a.name.localeCompare(b.name));
}

export async function removeContact(userId: string | undefined, name: string): Promise<boolean> {
  const book = await readBook();
  const u = normalizeUser(userId);
  const key = name.trim().toLowerCase();
  if (!book[u]?.[key]) return false;
  delete book[u][key];
  await writeBook(book);
  return true;
}

/**
 * Resolve a recipient that may be a raw 0x address or a saved contact name
 * (case-insensitive). Throws with a helpful hint when unknown.
 */
export async function resolveRecipient(userId: string | undefined, input: string): Promise<`0x${string}`> {
  const clean = input.trim();
  if (isEvmAddress(clean)) return clean as `0x${string}`;
  const book = await readBook();
  const hit = book[normalizeUser(userId)]?.[clean.toLowerCase()];
  if (hit) return hit.address as `0x${string}`;
  throw new Error(
    `Unknown recipient "${input}" — not an address and no saved contact by that name. Save one first: contacts_save { name: "${input}", address: "0x..." }.`,
  );
}
