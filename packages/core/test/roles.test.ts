import { wardenConfigSchema } from '@wardenhq/config';
import { describe, expect, it } from 'vitest';
import { assignmentEmail, parseEmail, resolveRoles, sessionEmail } from '../src/index.js';

const access = (rules: unknown) =>
  wardenConfigSchema.parse({
    roles: { viewer: {}, ops: {}, admin: {} },
    access: rules,
  }).access;

const rules = access({
  groups: { 'warden-admins': ['admin'], 'warden-ops': ['ops', 'viewer'] },
  emailDomains: { 'Example.com': ['viewer'] },
});

const user = (claims: Record<string, unknown>) => ({
  sub: 'u1',
  email: 'u1@example.com',
  email_verified: true,
  ...claims,
});

describe('resolveRoles', () => {
  it('lets nobody in when access is not configured', () => {
    expect(resolveRoles(undefined, user({}))).toBeUndefined();
    expect(resolveRoles(undefined, { sub: 'x' })).toBeUndefined();
    expect(resolveRoles(undefined, user({}), ['viewer'])).toBeUndefined();
  });

  it('lets everyone in with allowAll, with roles only from matching rules', () => {
    const open = access({ allowAll: true });
    expect(resolveRoles(open, user({}))).toEqual([]);
    expect(resolveRoles(open, { sub: 'x' })).toEqual([]);
    expect(resolveRoles(open, user({}), ['ops'])).toEqual(['ops']);
    const openWithRules = access({ allowAll: true, emailDomains: { 'example.com': ['viewer'] } });
    expect(resolveRoles(openWithRules, user({}))).toEqual(['viewer']);
    expect(resolveRoles(openWithRules, user({ email: 'u@example.org' }))).toEqual([]);
  });

  it('assigns roles by email domain, case-insensitively', () => {
    expect(resolveRoles(rules, user({}))).toEqual(['viewer']);
    expect(resolveRoles(rules, user({ email: 'U1@EXAMPLE.COM' }))).toEqual(['viewer']);
  });

  it('combines group and domain roles without duplicates', () => {
    expect(resolveRoles(rules, user({ groups: ['warden-ops', 'warden-admins', 'other'] }))).toEqual(
      ['admin', 'ops', 'viewer'],
    );
  });

  it('assigns group roles regardless of email', () => {
    expect(
      resolveRoles(rules, { sub: 'u', email: 'u@elsewhere.org', groups: ['warden-admins'] }),
    ).toEqual(['admin']);
    expect(resolveRoles(rules, { sub: 'u', groups: 'warden-admins' })).toEqual(['admin']);
  });

  it('reads groups from the configured claim', () => {
    const custom = access({ groupsClaim: 'roles', groups: { Admins: ['admin'] } });
    expect(resolveRoles(custom, { sub: 'u', roles: ['Admins'] })).toEqual(['admin']);
    expect(resolveRoles(custom, { sub: 'u', groups: ['Admins'] })).toBeUndefined();
  });

  it('denies users that match no rule', () => {
    expect(resolveRoles(rules, user({ email: 'u@example.org' }))).toBeUndefined();
    expect(resolveRoles(rules, { sub: 'u' })).toBeUndefined();
    expect(resolveRoles(access({}), user({ groups: ['warden-admins'] }))).toBeUndefined();
  });

  it('matches the exact domain only', () => {
    for (const email of [
      'u@sub.example.com',
      'u@example.com.evil.org',
      'u@notexample.com',
      'example.com@evil.org',
      'u@example.com@evil.org',
      '@example.com',
      'example.com',
    ]) {
      expect(resolveRoles(rules, user({ email })), email).toBeUndefined();
    }
  });

  it('ignores unverified emails unless configured not to', () => {
    for (const email_verified of [false, 'false', undefined, 1, null]) {
      expect(resolveRoles(rules, user({ email_verified })), String(email_verified)).toBeUndefined();
    }
    expect(resolveRoles(rules, user({ email_verified: 'true' }))).toEqual(['viewer']);
    const trusting = access({
      emailDomains: { 'example.com': ['viewer'] },
      requireVerifiedEmail: false,
    });
    expect(resolveRoles(trusting, user({ email_verified: false }))).toEqual(['viewer']);
  });

  it('ignores malformed claims', () => {
    for (const groups of [{ 'warden-admins': true }, 42, null, [42, { a: 1 }]]) {
      expect(resolveRoles(rules, { sub: 'u', groups })).toBeUndefined();
    }
    expect(resolveRoles(rules, { sub: 'u', email: ['u@example.com'], email_verified: true })).toBe(
      undefined,
    );
  });

  it('does not match inherited object keys as groups', () => {
    for (const group of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(resolveRoles(rules, { sub: 'u', groups: [group] }), group).toBeUndefined();
    }
  });
});

