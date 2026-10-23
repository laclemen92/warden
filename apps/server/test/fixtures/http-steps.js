// Multi-step HTTP actions for apps/server/test/http-steps.test.ts. The test API's base URL is set
// on globalThis before Warden loads this module.

const api = () => globalThis.__wardenStepsApi;
const hmac = { type: 'hmac', secretEnv: 'TEST_HMAC_SECRET' };

/** @type {import('@wardenhq/actions').ActionsModule} */
export default ({ defineAction, z, ActionError }) => [
  defineAction({
    name: 'resolve-review',
    label: 'Resolve review',
    on: 'users',
    target: 'one',
    input: z.object({ decision: z.enum(['fraudulent', 'not_fraudulent']) }),
    http: {
      auth: hmac,
      steps: [
        {
          name: 'payout',
          url: (ctx) => `${api()}/payouts/${ctx.record.values.id}/review`,
          body: ({ input, reason }) => ({ decision: input.decision, note: reason }),
          auditBody: { redact: ['secret'] },
        },
        {
          name: 'claim',
          url: (_ctx, prev) => `${api()}/claims/${prev.payout.body.claimId}/resolve`,
          body: ({ input }, prev) => ({
            decision: input.decision,
            payoutStatus: prev.payout.status,
          }),
          when: ({ input }) => input.decision === 'fraudulent',
        },
        {
          name: 'notify',
          url: () => `${api()}/notify`,
          method: 'PUT',
          body: (_ctx, prev) => ({ claimed: 'claim' in prev }),
        },
      ],
    },
  }),
  defineAction({
    name: 'three-with-undo',
    label: 'Three steps with undo',
    on: 'companies',
    target: 'none',
    http: {
      auth: hmac,
      steps: [
        {
          name: 'first',
          url: () => `${api()}/first`,
          compensate: { url: () => `${api()}/first/undo`, method: 'DELETE' },
        },
        {
          name: 'second',
          url: () => `${api()}/second`,
          compensate: {
            url: (_ctx, prev) => `${api()}/second/undo/${prev.second.body.id}`,
            body: () => ({ undo: true }),
          },
        },
        { name: 'third', url: () => `${api()}/third` },
      ],
    },
  }),
  defineAction({
    name: 'needs-body',
    label: 'Second step reads the first, which keeps nothing',
    on: 'companies',
    target: 'none',
    http: {
      auth: hmac,
      steps: [
        { name: 'make', url: () => `${api()}/make` },
        { name: 'use', url: (_ctx, prev) => `${api()}/use/${prev.make.body.id}` },
      ],
    },
  }),
  defineAction({
    name: 'slow-steps',
    label: 'Slow steps',
    on: 'companies',
    target: 'none',
    deadlineMs: 1000,
    http: {
      auth: hmac,
      timeoutMs: 5000,
      steps: [
        { name: 'one', url: () => `${api()}/slow/one` },
        { name: 'two', url: () => `${api()}/slow/two` },
        { name: 'three', url: () => `${api()}/slow/three` },
      ],
    },
  }),
  defineAction({
    name: 'steps-as-user',
    label: 'Steps as you',
    on: 'companies',
    target: 'none',
    http: {
      auth: { type: 'user', audience: 'https://api.test' },
      steps: [
        { name: 'a', url: () => `${api()}/user/a` },
        { name: 'b', url: () => `${api()}/user/b` },
      ],
    },
  }),
  defineAction({
    name: 'refuses-later',
    label: 'Second step refuses',
    on: 'companies',
    target: 'none',
    http: {
      auth: hmac,
      steps: [
        { name: 'a', url: () => `${api()}/refuse/a` },
        {
          name: 'b',
          url: (_ctx, prev) => {
            if (prev.a.body.locked) throw new ActionError('The payout is locked');
            return `${api()}/refuse/b`;
          },
        },
      ],
    },
  }),
  defineAction({
    name: 'secret-input',
    label: 'Sensitive input',
    on: 'companies',
    target: 'none',
    input: z.object({ token: z.string().meta({ sensitive: true }) }),
    http: {
      auth: hmac,
      steps: [
        { name: 'a', url: () => `${api()}/secret/a` },
        { name: 'b', url: () => `${api()}/secret/b` },
      ],
    },
  }),
  defineAction({
    name: 'steps-not-granted',
    label: 'Not granted',
    on: 'companies',
    target: 'none',
    http: { auth: hmac, steps: [{ name: 'a', url: () => `${api()}/never` }] },
  }),
];
