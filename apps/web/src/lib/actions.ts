import { humanize, type AuditDiff, type FieldError } from '@wardenhq/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './api';

// Shapes served by apps/server/src/routes/actions.ts.
export type ActionTarget = 'one' | 'many' | 'none';

type JsonSchema = Record<string, unknown>;

export interface ActionDescriptor {
  name: string;
  label: string;
  description?: string;
  /** Entity key. */
  on: string;
  target: ActionTarget;
  confirm: 'preview' | 'confirm';
  destructive: boolean;
  requireReason: boolean;
  hasDefaults: boolean;
  inputSchema: { properties: Record<string, JsonSchema>; required?: string[] };
  /** Entity key → the writes the action can make. */
  permissions: Record<string, string[]>;
}

export interface ActionChange {
  operation: 'create' | 'update' | 'delete';
  entity: string;
  /** Null for rows of entities the user can't read, whose values aren't sent. */
  recordId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  diff: AuditDiff;
}

export interface ActionResult {
  message?: string;
  redirect?: { entity: string; id: string };
}

export interface ActionPreview {
  changes: ActionChange[];
  total: number;
  truncated: boolean;
  result: ActionResult;
  previewToken: string;
}

export interface ActionRun {
  auditId: string;
  result: ActionResult;
}

export interface ActionRequest {
  records?: string[];
  input: Record<string, unknown>;
  reason?: string;
  previewToken?: string;
}

// apps/server/src/routes/actions.ts: the run would change something other than what was
// previewed, as opposed to a constraint conflict.
export const PREVIEW_STALE_MESSAGE =
  'what this action would change has changed since it was previewed';

/** Actions the current user may run. The server checks every request either way. */
export function useActions() {
  return useQuery({
    queryKey: ['actions'],
    queryFn: () => apiFetch<{ actions: ActionDescriptor[] }>('/api/actions'),
    staleTime: Infinity,
  });
}

/** The current user's actions on an entity that run against `target`. */
export function useEntityActions(entityKey: string, target: ActionTarget): ActionDescriptor[] {
  const { data } = useActions();
  return data?.actions.filter((a) => a.on === entityKey && a.target === target) ?? [];
}

const actionUrl = (name: string) => `/api/actions/${encodeURIComponent(name)}`;

export function useActionDefaults(action: ActionDescriptor, recordId: string | undefined) {
  return useQuery({
    queryKey: ['action-defaults', action.name, recordId ?? null],
    enabled: action.hasDefaults,
    // Defaults may depend on the record as it is now.
    gcTime: 0,
    queryFn: () => {
      const params = recordId ? `?${new URLSearchParams({ record: recordId })}` : '';
      return apiFetch<{ values: Record<string, unknown> }>(
        `${actionUrl(action.name)}/defaults${params}`,
      );
    },
  });
}

const post = <T>(url: string, body: ActionRequest) =>
  apiFetch<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export function usePreviewAction(action: ActionDescriptor) {
  return useMutation({
    mutationFn: (body: ActionRequest) =>
      post<ActionPreview>(`${actionUrl(action.name)}/preview`, body),
  });
}

/** Run an action. An action can change rows anywhere, so every record query is refetched. */
export function useRunAction(action: ActionDescriptor) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ActionRequest) => post<ActionRun>(`${actionUrl(action.name)}/run`, body),
    onSuccess: () =>
      queryClient.invalidateQueries({
        predicate: ({ queryKey }) =>
          ['rows', 'children', 'parent', 'record', 'search', 'history', 'audit'].includes(
            String(queryKey[0]),
          ),
      }),
  });
}

export type ActionWidget =
  'text' | 'textarea' | 'number' | 'integer' | 'boolean' | 'enum' | 'date' | 'datetime' | 'ref';

/** One input field of an action's form, from its JSON Schema. */
export interface ActionField {
  name: string;
  label: string;
  description?: string;
  placeholder?: string;
  widget: ActionWidget;
  /** A list of values of `widget`. */
  many: boolean;
  /** Must be given: required by the schema, with no default. */
  required: boolean;
  /** Null is allowed. */
  nullable: boolean;
  enumValues?: string[];
  maxLength?: number;
  /** For `ref`: the entity key records are picked from. */
  ref?: string;
  default?: unknown;
}

const REF_KEYWORD = 'x-warden-ref';

function widgetOf(schema: JsonSchema): ActionWidget {
  if (typeof schema[REF_KEYWORD] === 'string') return 'ref';
  if (Array.isArray(schema.enum)) return 'enum';
  switch (schema.type) {
    case 'boolean':
      return 'boolean';
    case 'integer':
      return 'integer';
    case 'number':
      return 'number';
    default:
      if (schema.format === 'date') return 'date';
      if (schema.format === 'date-time') return 'datetime';
      return schema.widget === 'textarea' ? 'textarea' : 'text';
  }
}

