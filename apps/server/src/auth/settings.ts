export interface AuthSettings {
  /** Where browsers reach Warden. Builds the OIDC redirect URI and decides cookie security. */
  publicUrl: URL;
  issuer: URL;
  clientId: string;
  clientSecret: string;
  scopes: string;
  /** Signs cookies. Changing it logs everyone out. */
  sessionSecret: string;
  idleTimeoutSeconds: number;
  absoluteTimeoutSeconds: number;
}

const MIN_SECRET_LENGTH = 32;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
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
  const url = (name: string) => {
    const value = required(name);
    if (!value) return undefined;
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

  if (problems.length > 0 || !publicUrl || !issuer) {
    throw new Error(`Invalid auth settings:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return {
    publicUrl,
    issuer,
    clientId,
    clientSecret,
    scopes,
    sessionSecret,
    idleTimeoutSeconds,
    absoluteTimeoutSeconds,
  };
}
