import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Request, RequestHandler, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from '../config/env.js';
import { isKnownMcpTool, isReadOnlyMcpTool } from '../tools/shared.js';

export type OAuthRole = 'admin' | 'approver' | 'preparer' | 'viewer';
export interface OAuthActor { id: string; role: OAuthRole; authVersion: string; provider?: 'cognito'; walletUserId?: string }
export interface AccessClaims {
  iss: string; aud: string; sub: string; role: OAuthRole; authVersion: string; scope: string;
  iat: number; exp: number; jti: string; idp?: 'cognito'; walletUserId?: string;
}

interface AuthorizationCode {
  challenge: string; clientId: string; redirectUri: string; resource: string;
  scope: string[]; actor: OAuthActor; expiresAt: number;
}
interface RefreshGrant {
  clientId: string; resource: string; scope: string[]; actor: OAuthActor; expiresAt: number; familyId: string;
}
interface OAuthState {
  codes: Record<string, AuthorizationCode>;
  refresh: Record<string, RefreshGrant>;
  spentRefresh: Record<string, { familyId: string; expiresAt: number }>;
  usedAuthorizationRequests: Record<string, number>;
  clients: Record<string, { redirectUris: string[]; name?: string; createdAt: number }>;
  identityRequests: Record<string, { authorization: AuthorizationRequest; codeVerifier: string; nonce: string; expiresAt: number }>;
}
interface AuthorizationRequest {
  clientId: string; redirectUri: string; responseType: 'code'; state: string;
  challenge: string; resource: string; scope: string[]; csrfCookie: string; requestId: string; expiresAt: number;
  actor?: OAuthActor;
  cookieName?: string;
}

const READ_SCOPE = 'mochi:read';
const WRITE_SCOPE = 'mochi:write';
const AUTH_CODE_TTL_SECONDS = 5 * 60;
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const ALLOWED_SCOPES = new Set([READ_SCOPE, WRITE_SCOPE]);
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 8;
const loginFailures = new Map<string, { count: number; resetAt: number }>();
const registrationAttempts = new Map<string, { count: number; resetAt: number }>();

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function cognitoLegacyWalletOwnerId(
  identity: { email?: unknown; email_verified?: unknown },
  env: Pick<Env, 'COGNITO_LEGACY_OWNER_EMAIL'>,
): string | undefined {
  const email = typeof identity.email === 'string' ? identity.email.trim().toLowerCase() : '';
  const ownerEmail = env.COGNITO_LEGACY_OWNER_EMAIL.trim().toLowerCase();
  const emailVerified = identity.email_verified === true
    || (typeof identity.email_verified === 'string' && identity.email_verified.trim().toLowerCase() === 'true');
  return ownerEmail && emailVerified && email === ownerEmail ? 'owner' : undefined;
}

function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function oauthReady(env: Env): boolean {
  try {
    const publicUrl = new URL(env.MCP_PUBLIC_URL);
    const resource = new URL(env.MCP_OAUTH_RESOURCE);
    const redirect = new URL(env.MCP_OAUTH_REDIRECT_URI);
    return publicUrl.protocol === 'https:' && publicUrl.origin === env.MCP_PUBLIC_URL.replace(/\/$/, '')
      && resource.protocol === 'https:' && resource.origin === publicUrl.origin && resource.pathname === '/mcp'
      && redirect.protocol === 'https:' && env.DASHBOARD_SESSION_SECRET.length >= 32
      && ((env.MCP_OAUTH_CLIENT_ID.length >= 12 && env.MCP_OAUTH_CLIENT_SECRET.length >= 32
        && Boolean(env.DASHBOARD_PASSWORD || env.DASHBOARD_TEAM_MEMBERS))
        || (Boolean(env.COGNITO_ISSUER_URL && env.COGNITO_CLIENT_ID && env.COGNITO_DOMAIN && env.COGNITO_CALLBACK_URL)));
  } catch { return false; }
}

function issuer(env: Env): string { return env.MCP_PUBLIC_URL.replace(/\/$/, ''); }

export function createProtectedResourceMetadata(env: Env) {
  const resource = env.MCP_OAUTH_RESOURCE || (env.MCP_PUBLIC_URL ? `${issuer(env)}/mcp` : '');
  return {
    resource,
    authorization_servers: env.MCP_PUBLIC_URL ? [issuer(env)] : [],
    scopes_supported: [READ_SCOPE, WRITE_SCOPE],
    bearer_methods_supported: ['header'],
  };
}

export function createAuthorizationServerMetadata(env: Env) {
  const base = issuer(env);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    authorization_response_iss_parameter_supported: true,
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [READ_SCOPE, WRITE_SCOPE],
  };
}

function statePath(env: Env): string {
  const dataDir = env.MOCHI_DATA_DIR || join(process.cwd(), 'packages', 'mcp-server');
  return join(dataDir, 'oauth-state.json');
}

