// Actions for apps/server/test/actions.test.ts. Each exercises one path of the runtime.

/** Calls made by `afterCommit` callbacks, for the test to inspect. */
export const effects = (globalThis.__wardenActionEffects ??= []);

/** An error an SDK might throw: a 4xx `statusCode`, and a message not written for users. */
const upstreamError = () =>
  Object.assign(new Error('upstream said: select * from secrets where token=abc'), {
    statusCode: 400,
  });

/** @type {import('@wardenhq/actions').ActionsModule} */
export default ({ defineAction, z, ref, ActionError }) => [
  defineAction({
    name: 'move-user',
    label: 'Move to company',
    on: 'users',
    permissions: { users: ['update'], orders: ['update'] },
    input: z.object({
      company: ref('companies').meta({ label: 'New company' }),
      cancelPendingOrders: z.boolean().default(false),
      note: z.string().max(100).optional().meta({ sensitive: true }),
    }),
    defaults: ({ record, actor }) => ({ note: `${actor.subject}:${record?.label ?? ''}` }),
    async run({ tx, record: user, input, afterCommit }) {
      if (input.company.values.id === user.values.company_id) {
        throw new ActionError('already at that company', { field: 'company' });
      }
      await tx.update('users', user, { company_id: input.company.values.id });
      let cancelled = 0;
      if (input.cancelPendingOrders) {
        cancelled = await tx.updateMany(
          'orders',
          {
            and: [
              { field: 'user_id', op: 'eq', value: user.values.id },
              { field: 'status', op: 'eq', value: 'pending' },
            ],
          },
          { status: 'cancelled' },
        );
      }
      afterCommit(async () => {
        effects.push(`moved ${user.id}`);
      });
      return {
        message: `Moved ${user.label} to ${input.company.label} (${cancelled})`,
        redirect: { entity: 'users', id: user.id },
        extra: 'dropped',
      };
    },
  }),

  defineAction({
    name: 'rename-companies',
    label: 'Rename',
    on: 'companies',
    target: 'many',
    permissions: { companies: ['update'] },
    input: z.object({ suffix: z.string().min(1) }),
    async run({ tx, records, input }) {
      for (const company of records) {
        await tx.update('companies', company, { name: `${company.values.name}${input.suffix}` });
      }
    },
  }),

  defineAction({
    name: 'add-company',
    label: 'Add company',
    on: 'companies',
    target: 'none',
    confirm: 'confirm',
    permissions: { companies: ['create'] },
    input: z.object({ name: z.string().min(1), domain: z.string().optional() }),
    async run({ tx, input }) {
      const company = await tx.create('companies', {
        name: input.name,
        ...(input.domain ? { domain: input.domain } : {}),
      });
      return { redirect: { entity: 'companies', id: company.id } };
    },
  }),

  // Writes, then fails in each of the ways a run can fail.
  defineAction({
    name: 'fail-after-write',
    label: 'Fail',
    on: 'companies',
    permissions: { companies: ['update', 'create'], orders: ['update'], users: ['update'] },
    input: z.object({
      how: z.enum([
        'action-error',
        'crash',
        'upstream',
        'unreadable-field',
        'readable-field',
        'unreadable-entity',
        'outside-permissions',
        'hidden-column',
        'missing-column',
        'hidden-table',
        'missing-table',
        'denied-table',
        'read-only',
        'bad-value',
        'duplicate',
        'swallowed-duplicate',
        'unawaited',
        'cap',
      ]),
    }),
    maxAffectedRows: 3,
    // Fails too: with the author's error for company 20, otherwise like an SDK's.
    defaults: ({ record }) => {
      if (record?.id === '20') throw new ActionError('no defaults for this one');
      throw upstreamError();
    },
    async run({ tx, record, input, afterCommit }) {
      afterCommit(async () => {
        effects.push('should not run');
      });
      await tx.update('companies', record, { name: 'changed by a failed action' });
      switch (input.how) {
        case 'action-error':
          throw new ActionError('the author says no', { field: 'how' });
        case 'crash':
          throw new Error('internal details that must not leak');
        case 'upstream':
          throw upstreamError();
        case 'unreadable-field':
          await tx.update('users', '4', { last_login_at: 'yesterday' });
          break;
        case 'readable-field':
          await tx.update('users', '4', { full_name: 5 });
          break;
        case 'unreadable-entity':
          await tx.update('orders', '1', { status: 5 });
          break;
        case 'outside-permissions':
          await tx.delete('companies', record);
          break;
        case 'hidden-column':
          await tx.list('users', { filter: { field: 'password_hash', op: 'eq', value: 'x' } });
          break;
        case 'missing-column':
          await tx.list('users', { filter: { field: 'nonexistent', op: 'eq', value: 'x' } });
          break;
        case 'hidden-table':
          await tx.list('secrets');
          break;
        case 'missing-table':
          await tx.list('nonexistent');
          break;
        case 'denied-table':
          await tx.get('vault', '1');
          break;
        case 'read-only':
          await tx.update('companies', record, { id: '1' });
          break;
        case 'bad-value':
          await tx.create('companies', { name: null });
          break;
        case 'duplicate':
          await tx.create('companies', { name: 'Dup', domain: record.values.domain });
          break;
        case 'swallowed-duplicate':
          // Postgres has aborted the transaction, so this must not commit or report success.
          try {
            await tx.create('companies', { name: 'Dup', domain: record.values.domain });
          } catch {
            try {
              await tx.get('companies', record.id);
            } catch {
              return { message: 'all good' };
            }
          }
          throw new Error('the failed transaction carried on');
        case 'unawaited':
          [1, 2].forEach(async (n) => {
            await tx.update('companies', record, { name: `unawaited ${n}` });
          });
          return { message: 'all good' };
        case 'cap':
          await tx.updateMany('orders', { field: 'status', op: 'isNotNull' }, { notes: 'capped' });
          break;
      }
    },
  }),

  // Sets no requireReason of its own, but config requires a reason to delete companies.
  defineAction({
    name: 'drop-company',
    label: 'Drop company',
    on: 'companies',
    permissions: { companies: ['delete'] },
    async run({ tx, record }) {
      await tx.delete('companies', record);
    },
  }),

  // Read-modify-write: adds 10 to an order's total, reading it with or without a lock.
  defineAction({
    name: 'add-ten',
    label: 'Add ten',
    on: 'orders',
    target: 'none',
    permissions: { orders: ['update'] },
    input: z.object({ order: z.string(), lock: z.boolean(), via: z.enum(['get', 'list']) }),
    async run({ tx, input }) {
      const order =
        input.via === 'get'
          ? await tx.get('orders', input.order, { lock: input.lock })
          : (
              await tx.list('orders', {
                filter: { field: 'id', op: 'eq', value: input.order },
                limit: 1,
                lock: input.lock,
              })
            )[0];
      await tx.update('orders', order, { total: Number(order.values.total) + 10 });
    },
  }),

  // Writes a field only admins can read, from free text, a picked record and a sensitive list.
  defineAction({
    name: 'stamp-login',
    label: 'Stamp login',
    on: 'users',
    permissions: { users: ['update'] },
    input: z.object({
      at: z.iso.datetime(),
      company: ref('companies').optional(),
      codes: z.array(z.string().meta({ sensitive: true })).optional(),
    }),
    async run({ tx, record, input }) {
      await tx.update('users', record, { last_login_at: input.at });
    },
  }),

  // Reads a hidden column through `tx.get`: it must simply be absent.
  defineAction({
    name: 'peek',
    label: 'Peek',
    on: 'users',
    permissions: {},
    async run({ tx, record }) {
      const again = await tx.get('users', record.id);
      const missing = await tx.get('users', '999999');
      const tampered = await tx.get('users', 'not-a-number');
      return {
        message: JSON.stringify({
          keys: Object.keys(again.values).sort(),
          missing,
          tampered,
        }),
      };
    },
  }),

  // Picks many records; they are looked up together.
  defineAction({
    name: 'pick-users',
    label: 'Pick users',
    on: 'users',
    target: 'none',
    permissions: {},
    input: z.object({ users: z.array(ref('users')) }),
    async run({ input }) {
      return { message: input.users.map((u) => u.id).join(',') };
    },
  }),

  // Never finishes, like a run awaiting a webhook that never answers.
  defineAction({
    name: 'hang',
    label: 'Hang',
    on: 'companies',
    target: 'none',
    permissions: {},
    deadlineMs: 1500,
    async run({ tx }) {
      await tx.get('companies', '1');
      await new Promise(() => {});
    },
  }),

  // Disabled at startup: config denies deleting orders.
  defineAction({
    name: 'purge-orders',
    label: 'Purge',
    on: 'orders',
    target: 'none',
    permissions: { orders: ['delete'] },
    async run({ tx }) {
      await tx.deleteMany('orders', { field: 'id', op: 'isNotNull' });
    },
  }),

  // Disabled at startup: its entity is hidden.
  defineAction({
    name: 'touch-secrets',
    label: 'Touch',
    on: 'secrets',
    target: 'none',
    permissions: {},
    async run() {},
  }),

  // Disabled in config.
  defineAction({
    name: 'switched-off',
    label: 'Off',
    on: 'companies',
    target: 'none',
    permissions: {},
    async run() {},
  }),
];
