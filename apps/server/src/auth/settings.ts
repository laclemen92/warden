export interface AuthSettings {
  /** Where browsers reach Warden. Builds the OIDC redirect URI and decides cookie security. */
  publicUrl: URL;
  issuer: URL;
  clientId: string;
  clientSecret: string;
  scopes: string;
  /** Extra authorization request parameters (`OIDC_AUDIENCE`, `OIDC_AUTH_PARAMS`). */
  authParams: Record<string, string>;
  /**
   * Logout URL template used when discovery has no `end_session_endpoint`. Validated: same origin
   * as the issuer, and only `{clientId}` / `{postLogoutRedirect}` placeholders in the query.
   */
  logoutUrl?: string;
  /** Signs cookies. Changing it logs everyone out. */
  sessionSecret: string;
  idleTimeoutSeconds: number;
  absoluteTimeoutSeconds: number;
}

const MIN_SECRET_LENGTH = 32;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
// Warden sets these itself; letting config override them would undo PKCE, state or nonce checks,
// or send the code somewhere else.
const RESERVED_AUTH_PARAMS = new Set([
  'client_id',
  'redirect_uri',
  'response_type',
  'response_mode',
  'scope',
  'state',
  'nonce',
  'request',
  'request_uri',
]);
const LOGOUT_PLACEHOLDERS = new Set(['{clientId}', '{postLogoutRedirect}']);
const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

/** Parse `90s`, `30m`, `8h`, `7d` (or bare seconds) into seconds. */
export function parseDuration(value: string): number | undefined {
  const match = /^(\d+)\s*([smhd]?)$/.exec(value.trim());
  if (!match) return undefined;
  const seconds = Number(match[1]) * (UNITS[match[2] || 's'] ?? 1);
  return seconds > 0 ? seconds : undefined;
}