async function withState<T>(env: Env, operation: (state: OAuthState) => Promise<T> | T): Promise<T> {
  const file = statePath(env);
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let locked = false;
  const deadline = Date.now() + 8_000;
  while (!locked) {
    try {
      await mkdir(lock, { mode: 0o700 });
      locked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const lockStat = await stat(lock);
        if (Date.now() - lockStat.mtimeMs > 30_000) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch { continue; }
      if (Date.now() >= deadline) throw new Error('OAuth token store is busy. Retry shortly.');
      await new Promise((resolve) => setTimeout(resolve, 30 + Math.floor(Math.random() * 50)));
    }
  }

  try {
    let state: OAuthState = { codes: {}, refresh: {}, spentRefresh: {}, usedAuthorizationRequests: {}, clients: {}, identityRequests: {} };
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<OAuthState>;
      state = {
        codes: parsed.codes && typeof parsed.codes === 'object' ? parsed.codes : {},
        refresh: parsed.refresh && typeof parsed.refresh === 'object' ? parsed.refresh : {},
        spentRefresh: parsed.spentRefresh && typeof parsed.spentRefresh === 'object' ? parsed.spentRefresh : {},
        usedAuthorizationRequests: parsed.usedAuthorizationRequests && typeof parsed.usedAuthorizationRequests === 'object' ? parsed.usedAuthorizationRequests : {},
        clients: parsed.clients && typeof parsed.clients === 'object' ? parsed.clients : {},
        identityRequests: parsed.identityRequests && typeof parsed.identityRequests === 'object' ? parsed.identityRequests : {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const result = await operation(state);
    const now = Math.floor(Date.now() / 1000);
    for (const [key, grant] of Object.entries(state.codes)) if (grant.expiresAt <= now) delete state.codes[key];
    for (const [key, grant] of Object.entries(state.refresh)) if (grant.expiresAt <= now) delete state.refresh[key];
    for (const [key, grant] of Object.entries(state.spentRefresh)) if (grant.expiresAt <= now) delete state.spentRefresh[key];
    for (const [key, expiresAt] of Object.entries(state.usedAuthorizationRequests)) if (expiresAt <= now) delete state.usedAuthorizationRequests[key];
    for (const [key, grant] of Object.entries(state.identityRequests)) if (grant.expiresAt <= now) delete state.identityRequests[key];
    const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, file);
    return result;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

function currentMembers(env: Env): Array<{ id: string; password: string; role: OAuthRole }> {
  if (env.DASHBOARD_TEAM_MEMBERS) {
    try {
      const value: unknown = JSON.parse(env.DASHBOARD_TEAM_MEMBERS);
      if (!Array.isArray(value)) return [];
      const ids = new Set<string>();
      return value.filter((entry): entry is { id: string; password: string; role: OAuthRole } => {
        if (!entry || typeof entry !== 'object') return false;
        const member = entry as Record<string, unknown>;
        const valid = typeof member.id === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(member.id)
          && typeof member.password === 'string' && member.password.length >= 12
          && ['admin', 'approver', 'preparer', 'viewer'].includes(String(member.role));
        if (!valid || ids.has(member.id as string)) return false;
        ids.add(member.id as string);
        return true;
      });
    } catch { return []; }
  }
  return env.DASHBOARD_PASSWORD ? [{ id: 'owner', password: env.DASHBOARD_PASSWORD, role: 'admin' }] : [];
}

function authenticatePassword(password: string, env: Env): OAuthActor | null {
  const members = currentMembers(env);
  let actor: OAuthActor | null = null;
  // Compare against every configured credential to avoid leaking which account matched.
  for (const member of members) {
    if (constantTimeEqual(password, member.password) && !actor) actor = { id: member.id, role: member.role, authVersion: authVersion(member, env) };
  }
  return actor;
}

function authVersion(member: { id: string; password: string; role: OAuthRole }, env: Env): string {
  return hmac(env.DASHBOARD_SESSION_SECRET, `${member.id}:${member.role}:${hashToken(member.password)}`);
}

function parseCookies(request: Request): Record<string, string> {
  return Object.fromEntries((request.get('cookie') ?? '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([name]) => Boolean(name)));
}

function signAuthorizationRequest(serialized: string, env: Env): string {
  return `${base64url(serialized)}.${hmac(env.DASHBOARD_SESSION_SECRET, serialized)}`;
}

function verifyAuthorizationRequest(signed: string, env: Env): AuthorizationRequest | null {
  const [payload, signature, extra] = signed.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    if (!constantTimeEqual(signature, hmac(env.DASHBOARD_SESSION_SECRET, decoded))) return null;
    const request = JSON.parse(decoded) as AuthorizationRequest;
    return request.expiresAt > Math.floor(Date.now() / 1000) ? request : null;
  } catch { return null; }
}

async function consumeAuthorizationRequest(request: AuthorizationRequest, env: Env): Promise<boolean> {
  const key = hashToken(request.requestId);
  return withState(env, (state) => {
    if (state.usedAuthorizationRequests[key]) return false;
    state.usedAuthorizationRequests[key] = request.expiresAt;
    return true;
  });
}

async function createAuthorizationCode(request: AuthorizationRequest, actor: OAuthActor, env: Env): Promise<{ code: string; replayed: boolean } | null> {
  const requestKey = hashToken(request.requestId);
  // A browser can deliver the same consent POST more than once. Derive one
  // unguessable code per signed request so concurrent retries can redirect to
  // the same still-unused code without creating additional grants.
  const code = hmac(env.DASHBOARD_SESSION_SECRET, `oauth-authorization-code:${request.requestId}`);
  const codeKey = hashToken(code);
  return withState(env, (state) => {
    const now = Math.floor(Date.now() / 1000);
    const priorExpiry = state.usedAuthorizationRequests[requestKey];
    if (priorExpiry) {
      const existing = state.codes[codeKey];
      return existing && existing.expiresAt > now && priorExpiry > now ? { code, replayed: true } : null;
    }
    state.usedAuthorizationRequests[requestKey] = request.expiresAt;
    state.codes[codeKey] = {
      challenge: request.challenge, clientId: request.clientId, redirectUri: request.redirectUri,
      resource: request.resource, scope: request.scope, actor, expiresAt: now + AUTH_CODE_TTL_SECONDS,
    };
    return { code, replayed: false };
  });
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function page(title: string, content: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)} · Mochi</title><style>
    *{box-sizing:border-box}body{margin:0;background:#0b0914;color:#f6f3ff;font:16px system-ui,sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(100%,440px);background:#171321;border:1px solid #342b48;border-radius:20px;padding:28px;box-shadow:0 24px 80px #0008}h1{font-size:24px;margin:0 0 8px}.muted{color:#bbb2cc;line-height:1.5}label{display:block;margin:16px 0 7px;font-size:14px}input[type=password]{width:100%;padding:13px;border:1px solid #514663;border-radius:10px;background:#0d0b13;color:white;font-size:16px}button{width:100%;margin-top:20px;padding:13px;border:0;border-radius:10px;background:#7654f6;color:white;font-weight:700;font-size:15px;cursor:pointer}.scope{padding:12px;margin-top:10px;border-radius:10px;background:#211b2d}.error{color:#ff9c9c}</style><body><main class="card">${content}</main></body></html>`;
}

function formPage(request: AuthorizationRequest, env: Env, error?: string): string {
  const scopeLabels = request.scope.map((scope) => `<div class="scope"><strong>${scope === READ_SCOPE ? 'View Mochi data' : 'Prepare Mochi actions'}</strong><div class="muted">${scope === READ_SCOPE ? 'Read wallet, portfolio, market, and payment information.' : 'Prepare wallet and payment actions. Mochi approval rules still apply before transactions are submitted.'}</div></div>`).join('');
  const authControls = request.actor
    ? '<p class="muted">Signed in to Mochi. Review the requested access and approve to continue.</p><form method="post" action="/oauth/authorize/consent"><input type="hidden" name="authorization_request" value="' + htmlEscape(signAuthorizationRequest(JSON.stringify(request), env)) + '"><button name="decision" value="approve">Approve and connect</button><button name="decision" value="deny" formnovalidate style="background:#342d40">Cancel</button></form>'
    : '<form method="post" action="/oauth/authorize/consent"><input type="hidden" name="authorization_request" value="' + htmlEscape(signAuthorizationRequest(JSON.stringify(request), env)) + '"><label for="password">Mochi dashboard password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button name="decision" value="approve">Approve and connect</button><button name="decision" value="deny" formnovalidate style="background:#342d40">Cancel</button></form>';
  return page('Mochi sign-in', `<h1>Connect ChatGPT to Mochi</h1><p class="muted">Sign in to Mochi and review what this connection can access. You can disconnect Mochi from ChatGPT connector settings.</p>${scopeLabels}${error ? `<p class="error">${htmlEscape(error)}</p>` : ''}${authControls}`);
}

function oauthError(response: Response, status: number, error: string, description?: string): void {
  response.status(status).setHeader('Cache-Control', 'no-store').json({ error, ...(description ? { error_description: description } : {}) });
}

function bearerChallenge(env: Env): string {
  const metadata = `${issuer(env)}/.well-known/oauth-protected-resource`;
  return `Bearer resource_metadata="${metadata}", scope="${READ_SCOPE}"`;
}

export function registerOAuthRoutes(app: import('express').Express, env: Env): void {
  let callbackOrigin = '';
  try {
    const callback = new URL(env.MCP_OAUTH_REDIRECT_URI);
    if (callback.protocol === 'https:') callbackOrigin = ` ${callback.origin}`;
  } catch { /* OAuth readiness validation will reject an invalid callback URI. */ }
  app.use('/oauth', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // The consent form posts to this origin and then receives a 302 to ChatGPT's
    // configured callback. Chrome enforces form-action against that redirect too.
    res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${callbackOrigin}; base-uri 'none'; frame-ancestors 'none'`);
    next();
  });
  const resourceMetadata = createProtectedResourceMetadata(env);
  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.setHeader('Cache-Control', 'public, max-age=300').json(resourceMetadata));
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.setHeader('Cache-Control', 'public, max-age=300').json(resourceMetadata));
  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.setHeader('Cache-Control', 'public, max-age=300').json(createAuthorizationServerMetadata(env)));

  app.get('/oauth/identity/callback', asyncHandler(async (req, res) => {
    const stateKey = typeof req.query.state === 'string' ? req.query.state : '';
    const pending = await withState(env, (state) => {
      const item = state.identityRequests[stateKey];
      if (item) delete state.identityRequests[stateKey];
      return item ?? null;
    });
    if (!pending || pending.expiresAt <= Math.floor(Date.now() / 1000)) {
      return res.status(400).send(page('Sign-in expired', '<h1>Sign-in expired</h1><p class="muted">Return to ChatGPT and try connecting again.</p>'));
    }
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code || req.query.error) return res.status(400).send(page('Sign-in cancelled', '<h1>Mochi sign-in was cancelled</h1><p class="muted">Return to ChatGPT and try connecting again.</p>'));
    try {
      const domain = env.COGNITO_DOMAIN.replace(/\/$/, '');
      const tokenResponse = await fetch(`${domain}/oauth2/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: env.COGNITO_CLIENT_ID,
          code, redirect_uri: env.COGNITO_CALLBACK_URL, code_verifier: pending.codeVerifier }),
      });
      if (!tokenResponse.ok) throw new Error('Cognito token exchange failed.');
      const tokenBody = await tokenResponse.json() as { id_token?: string };
      if (!tokenBody.id_token) throw new Error('Cognito did not return an identity token.');
      const jwks = createRemoteJWKSet(new URL(`${env.COGNITO_ISSUER_URL.replace(/\/$/, '')}/.well-known/jwks.json`));
      const { payload } = await jwtVerify(tokenBody.id_token, jwks, { issuer: env.COGNITO_ISSUER_URL, audience: env.COGNITO_CLIENT_ID });
      if (payload.token_use !== 'id' || payload.nonce !== pending.nonce || typeof payload.sub !== 'string' || !payload.sub) {
        throw new Error('Cognito identity token claims did not match this sign-in.');
      }
      const walletUserId = cognitoLegacyWalletOwnerId({ email: payload.email, email_verified: payload.email_verified }, env);
      const actor: OAuthActor = {
        id: `user_${payload.sub}`, role: 'admin', provider: 'cognito',
        ...(walletUserId ? { walletUserId } : {}),
        authVersion: hmac(env.DASHBOARD_SESSION_SECRET, `cognito:${payload.sub}:${walletUserId ?? ''}`),
      };
      const authorization = { ...pending.authorization, actor };
      const cookieName = authorization.cookieName;
      if (!cookieName) throw new Error('OAuth browser session was not retained.');
      res.cookie(cookieName, authorization.csrfCookie, { httpOnly: true, secure: true, sameSite: 'none', maxAge: Math.max(0, authorization.expiresAt * 1000 - Date.now()), path: '/oauth' });
      return res.setHeader('Cache-Control', 'no-store').send(formPage(authorization, env));
    } catch (error) {
      console.error('[oauth] identity callback rejected; details omitted', error instanceof Error ? error.message : 'unknown error');
      return res.status(401).send(page('Mochi sign-in failed', '<h1>Could not verify your Mochi sign-in</h1><p class="muted">Return to ChatGPT and try again.</p>'));
    }
  }));

  // DCR lets ChatGPT register its own public PKCE client for this Mochi server.
  // No Mochi OAuth client secret is distributed to end users.
  app.post('/oauth/register', asyncHandler(async (req, res) => {
    const remote = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const previous = registrationAttempts.get(remote);
    if (previous && previous.resetAt <= now) registrationAttempts.delete(remote);
    const attempts = registrationAttempts.get(remote);
    if ((attempts?.count ?? 0) >= 20) return oauthError(res, 429, 'registration_limit_reached', 'Try registering this connector again later.');
    registrationAttempts.set(remote, attempts && attempts.resetAt > now
      ? { count: attempts.count + 1, resetAt: attempts.resetAt }
      : { count: 1, resetAt: now + 5 * 60 * 1000 });
    const metadata = req.body as Record<string, unknown> | undefined;
    const redirects = metadata?.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 10
      || redirects.some((uri) => typeof uri !== 'string' || uri.length > 2048 || !isValidClientRedirect(uri))
      || (metadata?.grant_types !== undefined && (!Array.isArray(metadata.grant_types) || metadata.grant_types.some((grant) => !['authorization_code', 'refresh_token'].includes(String(grant)))))
      || (metadata?.response_types !== undefined && (!Array.isArray(metadata.response_types) || metadata.response_types.length !== 1 || metadata.response_types[0] !== 'code'))
      || (metadata?.token_endpoint_auth_method !== undefined && metadata.token_endpoint_auth_method !== 'none')) {
      return oauthError(res, 400, 'invalid_client_metadata', 'Provide valid HTTPS redirect_uris.');
    }
    const clientId = `mochi_${randomBytes(24).toString('base64url')}`;
    const clientName = typeof metadata?.client_name === 'string' ? metadata.client_name.slice(0, 128) : undefined;
    const redirectUris = [...new Set(redirects as string[])];
    await withState(env, (state) => {
      if (Object.keys(state.clients).length >= 100_000) throw new Error('OAuth client registry is full.');
      state.clients[clientId] = { redirectUris, ...(clientName ? { name: clientName } : {}), createdAt: Date.now() };
    });
    return res.status(201).json({
      client_id: clientId, ...(clientName ? { client_name: clientName } : {}),
      redirect_uris: redirectUris, token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    });
  }));

  app.get('/oauth/authorize', asyncHandler(async (req, res) => {
    if (!oauthReady(env)) return res.status(503).send(page('Not ready', '<h1>Mochi sign-in is not configured</h1><p class="muted">The administrator must finish OAuth configuration before connecting this server.</p>'));
    const query = req.query;
    const redirectUri = typeof query.redirect_uri === 'string' ? query.redirect_uri : '';
    const clientId = typeof query.client_id === 'string' ? query.client_id : '';
    const resource = typeof query.resource === 'string' ? query.resource : '';
    const challenge = typeof query.code_challenge === 'string' ? query.code_challenge : '';
    const state = typeof query.state === 'string' ? query.state : '';
    const method = query.code_challenge_method;
    const responseType = query.response_type;
    const requested = typeof query.scope === 'string' ? query.scope.split(/\s+/).filter(Boolean) : [READ_SCOPE];
    const dcrClient = await registeredClient(clientId, env);
    const redirectAllowed = clientId === env.MCP_OAUTH_CLIENT_ID
      ? redirectUri === env.MCP_OAUTH_REDIRECT_URI
      : Boolean(dcrClient?.redirectUris.includes(redirectUri));
    if (!redirectAllowed || resource !== env.MCP_OAUTH_RESOURCE
      || responseType !== 'code' || method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)
      || !/^[A-Za-z0-9._~-]{1,512}$/.test(state) || requested.length === 0 || requested.some((scope) => !ALLOWED_SCOPES.has(scope)) || !requested.includes(READ_SCOPE)) {
      return res.status(400).send(page('Invalid request', '<h1>Invalid OAuth request</h1><p class="muted">The client, redirect URL, resource, scope, or PKCE parameters were not accepted.</p>'));
    }
    const cookieName = `mochi_oauth_${randomBytes(10).toString('hex')}`;
    const csrfCookie = randomBytes(24).toString('base64url');
    const request: AuthorizationRequest = {
      clientId, redirectUri, responseType: 'code', state, challenge, resource,
      scope: [...new Set(requested)], csrfCookie, requestId: randomBytes(32).toString('base64url'), expiresAt: Math.floor(Date.now() / 1000) + 10 * 60,
    };
    (request as AuthorizationRequest & { cookieName?: string }).cookieName = cookieName;
    // ChatGPT may complete OAuth in a cross-site connector browser context. Keep the
    // signed request + one-time CSRF cookie binding, but allow that context to return it.
    res.cookie(cookieName, csrfCookie, { httpOnly: true, secure: true, sameSite: 'none', maxAge: 10 * 60 * 1000, path: '/oauth' });
    if (env.COGNITO_DOMAIN && env.COGNITO_CLIENT_ID && env.COGNITO_ISSUER_URL && env.COGNITO_CALLBACK_URL) {
      const identityState = randomBytes(32).toString('base64url');
      const nonce = randomBytes(32).toString('base64url');
      const codeVerifier = randomBytes(32).toString('base64url');
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
      const authorization = { ...request, cookieName };
      await withState(env, (state) => {
        state.identityRequests[identityState] = { authorization, codeVerifier, nonce, expiresAt: request.expiresAt };
      });
      const login = new URL(`${env.COGNITO_DOMAIN.replace(/\/$/, '')}/oauth2/authorize`);
      login.search = new URLSearchParams({ response_type: 'code', client_id: env.COGNITO_CLIENT_ID,
        redirect_uri: env.COGNITO_CALLBACK_URL, scope: 'openid email profile', state: identityState,
        nonce, code_challenge: codeChallenge, code_challenge_method: 'S256' }).toString();
      return res.redirect(302, login.toString());
    }
    res.setHeader('Cache-Control', 'no-store').send(formPage(request, env));
  }));

  app.post('/oauth/authorize/consent', asyncHandler(async (req, res) => {
    if (!oauthReady(env)) return res.status(503).send(page('Not ready', '<h1>Mochi sign-in is not configured</h1>'));
    const decision = req.body?.decision === 'approve' || req.body?.decision === 'deny' ? req.body.decision : 'unknown';
    console.info('[oauth] consent POST received', { decision });
    const signed = typeof req.body?.authorization_request === 'string' ? req.body.authorization_request : '';
    const request = verifyAuthorizationRequest(signed, env);
    const cookieName = (request as (AuthorizationRequest & { cookieName?: string }) | null)?.cookieName;
    const cookies = parseCookies(req);
    const csrfCookiePresent = Boolean(cookieName && cookies[cookieName]);
    const csrfCookieMatches = Boolean(request && cookieName && constantTimeEqual(cookies[cookieName] ?? '', request.csrfCookie));
    // Some connector browsers omit cookies on the consent form POST. The signed,
    // short-lived request still acts as a CSRF token; consume its random ID exactly
    // once after valid consent so cookie-less clients cannot replay an approval.
    if (!request || !cookieName || (csrfCookiePresent && !csrfCookieMatches)
      || !/^[A-Za-z0-9_-]{43}$/.test(request.requestId)) {
      // Record only booleans: never log the signed request, cookie, password, or tokens.
      console.warn('[oauth] consent request rejected', {
        authorizationRequestValid: Boolean(request),
        csrfCookiePresent,
        csrfCookieMatches,
      });
      return res.status(400).send(page('Expired request', '<h1>Sign-in expired</h1><p class="muted">Return to ChatGPT and try connecting again.</p>'));
    }
    if (req.body?.decision !== 'approve') {
      const fresh = await consumeAuthorizationRequest(request, env);
      if (!fresh) return res.status(400).send(page('Expired request', '<h1>Sign-in expired</h1><p class="muted">Return to ChatGPT and try connecting again.</p>'));
      res.clearCookie(cookieName, { path: '/oauth' });
      return redirectWithAuthError(res, request, env, 'access_denied', 'You cancelled the Mochi connection.');
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const actor = request.actor ?? authenticatePassword(password, env);
    const remote = req.ip || req.socket.remoteAddress || 'unknown';
    const previousAttempt = loginFailures.get(remote);
    if (previousAttempt && previousAttempt.resetAt <= Date.now()) loginFailures.delete(remote);
    if (!loginFailures.has(remote) && loginFailures.size >= 10_000) {
      for (const [ip, failed] of loginFailures) if (failed.resetAt <= Date.now()) loginFailures.delete(ip);
      if (loginFailures.size >= 10_000) return res.status(429).send(page('Try later', '<h1>Sign-in is temporarily busy</h1><p class="muted">Try again in a few minutes.</p>'));
    }
    if ((loginFailures.get(remote)?.count ?? 0) >= MAX_LOGIN_FAILURES) {
      return res.status(429).send(page('Try later', '<h1>Too many sign-in attempts</h1><p class="muted">Wait 15 minutes before trying again.</p>'));
    }
    if (!actor) {
      const current = loginFailures.get(remote);
      loginFailures.set(remote, current && current.resetAt > Date.now()
        ? { count: current.count + 1, resetAt: current.resetAt }
        : { count: 1, resetAt: Date.now() + LOGIN_FAILURE_WINDOW_MS });
      return res.status(401).send(formPage(request, env, 'Password was not accepted. Check it and try again.'));
    }
    loginFailures.delete(remote);
    if (request.scope.includes(WRITE_SCOPE) && !['admin', 'preparer'].includes(actor.role)) {
      const fresh = await consumeAuthorizationRequest(request, env);
      if (!fresh) return res.status(400).send(page('Expired request', '<h1>Sign-in expired</h1><p class="muted">Return to ChatGPT and try connecting again.</p>'));
      res.clearCookie(cookieName, { path: '/oauth' });
      return redirectWithAuthError(res, request, env, 'invalid_scope', 'This Mochi role can connect with read-only access.');
    }
    res.clearCookie(cookieName, { path: '/oauth' });
    const issued = await createAuthorizationCode(request, actor, env);
    if (!issued) {
      console.info('[oauth] consent retry has no redeemable authorization code');
      return res.status(400).send(page('Expired request', '<h1>Sign-in expired</h1><p class="muted">Return to ChatGPT and try connecting again.</p>'));
    }
    console.info('[oauth] consent approved', { retry: issued.replayed });
    const location = new URL(request.redirectUri);
    location.searchParams.set('code', issued.code);
    location.searchParams.set('state', request.state);
    location.searchParams.set('iss', issuer(env));
    res.redirect(302, location.toString());
  }));

  app.post('/oauth/token', asyncHandler(async (req, res) => {
    if (!oauthReady(env)) return oauthError(res, 503, 'server_error', 'Mochi OAuth is not configured.');
    const client = await authenticateOAuthClient(req, env);
    const body = req.body as Record<string, unknown> | undefined;
    const grantType = typeof body?.grant_type === 'string' ? body.grant_type : '';
    console.info('[oauth] token request received', { grantType: grantType || 'missing' });
    if (!client) {
      console.warn('[oauth] token client authentication failed');
      return oauthError(res, 401, 'invalid_client', 'OAuth client authentication failed.');
    }
    const resource = typeof body?.resource === 'string' ? body.resource : '';
    if (resource !== env.MCP_OAUTH_RESOURCE) return oauthError(res, 400, 'invalid_target', 'The resource does not match Mochi.');

    if (grantType === 'authorization_code') {
      const code = typeof body?.code === 'string' ? body.code : '';
      const redirectUri = typeof body?.redirect_uri === 'string' ? body.redirect_uri : '';
      const verifier = typeof body?.code_verifier === 'string' ? body.code_verifier : '';
      if (!code || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError(res, 400, 'invalid_grant');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const grant = await withState(env, (store) => {
        const key = hashToken(code);
        const found = store.codes[key];
        if (!found || found.clientId !== client || found.redirectUri !== redirectUri || found.resource !== resource
          || found.expiresAt <= Math.floor(Date.now() / 1000) || !constantTimeEqual(found.challenge, challenge)) return null;
        delete store.codes[key];
        return found;
      });
      if (!grant) {
        console.warn('[oauth] authorization code exchange rejected', { reason: 'invalid_or_replayed_code' });
        return oauthError(res, 400, 'invalid_grant', 'Authorization code is expired, invalid, or already used.');
      }
      console.info('[oauth] authorization code exchange succeeded');
      return issueTokens(res, env, client, grant.actor, grant.scope, resource);
    }

    if (grantType === 'refresh_token') {
      const refreshToken = typeof body?.refresh_token === 'string' ? body.refresh_token : '';
      if (!refreshToken) return oauthError(res, 400, 'invalid_grant');
      const rotated = await withState(env, (store) => {
        const key = hashToken(refreshToken);
        const found = store.refresh[key];
        if (!found && store.spentRefresh[key]) {
          const familyId = store.spentRefresh[key].familyId;
          for (const [activeKey, active] of Object.entries(store.refresh)) if (active.familyId === familyId) delete store.refresh[activeKey];
          return null;
        }
        const member = found?.actor.provider === 'cognito' ? null : found && currentMembers(env).find((candidate) => candidate.id === found.actor.id && candidate.role === found.actor.role);
        const identityStillValid = found?.actor.provider === 'cognito'
          ? found.actor.authVersion === hmac(env.DASHBOARD_SESSION_SECRET, `cognito:${found.actor.id.slice('user_'.length)}:${found.actor.walletUserId ?? ''}`)
          : Boolean(member && authVersion(member, env) === found?.actor.authVersion);
        if (!found || !identityStillValid || found.clientId !== client || found.resource !== resource || found.expiresAt <= Math.floor(Date.now() / 1000)) return null;
        delete store.refresh[key];
        store.spentRefresh[key] = { familyId: found.familyId, expiresAt: found.expiresAt };
        return found;
      });
      if (!rotated) return oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid, expired, or already used.');
      return issueTokens(res, env, client, rotated.actor, rotated.scope, resource, rotated.familyId);
    }
    return oauthError(res, 400, 'unsupported_grant_type');
  }));
  app.use('/oauth', (error: unknown, _req: Request, res: Response, next: (error?: unknown) => void) => {
    if (res.headersSent) return next(error);
    console.error('[oauth] request failed; details omitted to avoid logging credentials or tokens.');
    return oauthError(res, 500, 'server_error', 'OAuth request could not be completed. Try again.');
  });
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => { void handler(req, res).catch(next); };
}

function redirectWithAuthError(res: Response, request: AuthorizationRequest, env: Env, error: string, description: string): void {
  const location = new URL(request.redirectUri);
  location.searchParams.set('error', error);
  location.searchParams.set('error_description', description);
  location.searchParams.set('state', request.state);
  location.searchParams.set('iss', issuer(env));
  res.redirect(302, location.toString());
}

function isValidClientRedirect(value: string): boolean {
  try {
    const uri = new URL(value);
    return uri.protocol === 'https:' && !uri.username && !uri.password && !uri.hash;
  } catch { return false; }
}

async function registeredClient(id: string, env: Env): Promise<OAuthState['clients'][string] | null> {
  if (!id || id.length > 256) return null;
  return withState(env, (state) => state.clients[id] ?? null);
}

async function authenticateOAuthClient(request: Request, env: Env): Promise<string | null> {
  const authorization = request.get('authorization') ?? '';
  let id = '';
  let secret = '';
  const basic = /^Basic\s+(.+)$/i.exec(authorization);
  if (basic) {
    try {
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) {
        id = decodeURIComponent(decoded.slice(0, separator));
        secret = decodeURIComponent(decoded.slice(separator + 1));
      }
    } catch { return null; }
  } else {
    id = typeof request.body?.client_id === 'string' ? request.body.client_id : '';
    secret = typeof request.body?.client_secret === 'string' ? request.body.client_secret : '';
  }
  if (env.MCP_OAUTH_CLIENT_ID && constantTimeEqual(id, env.MCP_OAUTH_CLIENT_ID)
    && constantTimeEqual(secret, env.MCP_OAUTH_CLIENT_SECRET)) return id;
  if (!secret && await registeredClient(id, env)) return id;
  return null;
}

