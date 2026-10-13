import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateEnv } from '../packages/mcp-server/src/config/env.js';
import {
  createAuthorizationServerMetadata,
  createProtectedResourceMetadata,
  cognitoLegacyWalletOwnerId,
  oauthMcpAuthorization,
  registerOAuthRoutes,
  verifyMochiAccessToken,
} from '../packages/mcp-server/src/middleware/oauth.js';

const issuer = 'https://mcp.getmochi.dev';
const resource = `${issuer}/mcp`;
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
const requireFromMcp = createRequire(join(process.cwd(), 'packages', 'mcp-server', 'package.json'));
const express = requireFromMcp('express') as typeof import('express');
const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function makeEnv(overrides: Record<string, string> = {}) {
  return validateEnv({
    ...process.env,
    MCP_API_TOKEN: 'legacy-bearer-for-tests',
    MCP_PUBLIC_URL: issuer,
    MCP_OAUTH_RESOURCE: resource,
    MCP_OAUTH_CLIENT_ID: 'chatgpt-connector-test',
    MCP_OAUTH_CLIENT_SECRET: 'test-client-secret-that-is-long-enough',
    MCP_OAUTH_REDIRECT_URI: callback,
    DASHBOARD_PASSWORD: 'test-dashboard-password',
    DASHBOARD_SESSION_SECRET: 'test-session-signing-secret-with-sufficient-randomness',
    ...overrides,
  });
}

