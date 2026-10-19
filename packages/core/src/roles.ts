import type { AccessConfig } from '@wardenhq/config';

/**
 * Roles for a signed-in user, from their ID token claims and the config's `access` rules.
 * `undefined` means no rule matched and the user may not use Warden. Without `access`, every
 * IdP user is let in with no roles, so reading follows `defaults.read` and nothing is writable.
 */
export function resolveRoles(
  access: AccessConfig | undefined,
  claims: Record<string, unknown>,
): string[] | undefined {
  if (!access) return [];

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

  return matched.length > 0 ? [...new Set(matched.flat())].sort() : undefined;
}

function claimGroups(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

function emailDomain(claims: Record<string, unknown>, requireVerified: boolean) {
  const { email, email_verified: verified } = claims;
  if (typeof email !== 'string') return undefined;
  // Some IdPs send the string "true"; anything else counts as unverified.
  if (requireVerified && verified !== true && verified !== 'true') return undefined;
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(at + 1).toLowerCase() : undefined;
}