async function issueTokens(res: Response, env: Env, clientId: string, actor: OAuthActor, scope: string[], resource: string, familyId = randomBytes(16).toString('hex')): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const payload: AccessClaims = {
    iss: issuer(env), aud: resource, sub: actor.id, role: actor.role, authVersion: actor.authVersion,
    scope: scope.join(' '), iat: now, exp: now + ACCESS_TOKEN_TTL_SECONDS, jti: randomBytes(16).toString('hex'),
    ...(actor.provider ? { idp: actor.provider } : {}),
    ...(actor.walletUserId ? { walletUserId: actor.walletUserId } : {}),
  };
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const encoded = base64url(JSON.stringify(payload));
  const signingInput = `${header}.${encoded}`;
  const accessToken = `${signingInput}.${hmac(env.DASHBOARD_SESSION_SECRET, signingInput)}`;
  const refreshToken = randomBytes(40).toString('base64url');
  await withState(env, (store) => {
    store.refresh[hashToken(refreshToken)] = {
      clientId, resource, scope, actor, expiresAt: now + REFRESH_TOKEN_TTL_SECONDS, familyId,
    };
  });
  res.setHeader('Cache-Control', 'no-store').setHeader('Pragma', 'no-cache').json({
    access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken, scope: scope.join(' '),
  });
}