async function withServer(run: (base: string, env: ReturnType<typeof makeEnv>) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mochi-oauth-'));
  cleanup.push(dataDir);
  const env = makeEnv({ MOCHI_DATA_DIR: dataDir });
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  registerOAuthRoutes(app, env);
  app.post('/authorization-check', oauthMcpAuthorization(env), (_req, res) => res.json({ ok: true }));
  app.post('/identity-check', oauthMcpAuthorization(env), (req, res) => res.json(req.body.params.arguments));
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test HTTP server did not bind to a TCP port.');
  try { await run(`http://127.0.0.1:${address.port}`, env); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

describe('Mochi OAuth discovery', () => {
  it('publishes resource metadata and OAuth 2.1 PKCE endpoints', () => {
    const env = makeEnv();
    expect(createProtectedResourceMetadata(env)).toMatchObject({ resource, authorization_servers: [issuer], scopes_supported: ['mochi:read', 'mochi:write'] });
    expect(createAuthorizationServerMetadata(env)).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      authorization_response_iss_parameter_supported: true,
      registration_endpoint: `${issuer}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    });
  });
});

describe('Cognito wallet ownership mapping', () => {
  it('links only the configured verified owner email to legacy owner data', () => {
    const env = makeEnv({ COGNITO_LEGACY_OWNER_EMAIL: 'DinithMain@gmail.com' });
    expect(cognitoLegacyWalletOwnerId({ email: 'dinithmain@gmail.com', email_verified: true }, env)).toBe('owner');
    expect(cognitoLegacyWalletOwnerId({ email: 'dinithmain@gmail.com', email_verified: false }, env)).toBeUndefined();
    expect(cognitoLegacyWalletOwnerId({ email: 'other@example.com', email_verified: true }, env)).toBeUndefined();
    expect(cognitoLegacyWalletOwnerId({ email: null, email_verified: true }, env)).toBeUndefined();
  });
});

describe('Mochi OAuth authorization code flow', () => {
  it('returns the same pending code for duplicate approval POSTs', async () => {
    await withServer(async (base, env) => {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const state = randomBytes(24).toString('base64url');
      const url = new URL(`${base}/oauth/authorize`);
      url.search = new URLSearchParams({
        response_type: 'code', client_id: env.MCP_OAUTH_CLIENT_ID, redirect_uri: callback,
        resource, scope: 'mochi:read', state, code_challenge: challenge, code_challenge_method: 'S256',
      }).toString();
      const authorize = await fetch(url, { redirect: 'manual' });
      const html = await authorize.text();
      const signedRequest = /name="authorization_request" value="([^"]+)"/.exec(html)?.[1];
      expect(signedRequest).toBeTruthy();

      const submit = () => fetch(`${base}/oauth/authorize/consent`, {
        method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ authorization_request: signedRequest!, password: 'test-dashboard-password', decision: 'approve' }),
      });
      const responses = await Promise.all([submit(), submit()]);
      expect(responses.map((response) => response.status)).toEqual([302, 302]);
      const callbackUrls = responses.map((response) => new URL(response.headers.get('location')!));
      expect(callbackUrls[0].searchParams.get('code')).toBeTruthy();
      expect(callbackUrls[0].searchParams.get('code')).toBe(callbackUrls[1].searchParams.get('code'));
      expect(callbackUrls[0].searchParams.get('state')).toBe(state);
    });
  });

  it('requires consent and PKCE, consumes codes once, and rotates refresh tokens', async () => {
    await withServer(async (base, env) => {
      const metadata = await fetch(`${base}/.well-known/oauth-protected-resource`);
      expect(metadata.status).toBe(200);
      expect(await metadata.json()).toMatchObject({ resource, authorization_servers: [issuer] });

      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const state = randomBytes(24).toString('base64url');
      const url = new URL(`${base}/oauth/authorize`);
      url.search = new URLSearchParams({
        response_type: 'code', client_id: env.MCP_OAUTH_CLIENT_ID,
        redirect_uri: callback, resource, scope: 'mochi:read mochi:write',
        state, code_challenge: challenge, code_challenge_method: 'S256',
      }).toString();
      const authorize = await fetch(url, { redirect: 'manual' });
      expect(authorize.status).toBe(200);
      expect(authorize.headers.get('content-security-policy')).toContain("form-action 'self' https://chatgpt.com");
      const html = await authorize.text();
      expect(html).toContain('Approve and connect');
      expect(html).toContain('Prepare Mochi actions');
      const signedRequest = /name="authorization_request" value="([^"]+)"/.exec(html)?.[1];
      const setCookie = authorize.headers.get('set-cookie') ?? '';
      const cookie = setCookie.split(';', 1)[0];
      expect(signedRequest).toBeTruthy();
      expect(cookie).toBeTruthy();
      expect(setCookie).toContain('Path=/oauth');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=None');

      const consent = await fetch(`${base}/oauth/authorize/consent`, {
        method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ authorization_request: signedRequest!, password: 'test-dashboard-password', decision: 'approve' }),
      });
      expect(consent.status).toBe(302);
      const callbackUrl = new URL(consent.headers.get('location')!);
      expect(callbackUrl.origin + callbackUrl.pathname).toBe(callback);
      expect(callbackUrl.searchParams.get('state')).toBe(state);
      expect(callbackUrl.searchParams.get('iss')).toBe(issuer);
      const code = callbackUrl.searchParams.get('code')!;

      const replayedConsent = await fetch(`${base}/oauth/authorize/consent`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ authorization_request: signedRequest!, password: 'test-dashboard-password', decision: 'approve' }),
      });
      expect(replayedConsent.status).toBe(302);
      expect(new URL(replayedConsent.headers.get('location')!).searchParams.get('code')).toBe(code);

      const exchange = new URLSearchParams({
        grant_type: 'authorization_code', client_id: env.MCP_OAUTH_CLIENT_ID,
        client_secret: env.MCP_OAUTH_CLIENT_SECRET, code, redirect_uri: callback,
        resource, code_verifier: verifier,
      });
      const tokenResponse = await fetch(`${base}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: exchange,
      });
      expect(tokenResponse.status).toBe(200);
      const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string; token_type: string; scope: string };
      expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'mochi:read mochi:write' });
      expect(verifyMochiAccessToken(tokens.access_token, env)).toMatchObject({ iss: issuer, aud: resource, sub: 'owner', role: 'admin' });
      const identityCheck = await fetch(`${base}/identity-check`, {
        method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'tools/call', params: { name: 'wallet_initialize', arguments: { userId: 'attacker-selected-user' } } }),
      });
      expect(await identityCheck.json()).toMatchObject({ userId: 'owner' });
      const stateFile = await readFile(join(env.MOCHI_DATA_DIR, 'oauth-state.json'), 'utf8');
      expect(stateFile).not.toContain(code);
      expect(stateFile).not.toContain(tokens.refresh_token);
      expect(stateFile).not.toContain(tokens.access_token);
      const readCall = await fetch(`${base}/authorization-check`, {
        method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'tools/call', params: { name: 'wallet_get_balance' } }),
      });
      expect(readCall.status).toBe(200);
      const writeCall = await fetch(`${base}/authorization-check`, {
        method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'tools/call', params: { name: 'transaction_send_mon' } }),
      });
      expect(writeCall.status).toBe(200);
      const unknownCall = await fetch(`${base}/authorization-check`, {
        method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'tools/call', params: { name: 'unregistered_tool' } }),
      });
      expect(unknownCall.status).toBe(403);

      const replay = await fetch(`${base}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: exchange,
      });
      expect(replay.status).toBe(400);
      expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });

      const refresh = new URLSearchParams({
        grant_type: 'refresh_token', client_id: env.MCP_OAUTH_CLIENT_ID,
        client_secret: env.MCP_OAUTH_CLIENT_SECRET, refresh_token: tokens.refresh_token, resource,
      });
      const refreshed = await fetch(`${base}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: refresh,
      });
      expect(refreshed.status).toBe(200);
      const rotated = await refreshed.json() as { access_token: string; refresh_token: string };
      expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
      expect(verifyMochiAccessToken(rotated.access_token, env)?.sub).toBe('owner');
      const replayedRefresh = await fetch(`${base}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: refresh,
      });
      expect(replayedRefresh.status).toBe(400);
      const successor = new URLSearchParams({
        grant_type: 'refresh_token', client_id: env.MCP_OAUTH_CLIENT_ID,
        client_secret: env.MCP_OAUTH_CLIENT_SECRET, refresh_token: rotated.refresh_token, resource,
      });
      const revokedFamily = await fetch(`${base}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: successor,
      });
      expect(revokedFamily.status).toBe(400);
    });
  });

  it('registers ChatGPT public clients and accepts their secretless PKCE token exchange', async () => {
    await withServer(async (base, env) => {
      const registration = await fetch(`${base}/oauth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [callback], grant_types: ['authorization_code'], response_types: ['code'] }),
      });
      expect(registration.status).toBe(201);
      const client = await registration.json() as { client_id: string; token_endpoint_auth_method: string };
      expect(client.token_endpoint_auth_method).toBe('none');

      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const state = randomBytes(24).toString('base64url');
      const url = new URL(`${base}/oauth/authorize`);
      url.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id,
        redirect_uri: callback, resource, scope: 'mochi:read', state, code_challenge: challenge,
        code_challenge_method: 'S256' }).toString();
      const authorize = await fetch(url);
      const html = await authorize.text();
      const signedRequest = /name="authorization_request" value="([^"]+)"/.exec(html)?.[1]!;
      const consent = await fetch(`${base}/oauth/authorize/consent`, {
        method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ authorization_request: signedRequest, password: 'test-dashboard-password', decision: 'approve' }),
      });
      const authorizationCode = new URL(consent.headers.get('location')!).searchParams.get('code')!;
      const token = await fetch(`${base}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id,
          code: authorizationCode, redirect_uri: callback, resource, code_verifier: verifier }),
      });
      expect(token.status).toBe(200);
      expect(verifyMochiAccessToken(((await token.json()) as { access_token: string }).access_token, env)?.sub).toBe('owner');
    });
  });

  it('rejects authorization requests with a wrong resource and invalid client credentials', async () => {
    await withServer(async (base, env) => {
      const invalid = await fetch(`${base}/oauth/authorize?response_type=code&client_id=${env.MCP_OAUTH_CLIENT_ID}&redirect_uri=${encodeURIComponent(callback)}&resource=${encodeURIComponent('https://attacker.invalid')}&state=abc&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`);
      expect(invalid.status).toBe(400);
      const token = await fetch(`${base}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: env.MCP_OAUTH_CLIENT_ID, client_secret: 'wrong', code: 'invalid', redirect_uri: callback, resource, code_verifier: 'a'.repeat(43) }),
      });
      expect(token.status).toBe(401);
      expect(await token.json()).toMatchObject({ error: 'invalid_client' });
    });
  });

  it('rejects viewer authorization for write scope', async () => {
    await withServer(async (base, env) => {
      // The viewer's login is accepted; the role check blocks granting write access.
      const viewerEnv = makeEnv({
        MOCHI_DATA_DIR: env.MOCHI_DATA_DIR,
        DASHBOARD_PASSWORD: '',
        DASHBOARD_TEAM_MEMBERS: JSON.stringify([{ id: 'reader', password: 'viewer-password-long-123', role: 'viewer' }]),
      });
      const app = express(); app.use(express.urlencoded({ extended: false })); registerOAuthRoutes(app, viewerEnv);
      // Re-use the current server's ephemeral listener by testing the authorization page through a small route server.
      const server = await new Promise<import('node:http').Server>((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test HTTP server did not bind to a TCP port.');
      try {
        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const url = new URL(`http://127.0.0.1:${address.port}/oauth/authorize`);
        url.search = new URLSearchParams({ response_type: 'code', client_id: viewerEnv.MCP_OAUTH_CLIENT_ID, redirect_uri: callback, resource, scope: 'mochi:read mochi:write', state: randomBytes(24).toString('base64url'), code_challenge: challenge, code_challenge_method: 'S256' }).toString();
        const authorize = await fetch(url);
        const html = await authorize.text();
        const signedRequest = /name="authorization_request" value="([^"]+)"/.exec(html)?.[1]!;
        const cookie = authorize.headers.get('set-cookie')?.split(';', 1)[0]!;
        const consent = await fetch(`http://127.0.0.1:${address.port}/oauth/authorize/consent`, {
          method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
          body: new URLSearchParams({ authorization_request: signedRequest, password: 'viewer-password-long-123', decision: 'approve' }),
        });
        expect(consent.status).toBe(302);
        expect(new URL(consent.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope');
      } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
    });
  });
});
