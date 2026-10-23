// HTTP actions for apps/server/test/http-actions.test.ts. The test API's base URL is set on
// globalThis before Warden loads this module.

const api = () => globalThis.__wardenTestApi;

/** @type {import('@wardenhq/actions').ActionsModule} */
export default ({ defineAction, z }) => [
  defineAction({
    name: 'review-user',
    label: 'Review user',
    on: 'users',
    target: 'one',
    input: z.object({ decision: z.enum(['approve', 'reject']) }),
    http: {
      url: (ctx) => `${api()}/review/${ctx.record.values.id}?source=warden`,
      body: ({ input, record, reason }) => ({
        decision: input.decision,
        email: record.values.email,
        note: reason,
      }),
      auth: { type: 'hmac', secretEnv: 'TEST_HMAC_SECRET' },
      timeoutMs: 500,
    },
  }),
  defineAction({
    name: 'review-many',
    label: 'Review each',
    on: 'users',
    target: 'many',
    http: {
      url: (ctx) => `${api()}/each/${ctx.record.values.id}`,
      auth: { type: 'hmac', secretEnv: 'TEST_HMAC_SECRET' },
      perRecord: true,
      concurrency: 2,
    },
  }),
  defineAction({
    name: 'review-slow',
    label: 'Review each, slowly',
    on: 'users',
    target: 'many',
    deadlineMs: 1000,
    http: {
      url: (ctx) => `${api()}/slow/${ctx.record.values.id}`,
      auth: { type: 'hmac', secretEnv: 'TEST_HMAC_SECRET' },
      perRecord: true,
      concurrency: 1,
    },
  }),
  defineAction({
    name: 'review-batch',
    label: 'Review together',
    on: 'users',
    target: 'many',
    http: {
      url: () => `${api()}/batch`,
      method: 'PUT',
      auth: { type: 'hmac', secretEnv: 'TEST_HMAC_SECRET' },
    },
  }),
  defineAction({
    name: 'm2m-ping',
    label: 'Ping as Warden',
    on: 'companies',
    target: 'none',
    http: {
      url: () => `${api()}/m2m`,
      auth: {
        type: 'client_credentials',
        tokenUrl: `${api()}/oauth/token`,
        clientIdEnv: 'TEST_CLIENT_ID',
        clientSecretEnv: 'TEST_CLIENT_SECRET',
        audience: 'https://api.test',
        secretEnv: 'TEST_HMAC_SECRET',
      },
    },
  }),
  defineAction({
    name: 'as-user',
    label: 'Ping as you',
    on: 'companies',
    target: 'none',
    http: {
      url: () => `${api()}/as-user`,
      auth: { type: 'user', audience: 'https://api.test' },
    },
  }),
  defineAction({
    name: 'off-site',
    label: 'Calls plain http',
    on: 'companies',
    target: 'none',
    http: {
      url: () => 'http://example.com/hook',
      auth: { type: 'hmac', secretEnv: 'TEST_HMAC_SECRET' },
    },
  }),
  defineAction({
    name: 'not-granted',
    label: 'Not granted',
    on: 'companies',
    target: 'none',
    http: { url: () => `${api()}/never`, auth: { type: 'hmac', secretEnv: 'TEST_HMAC_SECRET' } },
  }),
];
