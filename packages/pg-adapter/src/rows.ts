import type { CursorValues, Entity, Filter, SortTerm } from '@wardenhq/core';
import { sql, type Expression, type RawBuilder, type SqlBool } from 'kysely';
import type { Database } from './database.js';
import { compileFilter } from './filter.js';

export type Row = Record<string, unknown>;

const ALIAS = 't';
const column = (name: string) => sql.id(ALIAS, name);
// `only` keeps rows of tables that INHERIT from this one out: those are separate entities, which
// config may hide or deny, and the parent's primary key isn't unique across them. A partitioned
// table's rows all live in its partitions, so `only` would see none; partitions aren't entities and
// partitioned tables can't have INHERITS children, so the plain table is exactly its rows.
export const entityTable = (entity: Entity) => {
  const table = sql.id(entity.schema, entity.name);
  return entity.kind === 'partitioned' ? table : sql`only ${table}`;
};
const from = (entity: Entity) => sql`${entityTable(entity)} as ${sql.id(ALIAS)}`;
// Only exposed fields are ever selected, so hidden columns never leave the database.
const selection = (entity: Entity) => sql.join(entity.fields.map((f) => column(f.name)));

export interface ListOptions {
  /** Must already be validated against the entity. */
  filter?: Filter;
  /** Must already be resolved against the entity (see `resolveSort`). */
  sort: SortTerm[];
  limit: number;
  offset?: number;
  /** Keyset position from a decoded cursor; requires `sort` to end with the primary key. */
  after?: CursorValues;
  count?: boolean;
}

export interface ListResult {
  rows: Row[];
  hasMore: boolean;
  total?: number;
}

export async function listRows(
  db: Database,
  entity: Entity,
  options: ListOptions,
): Promise<ListResult> {
  const { filter, sort, limit, offset = 0, after, count = false } = options;

  const conditions: Expression<SqlBool>[] = [];
  if (filter) conditions.push(compileFilter(filter, ALIAS));
  if (after) conditions.push(keysetAfter(sort, after));
  const where = conditions.length > 0 ? sql`where ${sql.join(conditions, sql` and `)}` : sql``;

  // Fetch one extra row to learn whether another page exists without a count.
  const { rows } = await sql<Row>`
    select ${selection(entity)} from ${from(entity)} ${where} ${orderBy(sort)}
    limit ${limit + 1} offset ${offset}`.execute(db);

  const result: ListResult = { rows: rows.slice(0, limit), hasMore: rows.length > limit };
  if (count) {
    const { rows: countRows } = await sql<{ total: string }>`
      select count(*) as total from ${from(entity)} ${filter ? sql`where ${compileFilter(filter, ALIAS)}` : sql``}`.execute(
      db,
    );
    result.total = Number(countRows[0]?.total ?? 0);
  }
  return result;
}

const orderBy = (sort: SortTerm[]) =>
  sort.length
    ? sql`order by ${sql.join(
        sort.map(
          (t) =>
            sql`${column(t.field)} ${sql.raw(t.direction === 'desc' ? 'desc' : 'asc')} nulls last`,
        ),
      )}`
    : sql``;

export interface ExportOptions {
  /** Must already be validated against the entity. */
  filter?: Filter;
  /** Must already be resolved against the entity (see `resolveSort`). */
  sort: SortTerm[];
  /** Rows fetched per round trip. */
  batchSize?: number;
  /** Stop counting past this many rows, so refusing a huge export stays cheap. */
  maxRows?: number;
  /** End the export this long after it opens, however it is going. */
  deadlineMs?: number;
  /** End the export when its reader hasn't asked for the next batch for this long. */
  idleTimeoutMs?: number;
  /** Called once the deadline or idle timeout has ended the export. */
  onTimeout?: (reason: ExportTimeout) => void;
}

export type ExportTimeout = 'deadline' | 'idle';

/** Every matching row of an export, from one snapshot of the database. */
export interface RowExport {
  /** How many rows `batches` will yield; `maxRows + 1` when there are more than `maxRows`. */
  total: number;
  /** The rows in order, a batch at a time. Ends the export when done or abandoned. */
  batches(): AsyncGenerator<Row[]>;
  /**
   * End the export without reading it. Safe to call more than once; each call settles once the
   * connection has been returned.
   */
  close(): Promise<void>;
}

