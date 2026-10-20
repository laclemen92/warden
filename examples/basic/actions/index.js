// Custom actions for the example schema. Warden loads this file when WARDEN_ACTIONS points at it
// and passes in `defineAction`, its own zod (`z`), `ref` and `ActionError`, so the file needs no
// packages at runtime. Who may run each action is set in warden.config.yaml (`roles.*.actions`).

/** @type {import('@wardenhq/actions').ActionsModule} */
export default ({ defineAction, z, ref, ActionError }) => [
  defineAction({
    name: 'move-user',
    label: 'Move to company',
    description: 'Move the user to another company, optionally cancelling their pending orders.',
    on: 'users',
    target: 'one',
    // Everything `run` may write. Config decides who may run it, and a table `deny` disables it.
    permissions: { users: ['update'], orders: ['update'] },
    input: z.object({
      company: ref('companies').meta({ label: 'New company' }),
      cancelPendingOrders: z
        .boolean()
        .default(false)
        .meta({ label: 'Cancel their pending orders' }),
    }),
    async run({ tx, record: user, input }) {
      if (input.company.values.id === user.values.company_id) {
        throw new ActionError(`${user.label} is already at ${input.company.label}`, {
          field: 'company',
        });
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
      return {
        message:
          `Moved ${user.label} to ${input.company.label}` +
          (cancelled > 0 ? ` and cancelled ${cancelled} pending order(s)` : ''),
      };
    },
  }),

  defineAction({
    name: 'deactivate-users',
    label: 'Deactivate',
    description: 'Stop the selected users from being active.',
    on: 'users',
    target: 'many',
    destructive: true,
    requireReason: true,
    permissions: { users: ['update'] },
    async run({ tx, records }) {
      for (const user of records) await tx.update('users', user, { is_active: false });
      return { message: `Deactivated ${records.length} user(s)` };
    },
  }),

  defineAction({
    name: 'cancel-stale-orders',
    label: 'Cancel stale orders',
    description: 'Cancel every pending order placed before a date.',
    on: 'orders',
    target: 'none',
    destructive: true,
    permissions: { orders: ['update'] },
    input: z.object({
      placedBefore: z.iso.date().meta({ label: 'Placed before' }),
    }),
    async run({ tx, input }) {
      const cancelled = await tx.updateMany(
        'orders',
        {
          and: [
            { field: 'status', op: 'eq', value: 'pending' },
            { field: 'placed_at', op: 'lt', value: input.placedBefore },
          ],
        },
        { status: 'cancelled' },
      );
      return { message: `Cancelled ${cancelled} order(s)` };
    },
  }),
];
