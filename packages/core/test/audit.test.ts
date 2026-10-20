import { describe, expect, it } from 'vitest';
import { auditDiff, projectAuditEntry, type AuditEntry } from '../src/audit.js';

describe('auditDiff', () => {
  it('lists only changed fields on update', () => {
    expect(
      auditDiff(
        { id: '1', name: 'a', plan: 'free', meta: { a: 1 } },
        { id: '1', name: 'b', plan: 'free', meta: { a: 1 } },
      ),
    ).toEqual({ name: { from: 'a', to: 'b' } });
  });

  it('compares JSON documents and arrays by value', () => {
    expect(auditDiff({ meta: { a: [1, 2] } }, { meta: { a: [1, 2] } })).toEqual({});
    expect(auditDiff({ tags: ['a'] }, { tags: ['a', 'b'] })).toEqual({
      tags: { from: ['a'], to: ['a', 'b'] },
    });
  });

  it('distinguishes null from values that serialize like it', () => {
    expect(auditDiff({ a: null, b: 0, c: '' }, { a: 'null', b: null, c: null })).toEqual({
      a: { from: null, to: 'null' },
      b: { from: 0, to: null },
      c: { from: '', to: null },
    });
  });

  it('records every field on create and delete', () => {
    expect(auditDiff(null, { id: '1', note: null })).toEqual({
      id: { from: null, to: '1' },
      note: { from: null, to: null },
    });
    expect(auditDiff({ id: '1' }, null)).toEqual({ id: { from: '1', to: null } });
  });

  it('is empty when nothing changed', () => {
    expect(auditDiff({ id: '1', name: 'a' }, { id: '1', name: 'a' })).toEqual({});
  });
});

describe('projectAuditEntry', () => {
  const entry: AuditEntry = {
    id: '7',
    occurredAt: '2026-10-20T12:00:00+00:00',
    requestId: null,
    actor: { subject: 'ada', email: null, roles: ['admin'] },
    action: 'update',
    entity: 'users',
    recordId: '1',
    reason: null,
    before: { id: '1', email: 'a@x', salary: 1 },
    after: { id: '1', email: 'b@x', salary: 2 },
    diff: { email: { from: 'a@x', to: 'b@x' }, salary: { from: 1, to: 2 } },
    details: null,
  };

  it('keeps only the given fields in before, after, and diff', () => {
    expect(projectAuditEntry(entry, ['id', 'email'])).toEqual({
      ...entry,
      before: { id: '1', email: 'a@x' },
      after: { id: '1', email: 'b@x' },
      diff: { email: { from: 'a@x', to: 'b@x' } },
    });
  });

  it('keeps a missing side null', () => {
    const created = projectAuditEntry({ ...entry, action: 'create', before: null }, ['id']);
    expect(created.before).toBeNull();
    expect(created.after).toEqual({ id: '1' });
  });

  describe('reason', () => {
    // HR raised a salary; a trigger bumped updated_at.
    const raise: AuditEntry = {
      ...entry,
      reason: 'raise after retention threat',
      before: { id: '1', salary: 1, updated_at: 't1' },
      after: { id: '1', salary: 2, updated_at: 't2' },
      diff: { salary: { from: 1, to: 2 }, updated_at: { from: 't1', to: 't2' } },
    };
    const reason = (e: AuditEntry, fields: string[], written: string[] | null) =>
      projectAuditEntry(e, fields, written).reason;

    it("is dropped when the update set only fields the reader can't see", () => {
      expect(reason(raise, ['id', 'updated_at'], ['salary'])).toBeNull();
      expect(reason(raise, ['id', 'salary', 'updated_at'], ['salary'])).toBe(raise.reason);
    });

    it('ignores fields set but left unchanged', () => {
      expect(reason(raise, ['id', 'email', 'updated_at'], ['salary', 'email'])).toBeNull();
    });

    it('needs every changed field readable when the written fields are unknown', () => {
      expect(reason(raise, ['id', 'updated_at'], null)).toBeNull();
      expect(reason(raise, ['id', 'salary', 'updated_at'], null)).toBe(raise.reason);
    });

    it('is kept on creates and deletes, which every reader sees happen', () => {
      expect(reason({ ...raise, action: 'create' }, ['id'], ['salary'])).toBe(raise.reason);
      expect(reason({ ...raise, action: 'delete' }, ['id'], null)).toBe(raise.reason);
    });
  });

  it('ignores inherited property names', () => {
    const projected = projectAuditEntry(entry, ['constructor', '__proto__', 'toString']);
    expect(projected.before).toEqual({});
    expect(projected.diff).toEqual({});
  });
});