export function verifyMochiAccessToken(token: string, env: Env): AccessClaims | null {
  if (!oauthReady(env)) return null;
  const [header, encoded, signature, extra] = token.split('.');
  const signingInput = `${header}.${encoded}`;
  if (!header || !encoded || !signature || extra !== undefined || !constantTimeEqual(signature, hmac(env.DASHBOARD_SESSION_SECRET, signingInput))) return null;
  try {
    const tokenHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: string; typ?: string };
    if (tokenHeader.alg !== 'HS256' || tokenHeader.typ !== 'JWT') return null;
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AccessClaims;
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== issuer(env) || claims.aud !== env.MCP_OAUTH_RESOURCE || !claims.sub || !claims.jti
      || !Number.isInteger(claims.exp) || claims.exp <= now || !Number.isInteger(claims.iat) || claims.iat > now + 60
      || !['admin', 'approver', 'preparer', 'viewer'].includes(claims.role)
      || !claims.scope.split(/\s+/).every((scope) => ALLOWED_SCOPES.has(scope))
      || !claims.scope.split(/\s+/).includes(READ_SCOPE)) return null;
    if (claims.idp === 'cognito') {
      if (!env.COGNITO_ISSUER_URL || !claims.sub.startsWith('user_') || claims.role !== 'admin'
        || (claims.walletUserId !== undefined && (claims.walletUserId !== 'owner' || !env.COGNITO_LEGACY_OWNER_EMAIL))
        || claims.authVersion !== hmac(env.DASHBOARD_SESSION_SECRET, `cognito:${claims.sub.slice('user_'.length)}:${claims.walletUserId ?? ''}`)) return null;
    } else {
      const member = currentMembers(env).find((candidate) => candidate.id === claims.sub && candidate.role === claims.role);
      if (!member || claims.authVersion !== authVersion(member, env)) return null;
    }
    return claims;
  } catch { return null; }
}

