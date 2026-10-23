import { useId, useMemo, useState, type MouseEvent } from 'react';
import type { Entity, Relation } from '@wardenhq/core';
import { Plus, X } from 'lucide-react';
import { Link } from 'react-router';
import { FieldValue } from '@/components/field-value';
import { InternalNote, noteProblem } from '@/components/internal-note';
import { RecordPicker } from '@/components/record-picker';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api';
import {
  PREVIEW_STALE_MESSAGE,
  actionFields,
  actionInput,
  failedSteps,
  groupActionErrors,
  initialActionDrafts,
  useActionDefaults,
  usePreviewAction,
  useRetryAction,
  useRunAction,
  type ActionChange,
  type ActionDescriptor,
  type ActionDrafts,
  type ActionField,
  type ActionPreview,
  type ActionRequest,
  type ActionRun,
  type ActionStep,
  type FailedSteps,
} from '@/lib/actions';
import { recordPath } from '@/lib/records';
import { useSchema } from '@/lib/schema';

const NONE = '\0';

/** "Users (update), Orders (update)", for the confirmation step. */
function permissionsText(action: ActionDescriptor, entities: Map<string, Entity>) {
  return Object.entries(action.permissions)
    .map(([key, writes]) => `${entities.get(key)?.label ?? key} (${writes.join(', ')})`)
    .join(', ');
}

/**
 * Runs a custom action: its form, then a preview of what it would change (or a plain
 * confirmation), then the result. Mounted only while open, so each opening starts fresh.
 */