/** `schema` without a `null` alternative, and whether it had one. */
function unwrapNull(schema: JsonSchema): [JsonSchema, boolean] {
  if (Array.isArray(schema.type)) {
    const type = (schema.type as unknown[]).find((t) => t !== 'null');
    return [{ ...schema, type }, schema.type.includes('null')];
  }
  if (Array.isArray(schema.anyOf)) {
    const options = schema.anyOf as JsonSchema[];
    const inner = options.find((o) => o.type !== 'null') ?? {};
    // Annotations like `label` sit on the outer schema.
    return [{ ...inner, ...schema, anyOf: undefined }, options.some((o) => o.type === 'null')];
  }
  return [schema, false];
}

/** The fields of an action's form, in schema order. */
export function actionFields(action: Pick<ActionDescriptor, 'inputSchema'>): ActionField[] {
  const required = new Set(action.inputSchema.required ?? []);
  return Object.entries(action.inputSchema.properties).map(([name, property]) => {
    const [outer, nullable] = unwrapNull(property);
    const many = outer.type === 'array';
    const item = many ? unwrapNull((outer.items as JsonSchema | undefined) ?? {})[0] : outer;
    const schema = many ? { ...item, label: outer.label, description: outer.description } : item;
    const widget = widgetOf(schema);
    const str = (key: string) =>
      typeof schema[key] === 'string' ? (schema[key] as string) : undefined;
    const label = str('label') ?? str('title') ?? humanize(name);
    const description = str('description');
    const placeholder = str('placeholder');
    return {
      name,
      label,
      ...(description ? { description } : {}),
      ...(placeholder ? { placeholder } : {}),
      widget,
      many,
      required: required.has(name) && !('default' in property),
      nullable,
      ...(Array.isArray(schema.enum) ? { enumValues: schema.enum.map(String) } : {}),
      ...(typeof item.maxLength === 'number' ? { maxLength: item.maxLength } : {}),
      ...(widget === 'ref' ? { ref: schema[REF_KEYWORD] as string } : {}),
      ...('default' in property ? { default: property.default } : {}),
    };
  });
}

/** What each control holds: text for one value, a list of texts for `many`. */
export type ActionDrafts = Record<string, string | string[]>;

/** A local `datetime-local` value for an ISO timestamp, or the text as-is. */
function toLocalDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function toDraft(field: ActionField, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (field.widget === 'datetime' && typeof value === 'string') return toLocalDateTime(value);
  return String(value);
}

/** Initial drafts: each field's default, overridden by the action's `defaults` for this record. */
export function initialActionDrafts(
  fields: ActionField[],
  defaults: Record<string, unknown> = {},
): ActionDrafts {
  return Object.fromEntries(
    fields.map((field) => {
      const value = Object.hasOwn(defaults, field.name) ? defaults[field.name] : field.default;
      if (field.many) {
        return [field.name, Array.isArray(value) ? value.map((v) => toDraft(field, v)) : []];
      }
      // A checkbox, which is never blank.
      if (field.widget === 'boolean' && !field.nullable) {
        return [field.name, value === true ? 'true' : 'false'];
      }
      return [field.name, toDraft(field, value)];
    }),
  );
}

/** The value a draft stands for; undefined for a blank one. */
function fromDraft(field: ActionField, draft: string): unknown {
  if (draft.trim() === '' && field.widget !== 'text' && field.widget !== 'textarea') {
    return undefined;
  }
  switch (field.widget) {
    case 'boolean':
      return draft === 'true';
    case 'integer':
    case 'number': {
      // A non-number goes as typed, so the server's message explains it.
      const n = Number(draft.trim());
      return Number.isFinite(n) ? n : draft;
    }
    case 'datetime': {
      const date = new Date(draft);
      return Number.isNaN(date.getTime()) ? draft : date.toISOString();
    }
    default:
      return draft === '' ? undefined : draft;
  }
}

/**
 * The input to send for `drafts`. Blank nullable fields are null and other blank fields are left
 * out, so the server says when one is required.
 */
export function actionInput(fields: ActionField[], drafts: ActionDrafts): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of fields) {
    const draft = drafts[field.name];
    if (field.many) {
      const values = (Array.isArray(draft) ? draft : [])
        .map((d) => fromDraft(field, d))
        .filter((v) => v !== undefined);
      if (values.length > 0 || field.required) input[field.name] = values;
      continue;
    }
    const value = fromDraft(field, typeof draft === 'string' ? draft : '');
    if (value !== undefined) input[field.name] = value;
    else if (field.nullable) input[field.name] = null;
  }
  return input;
}

/** Field errors keyed by input field; errors without a field (or for no field) under ''. */
export function groupActionErrors(
  fields: ActionField[],
  errors: FieldError[],
): Record<string, string[]> {
  const names = new Set(fields.map((f) => f.name));
  const grouped: Record<string, string[]> = {};
  for (const { field, message } of errors) {
    const key = field !== undefined && names.has(field) ? field : '';
    const text = key === '' && field !== undefined ? `${field}: ${message}` : message;
    (grouped[key] ??= []).push(text);
  }
  return grouped;
}