const EXPORT_CURSOR = sql.id('warden_export');

/**
 * Open an export: a read-only, repeatable-read transaction with a cursor over the matching rows,
 * so the count and the rows agree and memory use doesn't grow with the table. It holds a
 * connection until it is read to the end, closed, or timed out.
 */
export async function openExport(
  db: Database,
  entity: Entity,
  { filter, sort, batchSize = 1000, maxRows, deadlineMs, idleTimeoutMs, onTimeout }: ExportOptions,
): Promise<RowExport> {
  const trx = await db
    .startTransaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute();
  let open = true;
  let closing: Promise<void> | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let idle: NodeJS.Timeout | undefined;
  // Every caller waits for the same rollback, so once any `close()` settles the connection is back
  // in the pool (callers count connections by it).
  const close = () => {
    if (!closing) {
      open = false;
      clearTimeout(deadline);
      clearTimeout(idle);
      closing = trx.rollback().execute();
    }
    return closing;
  };
  // A reader that stops pulling (a stalled download) would otherwise leave the transaction idle,
  // holding a connection and pinning its snapshot, until the client goes away.
  const timeOut = (reason: ExportTimeout) => {
    if (!open) return;
    const ending = close();
    onTimeout?.(reason);
    ending.catch(() => {});
  };
  const armIdle = () => {
    if (idleTimeoutMs === undefined || !open) return;
    idle = setTimeout(() => timeOut('idle'), idleTimeoutMs).unref();
  };
  if (deadlineMs !== undefined) {
    deadline = setTimeout(() => timeOut('deadline'), deadlineMs).unref();
  }
  try {
    const where = filter ? sql`where ${compileFilter(filter, ALIAS)}` : sql``;
    const matching = sql`select 1 from ${from(entity)} ${where}`;
    const { rows } = await sql<{ total: string }>`
      select count(*) as total from (${
        maxRows === undefined ? matching : sql`${matching} limit ${maxRows + 1}`
      }) as matching`.execute(trx);
    await sql`
      declare ${EXPORT_CURSOR} no scroll cursor for
      select ${selection(entity)} from ${from(entity)} ${where} ${orderBy(sort)}`.execute(trx);
    armIdle();
    return {
      total: Number(rows[0]?.total ?? 0),
      close,
      async *batches() {
        try {
          while (open) {
            clearTimeout(idle);
            const { rows: batch } = await sql<Row>`
              fetch forward ${sql.lit(batchSize)} from ${EXPORT_CURSOR}`.execute(trx);
            if (batch.length === 0) break;
            armIdle();
            yield batch;
          }
        } finally {
          await close();
        }
      },
    };
  } catch (err) {
    await close();
    throw err;
  }
}

/** Fetch a single row matching a primary-key filter (from `decodeRecordId`). */
export async function getRow(
  db: Database,
  entity: Entity,
  filter: Filter,
): Promise<Row | undefined> {
  const { rows } = await sql<Row>`
    select ${selection(entity)} from ${from(entity)} where ${compileFilter(filter, ALIAS)} limit 1`.execute(
    db,
  );
  return rows[0];
}

/**
 * Rows strictly after `values` in `sort` order, matching `order by ... nulls last`:
 *   after(i) = gt(i) or (eq(i) and after(i + 1))
 * where for a non-null value gt means "further along or null" and for a null value nothing
 * non-null comes after it.
 */
function keysetAfter(sort: SortTerm[], values: CursorValues): Expression<SqlBool> {
  const build = (i: number): RawBuilder<SqlBool> => {
    const term = sort[i]!;
    const value = values[i] ?? null;
    const col = column(term.field);
    const op = sql.raw(term.direction === 'desc' ? '<' : '>');
    const gt =
      value === null
        ? sql<SqlBool>`false`
        : sql<SqlBool>`(${col} ${op} ${value} or ${col} is null)`;
    if (i === sort.length - 1) return gt;
    const eq = value === null ? sql<SqlBool>`${col} is null` : sql<SqlBool>`${col} = ${value}`;
    return sql<SqlBool>`(${gt} or (${eq} and ${build(i + 1)}))`;
  };
  return build(0);
}
