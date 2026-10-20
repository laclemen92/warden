// The schema entry point, not the package root: core also runs in the browser.
import { ADMIN_AREAS, type AdminArea, type WardenConfig } from '@wardenhq/config/schema';

export type { AdminArea };

/** Admin areas any of `roles` may use, in canonical order. Unknown roles grant nothing. */
export function adminAreas(config: WardenConfig['roles'], roles: readonly string[]): AdminArea[] {
  // Own keys only, so a role named "constructor" can't reach Object.prototype.
  const granted = new Set(
    roles.flatMap((role) => (Object.hasOwn(config, role) ? config[role]!.admin : [])),
  );
  return ADMIN_AREAS.filter((area) => granted.has(area));
}
