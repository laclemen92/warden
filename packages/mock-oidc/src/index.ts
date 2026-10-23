import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Provider, { type Configuration, type JWK } from 'oidc-provider';
import { MOCK_USERS, type MockUser } from './users.js';

export { MOCK_USERS, type MockUser } from './users.js';

export interface MockOidcClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
}

export interface MockOidcOptions {
  /** Defaults to `http://<host>:<port>`. Must be the URL both the browser and Warden use. */
  issuer?: string;
  /** `0` picks a free port (useful in tests). */
  port?: number;
  host?: string;
  clients: MockOidcClient[];
  users?: readonly MockUser[];
  /** RP-initiated logout (`end_session_endpoint`). On by default; off mimics IdPs without it. */
  endSession?: boolean;
  /**
   * Serve Auth0's legacy `GET /v2/logout?client_id=…&returnTo=…`, which ends the session and
   * redirects to `returnTo` if it is one of the client's post-logout redirect URIs. Off by default.
   */
  legacyLogout?: boolean;
  /** Access token lifetime in seconds (default an hour). */
  accessTokenTtl?: number;
}

export interface MockOidc {
  issuer: string;
  users: readonly MockUser[];
  /** Every token endpoint request so far, in order: its grant type and whether it succeeded. */
  grants: readonly { grantType: string; ok: boolean }[];
  close(): Promise<void>;
}

/**
 * Start a mock OpenID Connect provider. The login page lists the test users; picking one
 * signs in as them with no password. Consent is granted automatically. Development and
 * test use only: anyone who can reach it can sign in as any user.
 */