describe('resolveRoles with in-app assignments', () => {
  it('merges assigned roles with config-resolved ones', () => {
    expect(resolveRoles(rules, user({}), ['ops', 'viewer'])).toEqual(['ops', 'viewer']);
    expect(resolveRoles(rules, user({ groups: ['warden-admins'] }), ['ops'])).toEqual([
      'admin',
      'ops',
      'viewer',
    ]);
  });

  it('lets in a user that no access rule matches when they have an assignment', () => {
    const outsider = user({ email: 'u@example.org' });
    expect(resolveRoles(rules, outsider)).toBeUndefined();
    expect(resolveRoles(rules, outsider, [])).toBeUndefined();
    expect(resolveRoles(rules, outsider, ['ops'])).toEqual(['ops']);
  });

  it('dedupes and sorts assigned roles', () => {
    expect(resolveRoles(rules, user({}), ['ops', 'admin', 'ops'])).toEqual([
      'admin',
      'ops',
      'viewer',
    ]);
  });
});

describe('assignmentEmail', () => {
  it('is the verified email, lowercased', () => {
    expect(assignmentEmail(rules, user({ email: 'U1@Example.COM' }))).toBe('u1@example.com');
    expect(assignmentEmail(undefined, user({}))).toBe('u1@example.com');
  });

  it('requires a verified email unless configured not to', () => {
    for (const email_verified of [false, 'false', undefined, 1, null]) {
      expect(assignmentEmail(rules, user({ email_verified })), String(email_verified)).toBe(
        undefined,
      );
      expect(assignmentEmail(undefined, user({ email_verified }))).toBeUndefined();
    }
    const trusting = access({ requireVerifiedEmail: false });
    expect(assignmentEmail(trusting, user({ email_verified: false }))).toBe('u1@example.com');
  });

  it('ignores missing and malformed emails', () => {
    for (const email of [undefined, 42, ['u@example.com'], 'not-an-email', ' u@example.com']) {
      expect(assignmentEmail(rules, user({ email })), String(email)).toBeUndefined();
    }
  });
});

describe('parseEmail', () => {
  it('trims and lowercases', () => {
    expect(parseEmail('  Ada@Example.COM ')).toBe('ada@example.com');
  });

  it('rejects anything that could never be an email', () => {
    for (const value of [
      '',
      'ada',
      'ada@example',
      '@example.com',
      'ada@',
      'a da@example.com',
      'a@b@example.com',
      `${'a'.repeat(250)}@example.com`,
      42,
      null,
      ['ada@example.com'],
    ]) {
      expect(parseEmail(value), String(value)).toBeUndefined();
    }
  });
});

describe('sessionEmail', () => {
  it('is the verified email, as the IdP sent it', () => {
    expect(sessionEmail(rules, user({ email: 'U1@Example.COM' }))).toBe('U1@Example.COM');
    expect(sessionEmail(rules, user({ email_verified: 'true' }))).toBe('u1@example.com');
  });

  it('is absent when the email is unverified, even without access rules', () => {
    for (const email_verified of [false, 'false', undefined, 1, null]) {
      expect(sessionEmail(rules, user({ email_verified })), String(email_verified)).toBe(undefined);
      expect(sessionEmail(undefined, user({ email_verified }))).toBeUndefined();
    }
  });

  it('trusts an unverified email when requireVerifiedEmail is off', () => {
    const trusting = access({ requireVerifiedEmail: false });
    expect(sessionEmail(trusting, user({ email_verified: false }))).toBe('u1@example.com');
    expect(sessionEmail(trusting, user({ email_verified: undefined }))).toBe('u1@example.com');
  });

  it('is absent when the email is missing or not a string', () => {
    for (const email of [undefined, '', 42, ['u1@example.com'], null]) {
      expect(sessionEmail(rules, user({ email })), String(email)).toBeUndefined();
    }
  });
});

// Each folds onto, or passes for, "kate@kite.io" somewhere: KELVIN SIGN lowercases to "k",
// Turkish dotted capital I lowercases to "i" plus a combining dot, dotless i reads as "i",
// and full-width letters fold to ASCII under NFKC.
const LOOK_ALIKES = [
  '\u212Aate@kite.io',
  'kate@\u212Aite.io',
  'kate@k\u0131te.io',
  'kate@K\u0130TE.io',
  '\uFF4Bate@kite.io',
  'kate@\uFF4Bite.io',
];

describe('look-alike emails', () => {
  const kite = access({ emailDomains: { 'kite.io': ['viewer'] } });

  it('never match an assignment', () => {
    expect(assignmentEmail(kite, user({ email: 'Kate@KITE.io' }))).toBe('kate@kite.io');
    for (const email of LOOK_ALIKES) {
      expect(assignmentEmail(kite, user({ email })), email).toBeUndefined();
    }
  });

  it('never match an email domain', () => {
    expect(resolveRoles(kite, user({ email: 'kate@KITE.io' }))).toEqual(['viewer']);
    for (const email of LOOK_ALIKES) {
      expect(resolveRoles(kite, user({ email })), email).toBeUndefined();
    }
  });

  it('are refused as admin input, like any non-ASCII address', () => {
    for (const email of [...LOOK_ALIKES, 'jos\u00e9@example.com', 'kate@b\u00fccher.example']) {
      expect(parseEmail(email), email).toBeUndefined();
    }
    expect(parseEmail('kate@xn--bcher-kva.example')).toBe('kate@xn--bcher-kva.example');
  });

  it('are still shown as the session email, which matches nothing', () => {
    expect(sessionEmail(kite, user({ email: '\u212Aate@kite.io' }))).toBe('\u212Aate@kite.io');
  });
});
