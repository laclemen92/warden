import { wardenConfigSchema } from '@wardenhq/config';
import { describe, expect, it } from 'vitest';
import { lastHolderRoles } from '../src/index.js';

const parse = (access: unknown) =>
  wardenConfigSchema.parse({
    roles: {
      viewer: {},
      owner: { admin: ['roles'] },
      root: { admin: ['schema', 'roles'] },
      auditor: { admin: ['audit'] },
    },
    access,
  });

describe('lastHolderRoles', () => {
  it('protects every role that can manage roles when no access rule grants one', () => {
    for (const access of [
      { allowAll: true },
      { groups: { staff: ['viewer', 'auditor'] }, emailDomains: { 'example.com': ['viewer'] } },
    ]) {
      const { roles, access: rules } = parse(access);
      expect(lastHolderRoles(roles, rules)).toEqual(['owner', 'root']);
    }
  });

  it('protects nothing when a group or email domain grants one', () => {
    for (const access of [
      { groups: { admins: ['root'] } },
      { emailDomains: { 'example.com': ['viewer', 'owner'] } },
    ]) {
      const { roles, access: rules } = parse(access);
      expect(lastHolderRoles(roles, rules)).toEqual([]);
    }
  });

  it('protects nothing when no role can manage roles', () => {
    const { roles, access } = wardenConfigSchema.parse({
      roles: { viewer: {}, auditor: { admin: ['audit'] } },
      access: { allowAll: true },
    });
    expect(lastHolderRoles(roles, access)).toEqual([]);
  });
});
