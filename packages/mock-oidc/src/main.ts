import { startMockOidc } from './index.js';

const env = process.env;
const list = (value: string | undefined, fallback: string[]) =>
  value
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : fallback;

const port = Number(env.MOCK_OIDC_PORT ?? 9400);
const host = env.MOCK_OIDC_HOST ?? '0.0.0.0';
// Not derived from `host`: 0.0.0.0 is a bind address, and the browser needs a URL it can open.
const issuer = env.MOCK_OIDC_ISSUER ?? `http://localhost:${port}`;

const oidc = await startMockOidc({
  issuer,
  port,
  host,
  clients: [
    {
      clientId: env.MOCK_OIDC_CLIENT_ID ?? 'warden',
      clientSecret: env.MOCK_OIDC_CLIENT_SECRET ?? 'warden-dev-secret',
      redirectUris: list(env.MOCK_OIDC_REDIRECT_URIS, [
        'http://localhost:3000/auth/callback',
        'http://localhost:5173/auth/callback',
      ]),
      postLogoutRedirectUris: list(env.MOCK_OIDC_POST_LOGOUT_REDIRECT_URIS, [
        'http://localhost:3000/',
        'http://localhost:5173/',
      ]),
    },
  ],
});

console.log(`Mock OIDC provider at ${oidc.issuer} (development only)`);
console.log(`Users: ${oidc.users.map((u) => `${u.sub} <${u.email}>`).join(', ')}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void oidc.close().then(() => process.exit(0)));
}
