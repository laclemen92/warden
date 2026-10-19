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

export async function logout(): Promise<void> {
  // Best effort: the session is gone either way once we land on the login page.
  await fetch(LOGOUT_URL, { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
}
