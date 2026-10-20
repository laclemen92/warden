import type { AccessConfig } from '@wardenhq/config';

/**
 * Roles for a signed-in user, from their ID token claims and the config's `access` rules, plus
 * roles `assigned` to them in the app (looked up by {@link assignmentEmail}; only roles config
 * defines). `undefined` means nothing matched and the user may not use Warden. Without `access`,
 * every IdP user is let in, with no roles unless assigned some, so reading follows
 * `defaults.read` and nothing is writable.
 */
export function resolveRoles(
  access: AccessConfig | undefined,
  claims: Record<string, unknown>,
  assigned: readonly string[] = [],
): string[] | undefined {
  if (!access) return [...new Set(assigned)].sort();

  const matched: string[][] = [];
  for (const group of claimGroups(claims[access.groupsClaim])) {
    // Own keys only, so a group named "constructor" can't reach Object.prototype.
    if (Object.hasOwn(access.groups, group)) matched.push(access.groups[group]!);
  }
  const domain = emailDomain(claims, access.requireVerifiedEmail);
  if (domain !== undefined) {
    for (const [key, roles] of Object.entries(access.emailDomains)) {
      if (key.toLowerCase() === domain) matched.push(roles);
    }
  }
  // An assignment is an access rule for one user, so it also lets them in.
  if (assigned.length > 0) matched.push([...assigned]);

  return matched.length > 0 ? [...new Set(matched.flat())].sort() : undefined;
}

function claimGroups(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/**
 * The email that in-app role assignments are matched against, lowercased. Like `emailDomains`,
 * it needs `email_verified` unless `requireVerifiedEmail` is off, or anyone who can set their
 * own email at the IdP could take over another user's assignments.
 */
export function assignmentEmail(
  access: AccessConfig | undefined,
  claims: Record<string, unknown>,
): string | undefined {
  const email = verifiedEmail(claims, access?.requireVerifiedEmail ?? true);
  return email !== undefined && parseEmail(email) === email ? email : undefined;
}

const MAX_EMAIL_LENGTH = 254;

/**
 * An email address for a role assignment, trimmed and lowercased, or `undefined` if it isn't
 * one. Deliberately loose: the IdP decides what a valid address is; this only rejects input
 * that could never match one.
 */
export function parseEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return undefined;
  }
  return email;
}

function verifiedEmail(claims: Record<string, unknown>, requireVerified: boolean) {
  const { email, email_verified: verified } = claims;
  if (typeof email !== 'string') return undefined;
  // Some IdPs send the string "true"; anything else counts as unverified.
  if (requireVerified && verified !== true && verified !== 'true') return undefined;
  return email.toLowerCase();
}

function emailDomain(claims: Record<string, unknown>, requireVerified: boolean) {
  const email = verifiedEmail(claims, requireVerified);
  if (email === undefined) return undefined;
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(at + 1) : undefined;
}
