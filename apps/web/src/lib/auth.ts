import { useQuery } from '@tanstack/react-query';
import { ApiError, apiFetch } from './api';

// Server routes owned by the OIDC work in #13/#14.
const LOGIN_URL = '/auth/login';
const LOGOUT_URL = '/auth/logout';
const ME_URL = '/api/me';

export interface CurrentUser {
  name?: string;
  email?: string;
  roles?: string[];
  /** Admin areas the user may open, e.g. `schema` for the schema drift page. */
  admin?: string[];
}

/**
 * Only same-origin paths are allowed as a post-login destination, so a crafted
 * `?returnTo=` link can't bounce the user to another site.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/';
  }
  return value;
}

export function loginPath(returnTo: string): string {
  const target = safeReturnTo(returnTo);
  return target === '/' ? '/login' : `/login?returnTo=${encodeURIComponent(target)}`;
}

export function ssoLoginUrl(returnTo: string): string {
  return `${LOGIN_URL}?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
}

const SIGN_IN_FAILED = 'Sign-in failed. Please try again.';

// Codes the server puts in `/login?error=` (apps/server/src/routes/auth.ts).
const LOGIN_ERRORS: Record<string, string> = {
  login_failed: SIGN_IN_FAILED,
  access_denied: "Your account doesn't have access to Warden. Ask an administrator for access.",
};

/**
 * The message for a `?error=` code. Unknown codes get the generic message: the
 * param comes from the URL, so it is never shown as-is.
 */
export function loginErrorMessage(code: string | null | undefined): string | null {
  if (code == null) return null;
  return Object.hasOwn(LOGIN_ERRORS, code) ? LOGIN_ERRORS[code]! : SIGN_IN_FAILED;
}

export function useCurrentUser() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<CurrentUser> => {
      try {
        return await apiFetch<CurrentUser>(ME_URL);
      } catch (err) {
        // Until OIDC lands (#13) there is no session endpoint; show an anonymous user.
        if (err instanceof ApiError && err.status === 404) return {};
        throw err;
      }
    },
    staleTime: Infinity,
  });
}

/**
 * End the session. Returns the IdP's logout URL to send the browser to when the IdP supports
 * it, so its session ends too; otherwise `undefined`.
 */
export async function logout(): Promise<string | undefined> {
  // Best effort: the session is gone either way once we land on the login page.
  const res = await fetch(LOGOUT_URL, { method: 'POST', credentials: 'same-origin' }).catch(
    () => undefined,
  );
  if (res?.status !== 200) return undefined;
  const body = (await res.json().catch(() => undefined)) as { redirectTo?: unknown } | undefined;
  return typeof body?.redirectTo === 'string' ? body.redirectTo : undefined;
}
