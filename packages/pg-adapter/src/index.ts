import type { SchemaModel } from '@wardenhq/core';

export interface PgAdapterOptions {
  connectionString: string;
  /** Schemas to introspect. Defaults to `['public']`. */
  schemas?: string[];
}

// Implemented in #8.
export type Introspect = (options: PgAdapterOptions) => Promise<SchemaModel>;
