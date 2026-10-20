import { describe, expect, it } from 'vitest';
import {
  csvCell,
  csvHeader,
  csvRow,
  projectAuditEntry,
  type AuditEntry,
  type Field,
} from '../src/index.js';

const field = (name: string, dataType: string, extra: Partial<Field> = {}): Field => ({
  name,
  label: name,
  dataType,
  formattedType: dataType,
  isArray: false,
  nullable: true,
  hasDefault: false,
  readOnly: false,
  ...extra,
});
const text = field('notes', 'text');

describe('csvCell', () => {
  it('quotes only when needed, doubling quotes', () => {
    expect(csvCell(text, 'plain')).toBe('plain');
    expect(csvCell(text, 'a,b')).toBe('"a,b"');
    expect(csvCell(text, 'say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(text, 'two\nlines')).toBe('"two\nlines"');
    expect(csvCell(text, 'cr\r')).toBe('"cr\r"');
  });

  it('writes nulls as empty and JSON as JSON', () => {
    expect(csvCell(text, null)).toBe('');
    expect(csvCell(field('meta', 'jsonb'), { a: [1, 'x'] })).toBe('"{""a"":[1,""x""]}"');
    expect(csvCell(field('tags', 'text', { isArray: true }), ['a', 'b'])).toBe('"[""a"",""b""]"');
    expect(csvCell(field('ok', 'bool'), false)).toBe('false');
  });

  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx', '=HYPERLINK("http://x")'])(
    'defuses a formula in text (%j)',
    (value) => {
      const cell = csvCell(text, value);
      expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
    },
  );

  it('leaves numbers and dates alone, even negative ones', () => {
    expect(csvCell(field('total', 'numeric'), '-12.50')).toBe('-12.50');
    expect(csvCell(field('n', 'int4'), -3)).toBe('-3');
    expect(csvCell(field('d', 'date'), '-0044-03-15')).toBe('-0044-03-15');
  });

  it('defuses formulas in enums and uuids too', () => {
    expect(csvCell(field('s', 'mood', { enumValues: ['=x'] }), '=x')).toBe("'=x");
  });
});

describe('csvRow and csvHeader', () => {
  const fields = [field('id', 'int8'), text];
  it('ends lines with CRLF and follows field order', () => {
    expect(csvHeader(fields)).toBe('id,notes\r\n');
    expect(csvRow(fields, { notes: 'x', id: '1', other: 'ignored' })).toBe('1,x\r\n');
    expect(csvRow(fields, {})).toBe(',\r\n');
  });
});

describe('export audit details', () => {
  const entry: AuditEntry = {
    id: '1',
    occurredAt: '2026-01-01T00:00:00Z',
    requestId: null,
    actor: { subject: 'a', email: null, roles: [] },
    action: 'export',
    entity: 'users',
    recordId: null,
    reason: null,
    before: null,
    after: null,
    diff: {},
    details: {
      rowCount: 3,
      columns: ['id', 'email', 'salary'],
      filter: {
        and: [{ field: 'email', op: 'isNotNull' }, { not: { field: 'salary', op: 'isNull' } }],
      },
      q: 'ada',
      searchFields: ['email'],
      sort: '-email',
    },
  };

  it('keeps everything the reader can see', () => {
    expect(projectAuditEntry(entry, ['id', 'email', 'salary']).details).toEqual(entry.details);
  });

  it("drops columns, and any filter or sort, naming fields the reader can't see", () => {
    expect(projectAuditEntry(entry, ['id', 'email']).details).toEqual({
      columns: ['id', 'email'],
      q: 'ada',
      searchFields: ['email'],
      sort: '-email',
      redacted: true,
    });
    expect(
      projectAuditEntry({ ...entry, details: { ...entry.details!, sort: '+salary,id' } }, [
        'id',
        'email',
      ]).details,
    ).not.toHaveProperty('sort');
  });

  it("drops the search, and the row count, when it ran over a field the reader can't see", () => {
    const searched = { ...entry, details: { rowCount: 3, columns: ['id'], q: 'ceo@x.com' } };
    const over = (searchFields: string[]) =>
      projectAuditEntry({ ...searched, details: { ...searched.details, searchFields } }, [
        'id',
        'full_name',
      ]).details;
    expect(over(['email', 'full_name'])).toEqual({ columns: ['id'], redacted: true });
    expect(over(['full_name'])).toEqual({ ...searched.details, searchFields: ['full_name'] });
    // A search that matched against nothing reveals nothing.
    expect(over([])).toEqual({ ...searched.details, searchFields: [] });
    // Recorded before its fields were, so they're unknown.
    expect(projectAuditEntry(searched, ['id', 'email']).details).toEqual({
      columns: ['id'],
      redacted: true,
    });
  });

  it('keeps the row count when only the sort is left out', () => {
    const sorted = { ...entry, details: { rowCount: 3, columns: ['id'], sort: 'salary' } };
    expect(projectAuditEntry(sorted, ['id']).details).toEqual({
      rowCount: 3,
      columns: ['id'],
      redacted: true,
    });
  });

  it('leaves entries without details alone', () => {
    expect(projectAuditEntry({ ...entry, details: null }, ['id']).details).toBeNull();
  });
});