export function ActionDialog({
  action,
  records,
  onClose,
}: {
  action: ActionDescriptor;
  /** The record ids it runs against: one, several, or none, as the action's target says. */
  records: string[];
  onClose: () => void;
}) {
  const { data: schema } = useSchema();
  const entities = useMemo(() => new Map(schema?.entities.map((e) => [e.key, e])), [schema]);
  const defaults = useActionDefaults(action, action.target === 'one' ? records[0] : undefined);

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{action.label}</AlertDialogTitle>
          <AlertDialogDescription>
            {action.description ?? ''}
            {action.target === 'many' &&
              ` ${records.length} record${records.length === 1 ? '' : 's'} selected.`}
          </AlertDialogDescription>
          {Object.keys(action.permissions).length > 0 && (
            <p className="text-xs text-muted-foreground">
              Can change: {permissionsText(action, entities)}
            </p>
          )}
        </AlertDialogHeader>
        {action.hasDefaults && defaults.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <ActionSteps
            action={action}
            records={records}
            entities={entities}
            defaults={defaults.data?.values ?? {}}
            onClose={onClose}
          />
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

type Step =
  | { kind: 'form' }
  | { kind: 'preview'; preview: ActionPreview; request: ActionRequest }
  | { kind: 'done'; run: ActionRun }
  /** A multi-step run stopped at a failed step. */
  | { kind: 'failed'; failure: FailedSteps; message: string };

function ActionSteps({
  action,
  records,
  entities,
  defaults,
  onClose,
}: {
  action: ActionDescriptor;
  records: string[];
  entities: Map<string, Entity>;
  defaults: Record<string, unknown>;
  onClose: () => void;
}) {
  const fields = useMemo(() => actionFields(action), [action]);
  const [drafts, setDrafts] = useState<ActionDrafts>(() => initialActionDrafts(fields, defaults));
  const [reason, setReason] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [stale, setStale] = useState(false);
  const preview = usePreviewAction(action);
  const run = useRunAction(action);
  const retry = useRetryAction(action);
  const reasonId = useId();

  const error = (step.kind === 'preview' ? run.error : (preview.error ?? run.error)) ?? null;
  const errors =
    error instanceof ApiError && error.details.length > 0
      ? groupActionErrors(fields, error.details)
      : {};
  const request = (): ActionRequest => {
    const trimmed = reason.trim();
    return {
      ...(action.target !== 'none' ? { records } : {}),
      input: actionInput(fields, drafts),
      ...(trimmed ? { reason: trimmed } : {}),
    };
  };
  const pending = preview.isPending || run.isPending;
  const reasonMinLength = action.requireReason ? (action.reasonMinLength ?? 1) : undefined;
  const missingReason = noteProblem(reason, reasonMinLength) !== null;

  const doPreview = (event?: MouseEvent) => {
    event?.preventDefault();
    run.reset();
    setStale(false);
    const body = request();
    preview.mutate(body, {
      onSuccess: (data) => setStep({ kind: 'preview', preview: data, request: body }),
    });
  };
  const doRun = (event: MouseEvent, body: ActionRequest) => {
    event.preventDefault();
    run.mutate(body, {
      onSuccess: (data) => setStep({ kind: 'done', run: data }),
      onError: (err) => {
        const failure = failedSteps(err);
        if (failure) {
          setStep({ kind: 'failed', failure, message: err.message });
        } else if (
          err instanceof ApiError &&
          err.status === 409 &&
          err.message === PREVIEW_STALE_MESSAGE
        ) {
          setStale(true);
        } else if (step.kind === 'preview' && err instanceof ApiError && err.details.length > 0) {
          // Back to the form, where the field errors show.
          setStep({ kind: 'form' });
        }
      },
    });
  };

  if (step.kind === 'failed') {
    const { failure } = step;
    const doRetry = () =>
      retry.mutate(failure.auditId, {
        onSuccess: (data) => setStep({ kind: 'done', run: data }),
        onError: (err) => {
          const next = failedSteps(err);
          if (next) setStep({ kind: 'failed', failure: next, message: err.message });
        },
      });
    const retryError = retry.error && !failedSteps(retry.error) ? retry.error : null;
    return (
      <>
        <p role="alert" className="text-sm text-destructive">
          {step.message}
        </p>
        <StepList steps={failure.steps} />
        <p className="text-sm text-muted-foreground">
          {failure.retryable
            ? 'Retrying sends the failed step and the ones after it again. Steps that completed are not repeated.'
            : "This run can't be retried. Check what the completed steps did before running the action again."}
        </p>
        {retryError && <ErrorMessage error={retryError} grouped={{}} />}
        <AlertDialogFooter>
          <Button variant="outline" disabled={retry.isPending} onClick={onClose}>
            Close
          </Button>
          {failure.retryable && (
            <Button disabled={retry.isPending} onClick={doRetry}>
              {retry.isPending ? 'Retrying…' : 'Retry remaining steps'}
            </Button>
          )}
        </AlertDialogFooter>
      </>
    );
  }

  if (step.kind === 'done') {
    const { message, redirect, records: outcomes } = step.run.result;
    const target = redirect && entities.get(redirect.entity);
    const failures = outcomes?.filter((r) => !r.ok) ?? [];
    const onEntity = entities.get(action.on);
    return (
      <>
        <p role="status" className="text-sm">
          {message ?? 'Done.'}
        </p>
        {step.run.result.steps && <StepList steps={step.run.result.steps} />}
        {failures.length > 0 && (
          <div className="space-y-1 text-sm">
            <p className="font-medium text-destructive">
              Failed for {failures.length} record{failures.length === 1 ? '' : 's'}:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              {failures.map((r) => (
                <li key={r.id}>
                  {onEntity ? (
                    <Link
                      to={recordPath(onEntity, r.id)}
                      onClick={onClose}
                      className="underline underline-offset-4"
                    >
                      {r.id}
                    </Link>
                  ) : (
                    r.id
                  )}
                  {r.message && `: ${r.message}`}
                </li>
              ))}
            </ul>
          </div>
        )}
        <AlertDialogFooter>
          {target && redirect && (
            <Button variant="outline" asChild>
              <Link to={recordPath(target, redirect.id)} onClick={onClose}>
                Open {target.label.toLowerCase()}
              </Link>
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </AlertDialogFooter>
      </>
    );
  }

  const runLabel = run.isPending ? 'Running…' : 'Run';
  const runVariant = action.destructive ? 'destructive' : 'default';

  if (step.kind === 'preview') {
    return (
      <>
        <ChangeSet preview={step.preview} entities={entities} />
        {stale && (
          <p role="alert" className="text-sm text-destructive">
            This changed since you previewed it. Preview again to see what it would do now.
          </p>
        )}
        {error && !stale && <ErrorMessage error={error} grouped={errors} all />}
        <AlertDialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => setStep({ kind: 'form' })}>
            Back
          </Button>
          {stale ? (
            <Button disabled={pending} onClick={doPreview}>
              {preview.isPending ? 'Previewing…' : 'Preview again'}
            </Button>
          ) : (
            <Button
              variant={runVariant}
              disabled={pending}
              onClick={(e) =>
                doRun(e, { ...step.request, previewToken: step.preview.previewToken })
              }
            >
              {runLabel}
            </Button>
          )}
        </AlertDialogFooter>
      </>
    );
  }

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (pending || missingReason) return;
        if (action.confirm === 'preview') doPreview();
      }}
    >
      {fields.map((field) => (
        <ActionFieldRow
          key={field.name}
          field={field}
          entities={entities}
          value={drafts[field.name] ?? (field.many ? [] : '')}
          errors={errors[field.name]}
          onChange={(value) => setDrafts((d) => ({ ...d, [field.name]: value }))}
        />
      ))}
      <InternalNote id={reasonId} value={reason} minLength={reasonMinLength} onChange={setReason} />
      {error && <ErrorMessage error={error} grouped={errors} />}
      <AlertDialogFooter>
        <AlertDialogCancel type="button" disabled={pending}>
          Cancel
        </AlertDialogCancel>
        {action.confirm === 'preview' ? (
          <Button type="submit" disabled={pending || missingReason}>
            {preview.isPending ? 'Previewing…' : 'Preview'}
          </Button>
        ) : (
          <Button
            type="button"
            variant={runVariant}
            disabled={pending || missingReason}
            onClick={(e) => doRun(e, request())}
          >
            {runLabel}
          </Button>
        )}
      </AlertDialogFooter>
    </form>
  );
}

