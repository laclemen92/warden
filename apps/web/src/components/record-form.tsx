import {
  useId,
  useMemo,
  useState,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { Entity, Field, Relation, WriteMode } from '@wardenhq/core';
import { Link } from 'react-router';
import { FieldValue } from '@/components/field-value';
import { RecordPicker } from '@/components/record-picker';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api';
import { useCapabilities } from '@/lib/capabilities';
import {
  RECORD_ERRORS,
  formFields,
  formValues,
  groupErrors,
  initialDrafts,
  pickerRelations,
  type Drafts,
  type FormErrors,
  type FormField,
} from '@/lib/form-fields';
import type { Row } from '@/lib/records';

// apps/server/src/routes/entities.ts: a stale version, as opposed to a constraint conflict.
const STALE_MESSAGE = 'the record has changed since it was read';
const MAX_REASON_LENGTH = 2000;

// Radix Select items can't have an empty value, and Postgres enum labels can't contain NUL.
const NONE = '\0';

export interface RecordSubmission {
  values: Row;
  reason?: string;
}

/**
 * A create or edit form generated from an entity's fields: one input per field, chosen by its
 * type, with a record picker for each foreign key. Values are checked with the server's own
 * write schema before they're sent, and errors the server returns are shown on their fields.
 */
export function RecordForm({
  entity,
  entities,
  mode,
  record,
  onSubmit,
  onReload,
  cancelTo,
}: {
  entity: Entity;
  entities: Map<string, Entity>;
  mode: WriteMode;
  /** The values being edited (update only). */
  record?: Row;
  /** Rejects with the API error when the write fails. */
  onSubmit: (submission: RecordSubmission) => Promise<unknown>;
  /** Discards the edits and loads the current version, after a stale-version conflict. */
  onReload?: () => void;
  cancelTo: string;
}) {
  const fields = useMemo(() => formFields(entity, mode, record), [entity, mode, record]);
  const initial = useMemo(() => initialDrafts(fields, record), [fields, record]);
  const pickers = useMemo(() => pickerRelations(entity), [entity]);
  const [drafts, setDrafts] = useState<Drafts>(initial);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState(false);
  const formId = useId();

  const byName = new Map(fields.map((f) => [f.field.name, f]));
  // A composite foreign key is edited by the picker at its first column.
  const pickerColumn = new Map<string, string>();
  for (const [column, relation] of pickers) {
    relation.columns.forEach((c) => pickerColumn.set(c, column));
  }

  const dirty = fields.some(({ field }) => drafts[field.name] !== initial[field.name]);

  const change = (next: Drafts) => {
    setDrafts((d) => ({ ...d, ...next }));
    // Errors for an edited field no longer apply.
    setErrors((e) => {
      const remaining = { ...e };
      for (const name of Object.keys(next)) delete remaining[pickerColumn.get(name) ?? name];
      return remaining;
    });
  };

  /** Errors for fields the form doesn't show on their own go to the field that edits them. */
  const place = (grouped: FormErrors): FormErrors => {
    const placed: FormErrors = {};
    for (const [name, messages] of Object.entries(grouped)) {
      const shown = pickerColumn.get(name) ?? name;
      const field = byName.get(shown)?.field;
      if (name === RECORD_ERRORS || (field && !field.readOnly)) {
        (placed[shown] ??= []).push(...messages);
      } else {
        const label = byName.get(name)?.field.label ?? name;
        (placed[RECORD_ERRORS] ??= []).push(...messages.map((m) => `${label} ${m}`));
      }
    }
    return placed;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = formValues(entity, fields, drafts, mode, initial);
    if (!result.ok) {
      setErrors(place(result.errors));
      return;
    }
    setErrors({});
    setStale(false);
    setPending(true);
    try {
      const trimmed = reason.trim();
      await onSubmit({ values: result.values, ...(trimmed ? { reason: trimmed } : {}) });
    } catch (error) {
      const failure = describeFailure(error, mode);
      setStale(failure.stale);
      setErrors(place(failure.errors));
    } finally {
      setPending(false);
    }
  };

  const recordErrors = errors[RECORD_ERRORS];

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="max-w-3xl space-y-6">
      {recordErrors && (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-destructive/50 px-4 py-3 text-sm text-destructive"
        >
          {recordErrors.map((message) => (
            <p key={message}>{sentence(message)}</p>
          ))}
          {stale && onReload && (
            <Button type="button" variant="outline" size="sm" onClick={onReload}>
              Discard my changes and reload
            </Button>
          )}
        </div>
      )}

      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-[minmax(8rem,max-content)_1fr]">
        {fields.map((formField) => {
          const { field } = formField;
          const owner = pickerColumn.get(field.name);
          // Other columns of a composite foreign key are edited by its picker.
          if (owner !== undefined && owner !== field.name) return null;
          return (
            <FieldRow
              key={field.name}
              id={`${formId}-${field.name}`}
              entity={entity}
              entities={entities}
              mode={mode}
              formField={formField}
              relation={owner === field.name ? pickers.get(field.name) : undefined}
              fields={byName}
              drafts={drafts}
              record={record}
              errors={errors[field.name]}
              onChange={change}
            />
          );
        })}

        <label htmlFor={`${formId}-reason`} className="pt-2 text-sm font-medium">
          Reason
        </label>
        <div className="space-y-1">
          <Input
            id={`${formId}-reason`}
            value={reason}
            maxLength={MAX_REASON_LENGTH}
            aria-describedby={`${formId}-reason-help`}
            onChange={(e) => setReason(e.target.value)}
          />
          <p id={`${formId}-reason-help`} className="text-xs text-muted-foreground">
            Optional. Saved in the audit log with this change.
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending || (mode === 'update' && !dirty)}>
          {pending ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
        </Button>
        <Button variant="outline" asChild>
          <Link to={cancelTo}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

const sentence = (message: string) => message.charAt(0).toUpperCase() + message.slice(1);

/** What to show for a failed write. */
function describeFailure(error: unknown, mode: WriteMode): { errors: FormErrors; stale: boolean } {
  const record = (message: string) => ({ errors: { [RECORD_ERRORS]: [message] }, stale: false });
  if (!(error instanceof ApiError)) return record("Couldn't save this record. Try again.");
  if (error.status === 409 && error.message === STALE_MESSAGE) {
    return {
      errors: {
        [RECORD_ERRORS]: [
          'This record changed since you opened it. Reload it to see the current values, then make your changes again.',
        ],
      },
      stale: true,
    };
  }
  if ((error.status === 400 || error.status === 409) && error.details.length > 0) {
    return { errors: groupErrors(error.details), stale: false };
  }
  if (error.status === 409) return record('This conflicts with an existing record.');
  if (error.status === 403) {
    return record(
      `You don't have permission to ${mode === 'create' ? 'create' : 'edit'} this record.`,
    );
  }
  if (error.status === 404 && mode === 'update') return record('This record no longer exists.');
  if (error.status === 400) return record(`Couldn't save this record: ${error.message}.`);
  return record("Couldn't save this record. Try again.");
}

function Label({ htmlFor, ...props }: ComponentProps<'label'>) {
  return htmlFor === undefined ? <span {...props} /> : <label htmlFor={htmlFor} {...props} />;
}

/** Whether a blank value is acceptable: it becomes the default or null. */
const optional = (field: Field, mode: WriteMode) =>
  field.nullable || (mode === 'create' && field.hasDefault);

function FieldRow({
  id,
  entity,
  entities,
  mode,
  formField,
  relation,
  fields,
  drafts,
  record,
  errors,
  onChange,
}: {
  id: string;
  entity: Entity;
  entities: Map<string, Entity>;
  mode: WriteMode;
  formField: FormField;
  relation: Relation | undefined;
  fields: Map<string, FormField>;
  drafts: Drafts;
  record: Row | undefined;
  errors: string[] | undefined;
  onChange: (next: Drafts) => void;
}) {
  const { field } = formField;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [helpId, ...(errors ? [errorId] : [])].join(' ');
  const invalid = errors !== undefined;
  const required = !field.readOnly && !optional(field, mode);

  let control: ReactNode;
  if (field.readOnly) {
    control = (
      <div
        id={id}
        className="min-h-9 py-2 text-sm"
        aria-labelledby={`${id}-label`}
        aria-describedby={describedBy}
      >
        <FieldValue field={field} value={record?.[field.name]} />
      </div>
    );
  } else {
    const target = relation && entities.get(relation.entity);
    control =
      relation && target ? (
        <PickerOrInputs
          id={id}
          relation={relation}
          target={target}
          fields={fields}
          drafts={drafts}
          mode={mode}
          invalid={invalid}
          describedBy={describedBy}
          onChange={onChange}
        />
      ) : (
        <FieldInput
          id={id}
          formField={formField}
          mode={mode}
          value={drafts[field.name] ?? ''}
          invalid={invalid}
          describedBy={describedBy}
          onChange={(value) => onChange({ [field.name]: value })}
        />
      );
  }

  return (
    <>
      {/* A read-only value is text, not a control, so it can't be the target of a <label>. */}
      <Label
        id={`${id}-label`}
        {...(field.readOnly ? {} : { htmlFor: id })}
        className="pt-2 text-sm font-medium"
        title={field.comment}
      >
        {field.label}
        {required && (
          <span className="text-destructive" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </Label>
      <div className="min-w-0 space-y-1">
        {control}
        <p id={helpId} className="text-xs text-muted-foreground">
          {fieldHelp(entity, formField, mode, required)}
        </p>
        {errors && (
          <p id={errorId} className="text-xs text-destructive">
            {errors.map((message) => `${field.label} ${message}`).join('. ')}
          </p>
        )}
      </div>
    </>
  );
}

function fieldHelp(
  entity: Entity,
  { field, widget }: FormField,
  mode: WriteMode,
  required: boolean,
) {
  const parts: string[] = [field.formattedType];
  if (field.readOnly) parts.push('read-only');
  else if (required) parts.push('required');
  else if (mode === 'create' && field.hasDefault) parts.push('leave blank for the default');
  else parts.push('optional');
  if (widget === 'json' && !field.readOnly) parts.push(field.isArray ? 'JSON array' : 'JSON');
  if (widget === 'datetime' && field.dataType === 'timestamptz' && !field.readOnly) {
    parts.push(`your local time (${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  }
  if (entity.primaryKey.includes(field.name) && mode === 'update' && !field.readOnly) {
    parts.push('changing it changes the record’s address');
  }
  const help = parts.join(' · ');
  return field.comment ? `${field.comment} — ${help}` : help;
}

/**
 * A record picker, or plain inputs for the key columns when the user can't read the target
 * entity (the picker would have nothing to search).
 */
function PickerOrInputs({
  id,
  relation,
  target,
  fields,
  drafts,
  mode,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  relation: Relation;
  target: Entity;
  fields: Map<string, FormField>;
  drafts: Drafts;
  mode: WriteMode;
  invalid: boolean;
  describedBy: string;
  onChange: (next: Drafts) => void;
}) {
  const { data: capabilities } = useCapabilities();
  const targetActions =
    capabilities && Object.hasOwn(capabilities.entities, target.key)
      ? capabilities.entities[target.key]?.actions
      : undefined;
  const value = Object.fromEntries(relation.columns.map((c) => [c, drafts[c] ?? '']));
  const columns = relation.columns.flatMap((c) => fields.get(c) ?? []);

  if (capabilities && !targetActions?.includes('read')) {
    return (
      <div className="space-y-2">
        {columns.map((formField, i) => (
          <FieldInput
            key={formField.field.name}
            id={i === 0 ? id : `${id}-${formField.field.name}`}
            formField={formField}
            mode={mode}
            value={value[formField.field.name] ?? ''}
            invalid={invalid}
            describedBy={describedBy}
            {...(columns.length > 1 ? { ariaLabel: formField.field.label } : {})}
            onChange={(next) => onChange({ [formField.field.name]: next })}
          />
        ))}
      </div>
    );
  }
  return (
    <RecordPicker
      id={id}
      relation={relation}
      target={target}
      value={value}
      onChange={onChange}
      clearable={columns.every(({ field }) => optional(field, mode))}
      invalid={invalid}
      describedBy={describedBy}
    />
  );
}

interface CommonProps {
  id: string;
  'aria-invalid': true | undefined;
  'aria-required': true | undefined;
  'aria-describedby': string;
  'aria-label'?: string;
}

function FieldInput({
  id,
  formField: { field, widget },
  mode,
  value,
  invalid,
  describedBy,
  ariaLabel,
  onChange,
}: {
  id: string;
  formField: FormField;
  mode: WriteMode;
  value: string;
  invalid: boolean;
  describedBy: string;
  ariaLabel?: string;
  onChange: (value: string) => void;
}) {
  const common: CommonProps = {
    id,
    'aria-invalid': invalid || undefined,
    'aria-required': !optional(field, mode) || undefined,
    'aria-describedby': describedBy,
    ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
  };
  const blankLabel = mode === 'create' && field.hasDefault ? 'Default' : '—';

  switch (widget) {
    case 'textarea':
      return (
        <Textarea {...common} rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
      );
    case 'json':
      return (
        <Textarea
          {...common}
          rows={4}
          spellCheck={false}
          className="font-mono text-xs md:text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'number':
      return (
        <Input
          {...common}
          inputMode={field.dataType.startsWith('int') ? 'numeric' : 'decimal'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'date':
    case 'time':
    case 'datetime':
      return (
        <Input
          {...common}
          type={widget === 'datetime' ? 'datetime-local' : widget}
          // Seconds are part of most stored values; without a step the picker drops them.
          step={widget === 'date' ? undefined : 1}
          className="w-auto"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'boolean':
      if (!optional(field, mode)) {
        return (
          <div className="flex min-h-9 items-center">
            <Checkbox
              {...common}
              checked={value === 'true'}
              onCheckedChange={(checked) => onChange(checked === true ? 'true' : 'false')}
            />
          </div>
        );
      }
      return (
        <ChoiceSelect
          common={common}
          value={value}
          blankLabel={blankLabel}
          options={[
            ['true', 'Yes'],
            ['false', 'No'],
          ]}
          onChange={onChange}
        />
      );
    case 'enum':
      return (
        <ChoiceSelect
          common={common}
          value={value}
          blankLabel={optional(field, mode) ? blankLabel : undefined}
          options={(field.enumValues ?? []).map((v) => [v, v])}
          onChange={onChange}
        />
      );
    default:
      return <Input {...common} value={value} onChange={(e) => onChange(e.target.value)} />;
  }
}

function ChoiceSelect({
  common,
  value,
  blankLabel,
  options,
  onChange,
}: {
  common: CommonProps;
  value: string;
  /** Label for the blank choice; absent when a value is required. */
  blankLabel: string | undefined;
  options: [value: string, label: string][];
  onChange: (value: string) => void;
}) {
  return (
    <Select
      // An empty value shows the placeholder, for a required choice not made yet.
      value={value === '' && blankLabel !== undefined ? NONE : value}
      onValueChange={(v) => onChange(v === NONE ? '' : v)}
    >
      <SelectTrigger {...common} className="min-w-40">
        <SelectValue placeholder="Choose…" />
      </SelectTrigger>
      <SelectContent>
        {blankLabel !== undefined && <SelectItem value={NONE}>{blankLabel}</SelectItem>}
        {options.map(([option, label]) => (
          <SelectItem key={option} value={option}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
