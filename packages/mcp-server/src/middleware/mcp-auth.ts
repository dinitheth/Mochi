import { timingSafeEqual } from 'node:crypto';

/** Validate a legacy shared bearer token. Public /mcp does not use this helper. */
export function isAuthorizedMcpRequest(authorization: string | undefined, expectedToken: string): boolean {
  if (!authorization || !expectedToken) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return false;
  const supplied = Buffer.from(match[1], 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
