import { wardenConfigSchema } from '@wardenhq/config';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_MAX_INPUT_ITEMS,
  canRunAction,
  checkActionDefinitions,
  oversizedInputArrays,
  previewTokenPayload,
  redactInput,
  resolveActionPolicy,
  resolvePolicy,
  resolveSchema,
  runnableActions,
  type ActionChange,
  type ActionSpec,
  type Column,
  type SchemaModel,
  type Table,
} from '../src/index.js';

const column = (name: string): Column => ({
  name,
  dataType: 'int8',
  formattedType: 'bigint',
  isArray: false,
  nullable: false,
  hasDefault: true,
  generated: false,
});
const table = (name: string, schema = 'public', primaryKey = ['id']): Table => ({
  schema,
  name,
  kind: 'table',
  columns: [column('id')],
  primaryKey,
  uniqueKeys: [],
  foreignKeys: [],
});
const model: SchemaModel = {
  enums: [],
  tables: [
    table('users'),
    table('companies'),
    table('orders'),
    table('secrets'),
    table('log', 'public', []),
    table('invoices', 'billing'),
  ],
};

const ref = (entity: string) => z.string().meta({ 'x-warden-ref': entity });
const run = async () => {};
const definition = (overrides: Record<string, unknown> = {}) => ({
  name: 'move-user',
  label: 'Move',
  on: 'users',
  permissions: { users: ['update'], orders: ['update'] },
  input: z.object({ company: ref('companies') }),
  run,
  ...overrides,
});

const specs = (...definitions: unknown[]) => {
  const result = checkActionDefinitions(definitions);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.specs;
};

const resolve = (actions: ActionSpec[], config: unknown = {}) => {
  const parsed = wardenConfigSchema.parse({
    schemas: ['public', 'billing'],
    ...(config as object),
  });
  const { schema } = resolveSchema(model, parsed);
  const { policy } = resolvePolicy(schema, parsed);
  return { ...resolveActionPolicy(actions, schema, policy, parsed), policy };
};

