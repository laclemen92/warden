import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_AUDIT_COLUMNS, parseConfig } from '../src/index.js';

const FILE = 'warden.config.yaml';

function issues(source: string) {
  try {
    parseConfig(source, FILE);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues.map((i) => [i.path, i.message]);
    throw err;
  }
  throw new Error('expected config to be invalid');
}

const MINIMAL_COLUMNS = `
    id: id
    occurredAt: created_at
    actorSubject: actor_sub
    action: action
    entity: table_name
    recordId: record_id
    diff: diff
    details: details`;

describe('audit config', () => {
  it('defaults to the warden store', () => {
    expect(parseConfig('', FILE).audit).toEqual({ store: 'warden' });
  });

  it('parses a table store with a mapping and a source tag', () => {
    const { audit } = parseConfig(
      `audit:
  store: table
  table: public.change_log
  columns:${MINIMAL_COLUMNS}
    reason: why
  source: { column: source, value: warden }
`,
      FILE,
    );
    expect(audit).toEqual({
      store: 'table',
      table: 'public.change_log',
      columns: {
        id: 'id',
        occurredAt: 'created_at',
        actorSubject: 'actor_sub',
        action: 'action',
        entity: 'table_name',
        recordId: 'record_id',
        diff: 'diff',
        details: 'details',
        reason: 'why',
      },
      source: { column: 'source', value: 'warden' },
    });
  });

  it('names default columns after warden.audit_log', () => {
    expect(DEFAULT_AUDIT_COLUMNS).toMatchObject({
      occurredAt: 'occurred_at',
      actorSubject: 'actor_subject',
      primaryKey: 'primary_key',
      parentId: 'parent_id',
      diff: 'diff',
    });
  });

  it('requires a table with store: table, and only allows table settings with it', () => {
    expect(issues(`audit: { store: table }`)).toEqual([
      ['audit.table', 'is required with `store: table`'],
    ]);
    expect(issues(`audit: { table: change_log }`)).toEqual([
      ['audit.table', 'only applies with `store: table`'],
    ]);
  });

  it('rejects a mapping without the required fields', () => {
    expect(
      issues(`audit:
  store: table
  table: change_log
  columns: { id: id, occurredAt: at, actorSubject: sub, action: action, entity: entity }
`),
    ).toEqual([
      ['audit.columns', '"recordId" must be mapped'],
      ['audit.columns', '"diff" must be mapped'],
      ['audit.columns', '"details" must be mapped'],
    ]);
  });

  it('rejects unknown fields, a column mapped twice, and a source column already mapped', () => {
    expect(
      issues(`audit:
  store: table
  table: change_log
  columns:${MINIMAL_COLUMNS}
    actorName: actor_name
`),
    ).toEqual([['audit.columns.actorName', expect.stringMatching(/unrecognized key/i)]]);
    expect(
      issues(`audit:
  store: table
  table: change_log
  columns:${MINIMAL_COLUMNS}
    reason: action
  source: { column: diff, value: warden }
`),
    ).toEqual([
      ['audit.columns.reason', 'column "action" is already mapped to "action"'],
      ['audit.source.column', 'column "diff" is already mapped to "diff"'],
    ]);
    // Without `columns`, the default names are taken.
    expect(
      issues(`audit: { store: table, table: change_log, source: { column: entity, value: w } }`),
    ).toEqual([['audit.source.column', 'column "entity" is already mapped to "entity"']]);
  });

  it("refuses Warden's own schema", () => {
    expect(issues(`audit: { store: table, table: warden.audit_log }`)).toEqual([
      ['audit.table', "the warden schema is Warden's own; use `store: warden` for its audit log"],
    ]);
  });

  it('refuses config or grants for the audit table, under either spelling', () => {
    expect(
      issues(`audit: { store: table, table: change_log }
tables:
  public.change_log: { label: Log }
roles:
  admin:
    grants:
      change_log: [read, update]
      '*': [read]
`),
    ).toEqual([
      [
        'tables.public.change_log',
        '"public.change_log" is the audit table, which Warden never exposes',
      ],
      [
        'roles.admin.grants.change_log',
        '"public.change_log" is the audit table, which Warden never exposes',
      ],
    ]);
  });
});
