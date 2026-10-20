// The schema entry point, not the package root: core also runs in the browser.
import {
  ADMIN_AREAS,
  type AccessConfig,
  type AdminArea,
  type WardenConfig,
} from '@wardenhq/config/schema';

export type { AdminArea };

/** Admin areas any of `roles` may use, in canonical order. Unknown roles grant nothing. */
export function adminAreas(config: WardenConfig['roles'], roles: readonly string[]): AdminArea[] {
  // Own keys only, so a role named "constructor" can't reach Object.prototype.
  const granted = new Set(
    roles.flatMap((role) => (Object.hasOwn(config, role) ? config[role]!.admin : [])),
  );
  return ADMIN_AREAS.filter((area) => granted.has(area));
}

/**
 * Roles whose last assignment may not be removed: those with `admin: [roles]`, when no `access`
 * rule in config grants one. Otherwise removing it would lock everyone out of the roles page
 * until someone edits config or the database. Empty when a rule grants one; whether anyone
 * matches that rule is up to the IdP, and fixing it is a config change anyway.
 */
export function lastHolderRoles(
  config: WardenConfig['roles'],
  access: AccessConfig | undefined,
): string[] {
  const admins = Object.keys(config).filter((role) => config[role]!.admin.includes('roles'));
  const granted = new Set(
    [...Object.values(access?.groups ?? {}), ...Object.values(access?.emailDomains ?? {})].flat(),
  );
  return admins.some((role) => granted.has(role)) ? [] : admins;
}