export async function startMockOidc({
  issuer,
  port = 0,
  host = '127.0.0.1',
  clients,
  users = MOCK_USERS,
  endSession = true,
  legacyLogout = false,
  accessTokenTtl = 3600,
}: MockOidcOptions): Promise<MockOidc> {
  // The issuer may depend on the bound port, so the provider is created after listen().
  let handler: http.RequestListener = (_req, res) => res.writeHead(503).end();
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  const resolvedIssuer = issuer ?? `http://${host}:${address.port}`;

  // Nonces of authorization requests that asked for offline_access (see createProvider).
  const offlineNonces = new Set<string>();
  const provider = createProvider(
    resolvedIssuer,
    clients,
    users,
    endSession,
    accessTokenTtl,
    offlineNonces,
  );
  const grants: { grantType: string; ok: boolean }[] = [];
  provider.on('grant.success', (ctx) => {
    grants.push({ grantType: String(ctx.oidc.params?.grant_type), ok: true });
  });
  provider.on('grant.error', (ctx) => {
    grants.push({ grantType: String(ctx.oidc.params?.grant_type), ok: false });
  });
  const callback = provider.callback();
  handler = (req, res) => {
    const url = new URL(req.url ?? '/', resolvedIssuer);
    const nonce = url.searchParams.get('nonce');
    if (url.pathname === '/auth' && nonce && /(^| )offline_access( |$)/.test(scopeOf(url))) {
      offlineNonces.add(nonce);
    }
    if (legacyLogout && url.pathname === LEGACY_LOGOUT_PATH) {
      return void handleLegacyLogout(provider, clients, url, req, res).catch((err: unknown) => {
        if (!res.headersSent) sendHtml(res, 400, page('Error', `<p>${escape(String(err))}</p>`));
      });
    }
    const match = INTERACTION_PATH.exec(url.pathname);
    if (!match) return callback(req, res);
    handleInteraction(provider, users, match[1] ?? '', match[2], req, res).catch((err: unknown) => {
      if (!res.headersSent) sendHtml(res, 400, page('Error', `<p>${escape(String(err))}</p>`));
    });
  };

  return {
    issuer: resolvedIssuer,
    users,
    grants,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function createProvider(
  issuer: string,
  clients: MockOidcClient[],
  users: readonly MockUser[],
  endSession: boolean,
  accessTokenTtl: number,
  offlineNonces: ReadonlySet<string>,
): Provider {
  // oidc-provider drops offline_access unless the request also has prompt=consent, as the spec
  // suggests. Auth0 and most IdPs don't require that, so the mock remembers which requests asked.
  const offline = (code: { scopes: Set<string>; nonce?: string | undefined }) =>
    code.scopes.has('offline_access') ||
    (code.nonce !== undefined && offlineNonces.has(code.nonce));

  // Fresh keys per process are fine for a mock; relying parties refetch the JWKS on unknown kids.
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signingKey = { ...privateKey.export({ format: 'jwk' }), use: 'sig', alg: 'ES256' };

  const configuration: Configuration = {
    clients: clients.map((client) => ({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uris: client.redirectUris,
      post_logout_redirect_uris: client.postLogoutRedirectUris ?? [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      id_token_signed_response_alg: 'ES256',
    })),
    jwks: { keys: [signingKey as JWK] },
    ttl: { AccessToken: accessTokenTtl },
    issueRefreshToken: (_ctx, client, code) =>
      client.grantTypeAllowed('refresh_token') && offline(code),
    expiresWithSession: (_ctx, code) => !offline(code),
    cookies: { keys: ['warden-mock-oidc-dev-only'] },
    claims: {
      openid: ['sub'],
      email: ['email', 'email_verified'],
      profile: ['name'],
      groups: ['groups'],
    },
    // Put scope-requested claims in the ID token too, like most IdPs' group claims.
    conformIdTokenClaims: false,
    // Warden always uses PKCE; fail loudly if it ever stops.
    pkce: { required: () => true },
    features: {
      devInteractions: { enabled: false },
      // Lets tests revoke a refresh token, as an admin removing a user would.
      revocation: { enabled: true },
      rpInitiatedLogout: {
        enabled: endSession,
        // Sign out without the default confirmation page.
        logoutSource: (ctx, form) => {
          ctx.body = page(
            'Signing out',
            `${form}<input type="hidden" form="op.logoutForm" name="logout" value="yes" />
            <noscript><button form="op.logoutForm" type="submit">Sign out</button></noscript>
            <script>document.forms[0].submit()</script>`,
          );
        },
      },
    },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    // Auto-consent: grant whatever scopes and claims the client asked for.
    loadExistingGrant: async (ctx) => {
      const { client, session } = ctx.oidc;
      if (!client || !session?.accountId) return undefined;
      const grantId = session.grantIdFor(client.clientId);
      const grant =
        (grantId ? await ctx.oidc.provider.Grant.find(grantId) : undefined) ??
        new ctx.oidc.provider.Grant({ clientId: client.clientId, accountId: session.accountId });
      grant.addOIDCScope(ctx.oidc.requestParamScopes);
      grant.addOIDCClaims(ctx.oidc.requestParamClaims);
      await grant.save();
      return grant;
    },
    findAccount: (_ctx, sub) => {
      const user = users.find((u) => u.sub === sub);
      if (!user) return undefined;
      return {
        accountId: user.sub,
        claims: () => ({
          sub: user.sub,
          ...(user.email !== undefined
            ? { email: user.email, email_verified: user.emailVerified ?? true }
            : {}),
          name: user.name,
          groups: user.groups,
        }),
      };
    },
  };

  return new Provider(issuer, configuration);
}

const LEGACY_LOGOUT_PATH = '/v2/logout';

const scopeOf = (url: URL) => url.searchParams.get('scope') ?? '';

async function handleLegacyLogout(
  provider: Provider,
  clients: MockOidcClient[],
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') return sendHtml(res, 405, page('Error', '<p>Method not allowed</p>'));
  const client = clients.find((c) => c.clientId === url.searchParams.get('client_id'));
  if (!client) return sendHtml(res, 400, page('Error', '<p>Unknown client</p>'));
  const returnTo = url.searchParams.get('returnTo');
  if (returnTo !== null && !(client.postLogoutRedirectUris ?? []).includes(returnTo)) {
    return sendHtml(res, 400, page('Error', '<p>returnTo is not an allowed logout URL</p>'));
  }
  const session = await provider.Session.get(provider.createContext(req, res));
  await session.destroy();
  if (returnTo === null) return sendHtml(res, 200, page('Signed out', '<p>Signed out.</p>'));
  res.writeHead(302, { location: returnTo }).end();
}

const INTERACTION_PATH = /^\/interaction\/([^/]+)(?:\/(login|abort))?$/;

async function handleInteraction(
  provider: Provider,
  users: readonly MockUser[],
  uid: string,
  action: string | undefined,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const details = await provider.interactionDetails(req, res);
  if (details.uid !== uid) throw new Error('Interaction does not match this browser session');

  if (action === undefined && req.method === 'GET') {
    return sendHtml(res, 200, loginPage(uid, users));
  }
  if (req.method !== 'POST') return sendHtml(res, 405, page('Error', '<p>Method not allowed</p>'));

  if (action === 'abort') {
    return provider.interactionFinished(req, res, {
      error: 'access_denied',
      error_description: 'End-user aborted interaction',
    });
  }
  const sub = new URLSearchParams(await readBody(req)).get('user');
  const user = users.find((u) => u.sub === sub);
  if (!user) return sendHtml(res, 400, page('Error', '<p>Unknown user</p>'));
  return provider.interactionFinished(
    req,
    res,
    { login: { accountId: user.sub } },
    { mergeWithLastSubmission: false },
  );
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 10_000) throw new Error('Request body too large');
  }
  return body;
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(html);
}

function loginPage(uid: string, users: readonly MockUser[]): string {
  const action = `/interaction/${encodeURIComponent(uid)}`;
  const buttons = users
    .map(
      (user) => `<button type="submit" name="user" value="${escape(user.sub)}">
        <strong>${escape(user.name)}</strong>
        <span>${escape(user.email ?? 'no email')}</span>
        <small>${user.groups.length ? escape(user.groups.join(', ')) : 'no groups'}</small>
      </button>`,
    )
    .join('');
  return page(
    'Sign in',
    `<h1>Mock OIDC sign-in</h1>
    <p>Development only. Choose a test user.</p>
    <form method="post" action="${action}/login">${buttons}</form>
    <form method="post" action="${action}/abort"><button type="submit" class="link">Cancel</button></form>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(title)} · Mock OIDC</title>
<style>
  body { font: 15px/1.4 system-ui, sans-serif; max-width: 24rem; margin: 3rem auto; padding: 0 1rem; color: #1f2328; }
  form { display: grid; gap: .5rem; margin: 1rem 0; }
  button { display: grid; text-align: left; padding: .75rem 1rem; border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; cursor: pointer; font: inherit; }
  button:hover { background: #eaeef2; }
  button span, button small { color: #57606a; }
  button.link { border: 0; background: none; padding: 0; color: #0969da; }
</style>
</head>
<body>${body}</body>
</html>`;
}

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