const STEP_TEXT: Record<ActionStep['result'], string> = {
  ok: 'Done',
  rejected: 'Rejected',
  failed: 'Failed',
  skipped: 'Skipped',
  not_attempted: 'Not attempted',
};
const UNDO_TEXT: Record<NonNullable<ActionStep['compensation']>['result'], string> = {
  ok: 'undone',
  rejected: 'undo rejected',
  failed: 'undo failed',
};

/** Each step of a multi-step run and how it went, including undo calls. */
function StepList({ steps }: { steps: ActionStep[] }) {
  return (
    <ol aria-label="Steps" className="space-y-1 text-sm">
      {steps.map((s) => (
        <li key={s.name}>
          <span
            className={
              s.result === 'rejected' || s.result === 'failed'
                ? 'font-medium text-destructive'
                : s.result === 'ok'
                  ? 'font-medium'
                  : 'text-muted-foreground'
            }
          >
            {STEP_TEXT[s.result]}
          </span>{' '}
          <span className="font-mono">{s.name}</span>
          {s.message && <span className="text-muted-foreground">: {s.message}</span>}
          {s.compensation && (
            <span className={s.compensation.result === 'ok' ? '' : 'text-destructive'}>
              {' '}
              · {UNDO_TEXT[s.compensation.result]}
              {s.compensation.message && `: ${s.compensation.message}`}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** The error's message, plus field errors that have no control to show under. */
function ErrorMessage({
  error,
  grouped,
  all = false,
}: {
  error: Error;
  grouped: Record<string, string[]>;
  /** Show every field error here (there is no form to show them in). */
  all?: boolean;
}) {
  const general = all ? Object.values(grouped).flat() : (grouped[''] ?? []);
  const message =
    // A 503 is Warden's own "took too long"; other 5xx carry nothing for the user.
    !(error instanceof ApiError) || (error.status >= 500 && error.status !== 503)
      ? "Couldn't run this action."
      : error.status === 404
        ? 'This record no longer exists, or the action is no longer available to you.'
        : error.message;
  return (
    <div role="alert" className="space-y-1 text-sm text-destructive">
      <p>{message}</p>
      {general.length > 0 && (
        <ul className="list-disc pl-5">
          {general.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActionFieldRow({
  field,
  entities,
  value,
  errors,
  onChange,
}: {
  field: ActionField;
  entities: Map<string, Entity>;
  value: string | string[];
  errors: string[] | undefined;
  onChange: (value: string | string[]) => void;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  const invalid = (errors?.length ?? 0) > 0;
  const control = (
    draft: string,
    set: (next: string) => void,
    controlId: string,
    label?: string,
  ) => (
    <ActionFieldInput
      id={controlId}
      field={field}
      entities={entities}
      value={draft}
      invalid={invalid}
      describedBy={helpId}
      {...(label ? { ariaLabel: label } : {})}
      onChange={set}
    />
  );
  const items = Array.isArray(value) ? value : [];

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        {field.label}
        {field.required && <span className="text-muted-foreground"> (required)</span>}
      </label>
      {field.many ? (
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={i} className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                {control(
                  item,
                  (next) => onChange(items.map((v, j) => (j === i ? next : v))),
                  i === 0 ? id : `${id}-${i}`,
                  `${field.label} ${i + 1}`,
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${field.label} ${i + 1}`}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                <X />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            {...(items.length === 0 ? { id } : {})}
            onClick={() => onChange([...items, ''])}
          >
            <Plus />
            Add
          </Button>
        </div>
      ) : (
        control(typeof value === 'string' ? value : '', onChange, id)
      )}
      {field.description && (
        <p id={helpId} className="text-xs text-muted-foreground">
          {field.description}
        </p>
      )}
      {errors?.map((message, i) => (
        <p key={i} className="text-xs text-destructive">
          {message}
        </p>
      ))}
    </div>
  );
}

function ActionFieldInput({
  id,
  field,
  entities,
  value,
  invalid,
  describedBy,
  ariaLabel,
  onChange,
}: {
  id: string;
  field: ActionField;
  entities: Map<string, Entity>;
  value: string;
  invalid: boolean;
  describedBy: string;
  ariaLabel?: string;
  onChange: (value: string) => void;
}) {
  const common = {
    id,
    'aria-invalid': invalid || undefined,
    'aria-required': field.required || undefined,
    'aria-describedby': describedBy,
    ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
  };
  const optional = !field.required || field.many;

  switch (field.widget) {
    case 'ref': {
      const target = field.ref ? entities.get(field.ref) : undefined;
      const [key, ...rest] = target?.primaryKey ?? [];
      // The picker sets key columns from the chosen row; a single-column key is the record id.
      if (target && key && rest.length === 0) {
        const relation: Relation = {
          kind: 'belongsTo',
          name: `action:${field.name}`,
          entity: target.key,
          columns: [field.name],
          targetColumns: [key],
        };
        return (
          <RecordPicker
            id={id}
            relation={relation}
            target={target}
            value={{ [field.name]: value }}
            onChange={(next) => onChange(next[field.name] ?? '')}
            clearable={optional}
            invalid={invalid}
            describedBy={describedBy}
          />
        );
      }
      return (
        <Input
          {...common}
          placeholder="Record id"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    case 'boolean':
      // Only a nullable boolean needs a third, blank choice.
      if (!field.nullable) {
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
        <Choice
          common={common}
          value={value}
          blank
          options={[
            ['true', 'Yes'],
            ['false', 'No'],
          ]}
          onChange={onChange}
        />
      );
    case 'enum':
      return (
        <Choice
          common={common}
          value={value}
          blank={optional || field.nullable}
          options={(field.enumValues ?? []).map((v) => [v, v])}
          onChange={onChange}
        />
      );
    case 'integer':
    case 'number':
      return (
        <Input
          {...common}
          inputMode={field.widget === 'integer' ? 'numeric' : 'decimal'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'date':
    case 'datetime':
      return (
        <Input
          {...common}
          type={field.widget === 'date' ? 'date' : 'datetime-local'}
          step={field.widget === 'date' ? undefined : 1}
          className="w-auto"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'textarea':
      return (
        <Textarea
          {...common}
          rows={3}
          {...(field.placeholder ? { placeholder: field.placeholder } : {})}
          {...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {})}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return (
        <Input
          {...common}
          {...(field.placeholder ? { placeholder: field.placeholder } : {})}
          {...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {})}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

function Choice({
  common,
  value,
  blank,
  options,
  onChange,
}: {
  common: { id: string } & Record<string, unknown>;
  value: string;
  /** Offer a blank choice. */
  blank: boolean;
  options: [value: string, label: string][];
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value === '' && blank ? NONE : value}
      onValueChange={(v) => onChange(v === NONE ? '' : v)}
    >
      <SelectTrigger {...common} className="min-w-40">
        <SelectValue placeholder="Choose…" />
      </SelectTrigger>
      <SelectContent>
        {blank && <SelectItem value={NONE}>—</SelectItem>}
        {options.map(([option, label]) => (
          <SelectItem key={option} value={option}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const OPERATION_WORDS: Record<ActionChange['operation'], [string, string]> = {
  create: ['create', 'creates'],
  update: ['update', 'updates'],
  delete: ['delete', 'deletes'],
};

/** What a preview would change, grouped by entity: counts, then each row's diff. */
function ChangeSet({
  preview,
  entities,
}: {
  preview: ActionPreview;
  entities: Map<string, Entity>;
}) {
  if (preview.total === 0) {
    return <p className="text-sm text-muted-foreground">This action wouldn't change anything.</p>;
  }
  const groups = new Map<string, ActionChange[]>();
  for (const change of preview.changes) {
    groups.set(change.entity, [...(groups.get(change.entity) ?? []), change]);
  }
  return (
    <section aria-label="Changes" className="space-y-3 text-sm">
      <p>
        This would change {preview.total} row{preview.total === 1 ? '' : 's'}
        {preview.truncated ? `; the first ${preview.changes.length} are shown` : ''}.
      </p>
      {[...groups].map(([key, changes]) => {
        const entity = entities.get(key);
        const counts = Object.entries(
          changes.reduce<Record<string, number>>((acc, c) => {
            acc[c.operation] = (acc[c.operation] ?? 0) + 1;
            return acc;
          }, {}),
        )
          .map(
            ([op, n]) =>
              `${n} ${OPERATION_WORDS[op as ActionChange['operation']][n === 1 ? 0 : 1]}`,
          )
          .join(', ');
        return (
          <div key={key} className="space-y-1">
            <h3 className="font-medium">
              {entity?.label ?? key}{' '}
              <span className="font-normal text-muted-foreground">({counts})</span>
            </h3>
            <ul className="space-y-1">
              {changes.map((change, i) => (
                <ChangeRow key={i} change={change} entity={entity} />
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function ChangeRow({ change, entity }: { change: ActionChange; entity: Entity | undefined }) {
  if (change.recordId === null && change.after === null && change.before === null) {
    return <li className="text-muted-foreground">A change you can't see the details of</li>;
  }
  const fields = Object.keys(change.diff);
  const fieldOf = (name: string) =>
    entity?.fields.find((f) => f.name === name) ?? { name, label: name, dataType: 'text' };
  return (
    <li>
      <details className="rounded-md border px-3 py-1.5">
        <summary className="cursor-pointer">
          {change.operation} {change.recordId ?? ''}
          <span className="text-muted-foreground">
            {' '}
            · {fields.length} field{fields.length === 1 ? '' : 's'}
          </span>
        </summary>
        <table className="mt-2 w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                Field
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Before
              </th>
              <th scope="col" className="py-1 font-medium">
                After
              </th>
            </tr>
          </thead>
          <tbody>
            {fields.map((name) => {
              const field = fieldOf(name);
              return (
                <tr key={name} className="border-t align-top">
                  <th scope="row" className="py-1 pr-3 text-left font-medium">
                    {field.label}
                  </th>
                  <td className="py-1 pr-3">
                    {change.before !== null && (
                      <FieldValue field={field} value={change.diff[name]!.from} />
                    )}
                  </td>
                  <td className="py-1">
                    {change.after !== null && (
                      <FieldValue field={field} value={change.diff[name]!.to} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </li>
  );
}
