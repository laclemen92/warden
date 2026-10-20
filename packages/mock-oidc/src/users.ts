export interface MockUser {
  /** Stable `sub`; also the value posted by the login page. */
  sub: string;
  /** Omitted from the claims when absent, like an IdP account without one. */
  email?: string;
  /** The `email_verified` claim; defaults to `true`. */
  emailVerified?: boolean;
  name: string;
  /** Returned in the `groups` claim (requested with the `groups` scope). */
  groups: string[];
}

/**
 * Fixed test users. `outsider` belongs to no Warden group and uses another email domain,
 * so role resolution has a user to deny.
 */
export const MOCK_USERS: readonly MockUser[] = [
  {
    sub: 'viewer',
    email: 'viewer@example.com',
    name: 'Vera Viewer',
    groups: ['warden-viewers'],
  },
  {
    sub: 'editor',
    email: 'editor@example.com',
    name: 'Eddie Editor',
    groups: ['warden-editors'],
  },
  {
    sub: 'admin',
    email: 'admin@example.com',
    name: 'Ada Admin',
    groups: ['warden-admins'],
  },
  {
    sub: 'outsider',
    email: 'outsider@example.org',
    name: 'Oscar Outsider',
    groups: [],
  },
];
