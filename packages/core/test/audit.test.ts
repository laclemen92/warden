import { describe, expect, it } from 'vitest';
import { auditDiff } from '../src/audit.js';

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
