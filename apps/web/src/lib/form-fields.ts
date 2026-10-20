import {
  fieldCategory,
  recordSchema,
  toFieldErrors,
  type Entity,
  type Field,
  type FieldError,
  type Relation,
  type WriteMode,
} from '@wardenhq/core';

/**
 * Conversion between field values as the API returns them and the strings form inputs hold.
 * Every widget edits a string (its "draft"); `fromDraft` turns it back into a value the write
 * endpoints accept, and the core write schema then checks it exactly as the server will.
 */
export type Widget =
  'text' | 'textarea' | 'number' | 'boolean' | 'enum' | 'date' | 'time' | 'datetime' | 'json';

export type Drafts = Record<string, string>;

// Longer limits (or none) get a multi-line input.
const SINGLE_LINE_MAX = 255;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)\d*$/;
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)\d*$/;
const TIMESTAMPTZ =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)\d*(Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * The input for a field. Arrays and JSON are edited as JSON text. Native date/time pickers are
 * used only where they can show the stored value: `initial` (the value being edited, if any) that
 * a picker can't represent (`infinity`, BC dates, a time zone offset) falls back to plain text.
 */
export function widgetFor(field: Field, initial?: unknown): Widget {
  if (field.isArray) return 'json';
  switch (fieldCategory(field)) {
    case 'text':
      return field.maxLength !== undefined && field.maxLength <= SINGLE_LINE_MAX
        ? 'text'
        : 'textarea';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'enum':
      return 'enum';
    case 'json':
      return 'json';
    case 'temporal': {
      const widget = temporalWidget(field.dataType);
      if (widget && (initial === null || initial === undefined)) return widget;
      if (widget && typeof initial === 'string' && temporalDraft(field, initial) !== undefined) {
        return widget;
      }
      return 'text';
    }
    default:
      return 'text';
  }
}

function temporalWidget(dataType: string): Widget | undefined {
  switch (dataType) {
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    case 'timestamp':
    case 'timestamptz':
      return 'datetime';
    // A time picker can't hold the offset of a `timetz`.
    default:
      return undefined;
  }
}

/** A stored date/time as a native picker's value, or undefined when it can't show it. */
function temporalDraft(field: Field, value: string): string | undefined {
  switch (field.dataType) {
    case 'date':
      return DATE.test(value) ? value : undefined;
    case 'time':
      return TIME.exec(value)?.[1];
    case 'timestamp': {
      const match = TIMESTAMP.exec(value);
      return match ? `${match[1]}T${match[2]}` : undefined;
    }
    case 'timestamptz': {
      // Shown in the browser's time zone, since that's what the picker edits.
      const match = TIMESTAMPTZ.exec(value);
      if (!match) return undefined;
      const offset = match[3]!.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
      const date = new Date(
        `${match[1]}T${match[2]}${offset.length === 3 ? `${offset}:00` : offset}`,
      );
      return Number.isNaN(date.getTime()) ? undefined : toLocalInput(date);
    }
    default:
      return undefined;
  }
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `YYYY-MM-DDTHH:MM:SS[.mmm]` in local time, as `<input type="datetime-local">` takes it. */
function toLocalInput(date: Date): string {
  const ms = date.getMilliseconds();
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    (ms ? `.${pad(ms, 3)}` : '')
  );
}

/** The draft an input starts with for `value` (null and undefined start empty). */
export function toDraft(field: Field, widget: Widget, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (widget === 'json') return JSON.stringify(value, null, 2);
  if (
    (widget === 'date' || widget === 'time' || widget === 'datetime') &&
    typeof value === 'string'
  ) {
    return temporalDraft(field, value) ?? value;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export type DraftValue = { value: unknown } | { omit: true } | { error: string };

/**
 * The value to send for a draft. A blank draft means "use the default" when creating a field
 * that has one, null when the field is nullable, and is otherwise missing.
 */
export function fromDraft(
  field: Field,
  widget: Widget,
  draft: string,
  mode: WriteMode,
): DraftValue {
  // Whitespace is text like any other, but nothing else.
  const blank = widget === 'text' || widget === 'textarea' ? draft === '' : draft.trim() === '';
  if (blank) {
    if (mode === 'create' && field.hasDefault) return { omit: true };
    if (field.nullable) return { value: null };
    return { error: 'is required' };
  }
  switch (widget) {
    case 'number':
      return { value: draft.trim() };
    case 'boolean':
      return { value: draft === 'true' };
    case 'json':
      try {
        return { value: JSON.parse(draft) as unknown };
      } catch {
        return { error: 'is not valid JSON' };
      }
    case 'datetime':
      // The picker edits local time; send it as an instant.
      if (field.dataType === 'timestamptz') {
        const date = new Date(draft);
        return Number.isNaN(date.getTime())
          ? { error: 'is not a valid date/time' }
          : { value: date.toISOString() };
      }
      return { value: draft };
    default:
      return { value: draft };
  }
}

/**
 * The `belongsTo` relations edited with a record picker, keyed by the field each is shown at (its
 * first column; the other columns of a composite key are set by the same picker). A column in more
 * than one foreign key gets a picker for the first only, and a key with a read-only column gets
 * none: its columns are shown like any others.
 */
export function pickerRelations(entity: Entity): Map<string, Relation> {
  const pickers = new Map<string, Relation>();
  const covered = new Set<string>();
  for (const relation of entity.relations) {
    if (relation.kind !== 'belongsTo') continue;
    if (relation.columns.some((c) => covered.has(c))) continue;
    // A picker sets every column, so it needs every column to be writable.
    const fields = relation.columns.map((c) => entity.fields.find((f) => f.name === c));
    if (fields.some((f) => !f || f.readOnly)) continue;
    relation.columns.forEach((c) => covered.add(c));
    pickers.set(relation.columns[0]!, relation);
  }
  return pickers;
}

export interface FormField {
  field: Field;
  widget: Widget;
}

/**
 * The fields a form shows. Hidden and unreadable fields aren't in the entity at all; read-only
 * ones are left out of a create form (the database fills them) and shown, disabled, when editing.
 */
export function formFields(entity: Entity, mode: WriteMode, record?: Record<string, unknown>) {
  return entity.fields
    .filter((f) => mode === 'update' || !f.readOnly)
    .map((field): FormField => ({ field, widget: widgetFor(field, record?.[field.name]) }));
}

export function initialDrafts(fields: FormField[], record?: Record<string, unknown>): Drafts {
  const drafts: Drafts = {};
  for (const { field, widget } of fields) {
    // A required checkbox starts unchecked, which is a value of its own.
    drafts[field.name] =
      record === undefined && widget === 'boolean' && !field.nullable && !field.hasDefault
        ? 'false'
        : toDraft(field, widget, record?.[field.name]);
  }
  return drafts;
}

export type FormErrors = Record<string, string[]>;

/** Key for errors that concern the record as a whole. */
export const RECORD_ERRORS = '';

export function groupErrors(errors: FieldError[]): FormErrors {
  const grouped: FormErrors = {};
  for (const { field, message } of errors) {
    (grouped[field ?? RECORD_ERRORS] ??= []).push(message);
  }
  return grouped;
}

export type FormValues =
  { ok: true; values: Record<string, unknown> } | { ok: false; errors: FormErrors };

/**
 * The payload for a write, or the errors that stop it, checked with the same schema the server
 * uses. A create sends every field that has a value; an update sends only the fields that changed.
 */
export function formValues(
  entity: Entity,
  fields: FormField[],
  drafts: Drafts,
  mode: WriteMode,
  initial?: Drafts,
): FormValues {
  const values: Record<string, unknown> = {};
  const errors: FieldError[] = [];
  for (const { field, widget } of fields) {
    if (field.readOnly) continue;
    const draft = drafts[field.name] ?? '';
    if (mode === 'update' && draft === initial?.[field.name]) continue;
    const result = fromDraft(field, widget, draft, mode);
    if ('error' in result) errors.push({ field: field.name, message: result.error });
    else if ('value' in result) values[field.name] = result.value;
  }
  const parsed = recordSchema(entity, mode).safeParse(values);
  if (!parsed.success) {
    // A field that couldn't be converted is reported once, for the conversion.
    const failed = new Set(errors.map((e) => e.field));
    errors.push(...toFieldErrors(parsed.error).filter((e) => !failed.has(e.field)));
  }
  return errors.length > 0 ? { ok: false, errors: groupErrors(errors) } : { ok: true, values };
}