/** Read auth settings from the environment. Throws one error listing every problem. */
export function parseAuthSettings(env: Record<string, string | undefined>): AuthSettings {
  const problems: string[] = [];

  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) problems.push(`${name} is required`);
    return value ?? '';
  };
  const parseUrl = (name: string, value: string) => {
    try {
      const parsed = new URL(value);
      // Plain http is only acceptable on this machine (local dev, the mock IdP in compose).
      if (
        parsed.protocol !== 'https:' &&
        !(parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname))
      ) {
        problems.push(`${name} must use https (http is only allowed for localhost)`);
      }
      return parsed;
    } catch {
      problems.push(`${name} must be a URL`);
      return undefined;
    }
  };
  const url = (name: string) => {
    const value = required(name);
    return value ? parseUrl(name, value) : undefined;
  };
  const duration = (name: string, fallback: string) => {
    const seconds = parseDuration(env[name] ?? fallback);
    if (seconds === undefined) problems.push(`${name} must be a duration like 30m, 8h, or 7d`);
    return seconds ?? 0;
  };

  const publicUrl = url('WARDEN_PUBLIC_URL');
  const issuer = url('OIDC_ISSUER');
  const clientId = required('OIDC_CLIENT_ID');
  const clientSecret = required('OIDC_CLIENT_SECRET');
  const sessionSecret = required('WARDEN_SESSION_SECRET');
  if (sessionSecret && sessionSecret.length < MIN_SECRET_LENGTH) {
    problems.push(`WARDEN_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const scopes = env.OIDC_SCOPES?.trim() || 'openid email profile';
  if (!scopes.split(/\s+/).includes('openid')) problems.push('OIDC_SCOPES must include openid');

  const idleTimeoutSeconds = duration('WARDEN_SESSION_IDLE_TIMEOUT', '2h');
  const absoluteTimeoutSeconds = duration('WARDEN_SESSION_ABSOLUTE_TIMEOUT', '12h');
  if (idleTimeoutSeconds > absoluteTimeoutSeconds) {
    problems.push('WARDEN_SESSION_IDLE_TIMEOUT must not exceed WARDEN_SESSION_ABSOLUTE_TIMEOUT');
  }

  const authParams = parseAuthParams(env, problems);
  const logoutUrl = env.OIDC_LOGOUT_URL?.trim();
  if (logoutUrl) checkLogoutUrl(logoutUrl, issuer, parseUrl, problems);

  if (problems.length > 0 || !publicUrl || !issuer) {
    throw new Error(`Invalid auth settings:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return {
    publicUrl,
    issuer,
    clientId,
    clientSecret,
    scopes,
    authParams,
    ...(logoutUrl ? { logoutUrl } : {}),
    sessionSecret,
    idleTimeoutSeconds,
    absoluteTimeoutSeconds,
  };
}

function parseAuthParams(
  env: Record<string, string | undefined>,
  problems: string[],
): Record<string, string> {
  const params: Record<string, string> = {};
  const raw = env.OIDC_AUTH_PARAMS?.trim();
  for (const pair of raw ? raw.split('&').filter(Boolean) : []) {
    const eq = pair.indexOf('=');
    let key, value;
    try {
      key = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' ')).trim();
      value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    } catch {
      problems.push(`OIDC_AUTH_PARAMS has an invalid escape in "${pair}"`);
      continue;
    }
    if (eq <= 0 || !key || !value) {
      problems.push('OIDC_AUTH_PARAMS must be key=value pairs joined by &');
    } else if (RESERVED_AUTH_PARAMS.has(key.toLowerCase()) || /^code_challenge/i.test(key)) {
      problems.push(`OIDC_AUTH_PARAMS must not set ${key}; Warden sets it`);
    } else if (Object.hasOwn(params, key)) {
      problems.push(`OIDC_AUTH_PARAMS sets ${key} more than once`);
    } else {
      params[key] = value;
    }
  }
  const audience = env.OIDC_AUDIENCE?.trim();
  if (audience) {
    if (Object.hasOwn(params, 'audience')) {
      problems.push('Set the audience with OIDC_AUDIENCE or OIDC_AUTH_PARAMS, not both');
    } else {
      params.audience = audience;
    }
  }
  return params;
}

function checkLogoutUrl(
  template: string,
  issuer: URL | undefined,
  parseUrl: (name: string, value: string) => URL | undefined,
  problems: string[],
): void {
  const name = 'OIDC_LOGOUT_URL';
  const before = problems.length;
  const query = template.indexOf('?');
  for (const match of template.matchAll(/\{[^{}]*\}/g)) {
    if (!LOGOUT_PLACEHOLDERS.has(match[0])) {
      problems.push(
        `${name} has unknown placeholder ${match[0]}; use {clientId} or {postLogoutRedirect}`,
      );
    } else if (query < 0 || match.index < query) {
      // Outside the query a value could change the host or path.
      problems.push(`${name} may only use placeholders in the query string`);
    }
  }
  if (/[{}]/.test(template.replace(/\{[^{}]*\}/g, ''))) {
    problems.push(`${name} has an unmatched { or }`);
  }
  if (template.includes('#')) problems.push(`${name} must not have a fragment`);
  if (problems.length > before) return;

  const parsed = parseUrl(name, template.replace(/\{[^{}]*\}/g, 'x'));
  if (!parsed) return;
  if (parsed.username || parsed.password) problems.push(`${name} must not contain credentials`);
  if (issuer && parsed.origin !== issuer.origin) {
    problems.push(`${name} must have the same origin as OIDC_ISSUER (${issuer.origin})`);
  }
}

/** Fill a validated `OIDC_LOGOUT_URL` template. */
export function buildLogoutUrl(
  template: string,
  values: { clientId: string; postLogoutRedirect: string },
): URL {
  return new URL(
    template
      .replaceAll('{clientId}', encodeURIComponent(values.clientId))
      .replaceAll('{postLogoutRedirect}', encodeURIComponent(values.postLogoutRedirect)),
  );
}