describe('checkActionDefinitions', () => {
  it('takes what Warden needs from a definition, with defaults', () => {
    const [spec] = specs(definition());
    expect(spec).toEqual({
      name: 'move-user',
      label: 'Move',
      on: 'users',
      target: 'one',
      permissions: { users: ['update'], orders: ['update'] },
      confirm: 'preview',
      destructive: false,
      requireReason: false,
      maxAffectedRows: 1000,
      inputSchema: {
        type: 'object',
        properties: { company: { type: 'string', 'x-warden-ref': 'companies' } },
        required: ['company'],
        additionalProperties: false,
      },
      refs: [{ field: 'company', entity: 'companies', many: false }],
      sensitive: [],
    });
  });

  it('finds sensitive fields however the marker is nested', () => {
    const secret = z.string().meta({ sensitive: true });
    const input = z.object({
      plain: z.string(),
      list: z.array(secret),
      nullableList: z.array(secret).nullable(),
      optionalList: z.array(secret).optional(),
      inner: secret.nullable().default(null),
      outer: z.string().nullable().meta({ sensitive: true }),
      wholeList: z.array(z.string()).meta({ sensitive: true }),
    });
    const [spec] = specs(definition({ input }));
    expect(spec!.sensitive).toEqual([
      'list',
      'nullableList',
      'optionalList',
      'inner',
      'outer',
      'wholeList',
    ]);
  });

  it('accepts every field type a form can show', () => {
    const input = z.object({
      text: z.string().max(10).meta({ label: 'Text', widget: 'textarea' }),
      count: z.int().min(0),
      amount: z.number().nullable(),
      flag: z.boolean().default(false),
      choice: z.enum(['a', 'b']).optional(),
      day: z.iso.date(),
      at: z.iso.datetime().nullable().default(null),
      tags: z.array(z.string()),
      users: z.array(ref('users')).optional(),
      token: z.string().meta({ sensitive: true }),
      checked: z.string().refine((s) => s.length > 1),
    });
    const [spec] = specs(definition({ input }));
    expect(spec!.refs).toEqual([{ field: 'users', entity: 'users', many: true }]);
    expect(spec!.sensitive).toEqual(['token']);
    expect(spec!.inputSchema.required).toEqual([
      'text',
      'count',
      'amount',
      'day',
      'tags',
      'token',
      'checked',
    ]);
  });

  it('reports every problem in every definition', () => {
    const result = checkActionDefinitions([
      definition(),
      definition({ label: '' }),
      definition({
        name: 'x',
        target: 'all',
        confirm: 'never',
        maxAffectedRows: 0,
        timeoutMs: -1,
        deadlineMs: 1.5,
      }),
      definition({ name: 'y', input: z.string() }),
      definition({ name: 'z', input: z.object({ v: z.unknown() }), run: undefined }),
      'not an object',
    ]);
    expect(result).toEqual({
      ok: false,
      errors: [
        'action "move-user": name is used by another action',
        'action "move-user": label is required',
        'action "x": target must be "one", "many" or "none"',
        'action "x": confirm must be "preview" or "confirm"',
        'action "x": maxAffectedRows must be a positive integer',
        'action "x": timeoutMs must be a positive integer',
        'action "x": deadlineMs must be a positive integer',
        'action "y": input must be a z.object() from the zod Warden passes in',
        'action "z": run must be a function',
        'action "z": input field "v": only strings, numbers, booleans, enums and dates are supported',
        'action 5: expected an object from defineAction',
      ],
    });
  });

  it('bounds every array field, keeping a bound the schema sets', () => {
    const input = z.object({
      tags: z.array(z.string()),
      few: z.array(z.string()).max(3),
      users: z.array(ref('users')).nullable(),
    });
    const [spec] = specs(definition({ input, deadlineMs: 5000 }));
    expect(spec!.deadlineMs).toBe(5000);
    const { properties } = spec!.inputSchema;
    expect(properties.tags!.maxItems).toBe(DEFAULT_MAX_INPUT_ITEMS);
    expect(properties.few!.maxItems).toBe(3);
    const users = (properties.users!.anyOf as Record<string, unknown>[] | undefined)?.find(
      (p) => p.type === 'array',
    );
    expect(users?.maxItems ?? properties.users!.maxItems).toBe(DEFAULT_MAX_INPUT_ITEMS);

    const long = (n: number) => Array.from({ length: n }, (_, i) => String(i));
    expect(oversizedInputArrays(spec!.inputSchema, { tags: long(500), few: long(3) })).toEqual([]);
    expect(
      oversizedInputArrays(spec!.inputSchema, {
        tags: long(501),
        few: long(4),
        users: long(501),
        unknown: long(1000),
        text: 'not an array',
      }),
    ).toEqual([
      { field: 'tags', message: 'must hold at most 500 items' },
      { field: 'few', message: 'must hold at most 3 items' },
      { field: 'users', message: 'must hold at most 500 items' },
    ]);
  });

  it('allows no input', () => {
    const [spec] = specs(definition({ input: undefined }));
    expect(spec!.inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });
});

describe('resolveActionPolicy', () => {
  it('resolves tables to entity keys and applies config', () => {
    const { actionPolicy, warnings, errors } = resolve(
      specs(definition({ on: 'public.users', permissions: { 'billing.invoices': ['create'] } })),
      { actions: { 'move-user': { label: 'Relocate', requireReason: true } } },
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(actionPolicy.actions.get('move-user')).toMatchObject({
      on: 'users',
      label: 'Relocate',
      requireReason: true,
      permissions: { 'billing.invoices': ['create'] },
      refs: [{ field: 'company', entity: 'companies', many: false }],
    });
  });

  it('requires a reason when a table requires one for a write the action may make', () => {
    const required = (config: unknown) =>
      resolve(specs(definition()), config).actionPolicy.actions.get('move-user')!.requireReason;
    expect(required({})).toBe(false);
    expect(required({ tables: { orders: { requireReason: ['update'] } } })).toBe(true);
    // Writes the action can't make don't count.
    expect(required({ tables: { orders: { requireReason: ['delete'] } } })).toBe(false);
    expect(required({ tables: { companies: { requireReason: ['update'] } } })).toBe(false);
  });

  it.each([
    ['its entity', { on: 'secrets' }, 'table "secrets" is not exposed'],
    [
      'a table it writes',
      { permissions: { secrets: ['update'] } },
      'table "secrets" is not exposed',
    ],
    [
      'a table it picks from',
      { input: z.object({ s: ref('secrets') }) },
      'table "secrets" is not exposed',
    ],
    ['a missing table', { on: 'nope' }, 'table "nope" is not exposed'],
  ])('disables an action when %s is hidden or missing', (_, overrides, message) => {
    const { actionPolicy, warnings } = resolve(specs(definition(overrides)), {
      tables: { secrets: { hidden: true } },
    });
    expect(actionPolicy.actions.size).toBe(0);
    expect(warnings).toEqual([
      { path: 'actions.move-user', message: `${message}; the action is disabled` },
    ]);
  });

  it('disables an action whose permissions a table deny forbids', () => {
    const { actionPolicy, warnings } = resolve(specs(definition()), {
      tables: { orders: { deny: ['update'] } },
    });
    expect(actionPolicy.actions.size).toBe(0);
    expect(warnings[0]?.message).toBe(
      'its permissions include update on "orders", which config denies; the action is disabled',
    );
  });

  it('leaves out actions config disables, and warns about names nothing defines', () => {
    const { actionPolicy, warnings } = resolve(specs(definition()), {
      roles: { ops: { actions: ['move-user', 'ghost'] } },
      actions: { 'move-user': { disabled: true }, phantom: {} },
    });
    expect(actionPolicy.actions.size).toBe(0);
    expect(warnings).toEqual([
      { path: 'roles.ops.actions.1', message: 'action "ghost" is not defined' },
      { path: 'actions.phantom', message: 'action "phantom" is not defined' },
    ]);
  });

  it('fails a record action on an entity without a primary key', () => {
    const { errors } = resolve(specs(definition({ on: 'log', permissions: {}, input: undefined })));
    expect(errors).toEqual([
      'action "move-user": target "one" needs records, but "log" has no primary key',
    ]);
    expect(
      resolve(specs(definition({ on: 'log', target: 'none', permissions: {}, input: undefined })))
        .errors,
    ).toEqual([]);
  });
});

describe('canRunAction', () => {
  const config = {
    defaults: { read: 'granted' },
    roles: {
      ops: { grants: { users: ['read'], companies: ['read'] }, actions: ['move-user'] },
      all: { grants: { '*': ['read'] }, actions: ['*'] },
      blind: { grants: { users: ['read'] }, actions: ['move-user'] },
      none: { grants: { '*': ['read'] } },
    },
  };
  const { actionPolicy, policy } = resolve(specs(definition()), config);
  const can = (roles: string[], name = 'move-user') =>
    canRunAction(actionPolicy, policy, roles, name)?.name;

  it('needs a role that grants the action, by name or with *', () => {
    expect(can(['ops'])).toBe('move-user');
    expect(can(['all'])).toBe('move-user');
    expect(can(['none'])).toBeUndefined();
    expect(can([])).toBeUndefined();
    expect(can(['all'], 'nonexistent')).toBeUndefined();
  });

  it("doesn't need the table grants it writes with", () => {
    // ops may not update users or orders itself.
    expect(policy.roles.get('ops')?.byEntity.get('users')).toEqual(new Set(['read']));
    expect(can(['ops'])).toBe('move-user');
  });

  it('needs read on its entity and on every entity its input picks from', () => {
    // blind can read users but not companies, which the form's picker lists.
    expect(can(['blind'])).toBeUndefined();
    expect(can(['blind', 'none'])).toBe('move-user');
  });

  it('lists runnable actions by name', () => {
    expect(runnableActions(actionPolicy, policy, ['ops']).map((a) => a.name)).toEqual([
      'move-user',
    ]);
    expect(runnableActions(actionPolicy, policy, ['none'])).toEqual([]);
  });
});

describe('preview tokens', () => {
  const change = (overrides: Partial<ActionChange>): ActionChange => ({
    operation: 'update',
    entity: 'users',
    recordId: '1',
    before: { id: '1', name: 'a' },
    after: { id: '1', name: 'b' },
    diff: { name: { from: 'a', to: 'b' } },
    ...overrides,
  });
  const payload = (changes: ActionChange[], input: unknown = { b: 1, a: 2 }) =>
    previewTokenPayload({ name: 'x', input, records: ['1'], changes });

  it('ignores key order and fields an update leaves alone', () => {
    expect(payload([change({})], { a: 2, b: 1 })).toBe(
      payload([change({ before: { id: '1', name: 'a', other: 1 } })]),
    );
    expect(payload([change({})])).not.toBe(
      payload([change({ diff: { name: { from: 'a', to: 'c' } } })]),
    );
    expect(payload([change({})])).not.toBe(payload([change({ recordId: '2' })]));
  });

  it('compares creates by the values given, not ids from sequences', () => {
    const create = (id: string) =>
      change({
        operation: 'create',
        recordId: id,
        before: null,
        after: { id },
        values: { name: 'n' },
      });
    expect(payload([create('1')])).toBe(payload([create('2')]));
    expect(payload([create('1')])).not.toBe(payload([{ ...create('1'), values: { name: 'm' } }]));
  });
});

it('redacts sensitive input', () => {
  expect(redactInput({ a: 1, secret: 'x' }, ['secret'])).toEqual({ a: 1, secret: '[redacted]' });
});