export function oauthMcpAuthorization(env: Env): RequestHandler {
  return (req, res, next) => {
    const auth = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '');
    if (!auth) {
      res.setHeader('WWW-Authenticate', bearerChallenge(env));
      return res.status(401).json({ ok: false, error: 'Authentication required.' });
    }
    const claims = verifyMochiAccessToken(auth[1], env);
    if (!claims) {
      res.setHeader('WWW-Authenticate', bearerChallenge(env));
      return res.status(401).json({ ok: false, error: 'Invalid or expired access token.' });
    }
    if (req.method === 'POST' && req.body?.method === 'tools/call') {
      const name = req.body?.params?.name;
      const scopes = claims.scope.split(/\s+/);
      if (typeof name !== 'string' || !isKnownMcpTool(name)) {
        return res.status(403).json({ ok: false, error: 'This tool is not authorized for the Mochi OAuth connection.' });
      }
      if (!scopes.includes(WRITE_SCOPE) && !isReadOnlyMcpTool(name)) {
        res.setHeader('WWW-Authenticate', `${bearerChallenge(env)}, error="insufficient_scope", scope="${READ_SCOPE} ${WRITE_SCOPE}"`);
        return res.status(403).json({ ok: false, error: 'This action requires Mochi write access.' });
      }
      if (isReadOnlyMcpTool(name) && !scopes.includes(READ_SCOPE)) return res.status(403).json({ ok: false, error: 'Read access is required.' });
      if (!isReadOnlyMcpTool(name) && !['admin', 'preparer'].includes(claims.role)) return res.status(403).json({ ok: false, error: 'This Mochi role cannot prepare actions.' });
      // User IDs in tool arguments are untrusted. Bind every per-user tool call
      // to the authenticated Mochi identity before it reaches a handler.
      if (!req.body.params.arguments || typeof req.body.params.arguments !== 'object' || Array.isArray(req.body.params.arguments)) req.body.params.arguments = {};
      req.body.params.arguments.userId = claims.walletUserId ?? claims.sub;
      console.info('[mcp] tool call authorized', {
        tool: name,
        walletIdentity: claims.walletUserId === 'owner' ? 'legacy-owner' : 'account',
      });
    } else if (req.method === 'POST') {
      console.info('[mcp] request authorized', { method: req.body?.method ?? 'unknown' });
    }
    next();
  };
}
