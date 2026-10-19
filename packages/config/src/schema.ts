import { z } from 'zod';

// Full config surface (tables, columns, roles) lands in #9 and #28.
export const wardenConfigSchema = z.strictObject({
  defaults: z
    .strictObject({
      /** `all` exposes every introspected table; `none` exposes only tables listed in config. */
      expose: z.enum(['all', 'none']).default('all'),
    })
    .prefault({}),
});

export type WardenConfig = z.infer<typeof wardenConfigSchema>;
