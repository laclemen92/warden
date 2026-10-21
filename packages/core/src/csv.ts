import type { Field } from './effective-schema.js';
import { fieldCategory } from './filter.js';

// Spreadsheets run a cell that starts with one of these as a formula (CSV injection). Some trim
// leading whitespace first, some read full-width forms as ASCII, and some locales start formulas
// (or DDE calls) with `|` or `;`, so all of those count.
const FORMULA_START = /^[\t\r]|^[\s\p{Cc}\p{Cf}]*[=+\-@|;＝＋－＠｜；]/u;

/**
 * One CSV cell (RFC 4180). Nulls are empty, JSON and arrays are serialized, and text that a
 * spreadsheet would run as a formula is prefixed with `'`. Numbers and dates are left alone: a
 * negative number is data, and can't hold a formula.
 */
export function csvCell(field: Field, value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const category = fieldCategory(field);
  if (category !== 'number' && category !== 'temporal' && FORMULA_START.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One CSV line, ending in CRLF as RFC 4180 has it. */
export function csvRow(fields: readonly Field[], row: Record<string, unknown>): string {
  return `${fields.map((f) => csvCell(f, row[f.name])).join(',')}\r\n`;
}

/** The header line: column names, so the file round-trips into the database. */
export function csvHeader(fields: readonly Field[]): string {
  return `${fields.map((f) => csvCell({ ...f, dataType: 'text', isArray: false }, f.name)).join(',')}\r\n`;
}
