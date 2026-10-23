import type { ReactNode } from 'react';
import {
  isActionDetails,
  isSoftDeleteDetails,
  parseSortFields,
  type ActionDetails,
  type HttpActionOutcome,
  type Entity,
  type ExportDetails,
  type RevokeSessionsDetails,
} from '@wardenhq/core';
import { Link } from 'react-router';
import { FieldValue } from '@/components/field-value';
import { Badge } from '@/components/ui/badge';
import { useActions } from '@/lib/actions';
import { AUDIT_LOG_PATH, useCanViewAuditLog, type AuditEntry } from '@/lib/audit';
import { describeCondition, filterToConditions } from '@/lib/filters';
import { recordPath } from '@/lib/records';

const ACTION_VARIANTS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  create: 'default',
  update: 'secondary',
  delete: 'destructive',
  export: 'outline',
  assign: 'default',
  unassign: 'destructive',
  revoke_sessions: 'destructive',
};

/** Names for the entities access entries are filed under, which aren't in the schema. */
const ACCESS_ENTITIES: Record<string, string> = {
  'warden.role_assignments': 'Role assignments',
  'warden.sessions': 'Sessions',
};

const numberFormat = new Intl.NumberFormat();

/** What an export included. Details naming fields the reader can't see are already removed. */
function ExportSummary({
  details,
  entity,
}: {
  details: ExportDetails;
  entity: Entity | undefined;
}) {
  const label = (name: string) => entity?.fields.find((f) => f.name === name)?.label ?? name;
  const conditions =
    details.filter && entity ? filterToConditions(JSON.stringify(details.filter)) : undefined;
  const filter = details.filter
    ? conditions
      ? conditions.map((c) => describeCondition(entity!, c)).join(', ')
      : 'Custom filter'
    : undefined;
  const sort = details.sort
    ?.split(',')
    .map((part) => {
      const name = parseSortFields(part)[0] ?? part;
      return `${label(name)}${part.trim().startsWith('-') ? ' (descending)' : ''}`;
    })
    .join(', ');
  const rows: [string, string][] = [
    ...(details.rowCount !== undefined
      ? [['Rows', numberFormat.format(details.rowCount)] as [string, string]]
      : []),
    ['Columns', details.columns.map(label).join(', ') || '—'],
    ...(filter ? [['Filter', filter] as [string, string]] : []),
    ...(details.q ? [['Search', details.q] as [string, string]] : []),
    ...(sort ? [['Sort', sort] as [string, string]] : []),
  ];
  return (
    <div className="space-y-2 text-sm">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {details.redacted && (
        <p className="text-muted-foreground">
          The filter, search, or sort used columns you can't see, so it isn't shown, nor is the
          number of rows when the filter or search is hidden.
        </p>
      )}
    </div>
  );
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/** What a role assignment, unassignment, or session revocation did, and to whom. */
function AccessSummary({ entry }: { entry: AuditEntry }) {
  let summary: ReactNode;
  if (entry.action === 'revoke_sessions') {
    const details = entry.details as RevokeSessionsDetails | null;
    const who = text(details?.email) ?? text(details?.subject) ?? 'a user';
    const count = details?.sessions ?? 0;
    summary = (
      <>
        Signed <strong title={details?.subject}>{who}</strong> out everywhere (
        {numberFormat.format(count)} {count === 1 ? 'session' : 'sessions'})
      </>
    );
  } else {
    const assignment = entry.after ?? entry.before;
    const email = text(assignment?.email) ?? 'a user';
    const role = <strong>{text(assignment?.role) ?? 'a role'}</strong>;
    summary =
      entry.action === 'assign' ? (
        <>
          Gave {role} to <strong>{email}</strong>
        </>
      ) : (
        <>
          Removed {role} from <strong>{email}</strong>
        </>
      );
  }
  return <p className="text-sm">{summary}</p>;
}

const OUTCOME_TEXT = {
  ok: 'succeeded',
  rejected: 'was rejected',
  failed: 'failed',
  partial: 'partly succeeded',
} as const;

const STEP_TEXT = {
  ok: 'succeeded',
  rejected: 'was rejected',
  failed: 'failed',
  skipped: 'skipped',
  not_attempted: 'not attempted',
} as const;

/** What an HTTP action's API answered, from the entry Warden writes after calling it. */
function OutcomeSummary({ outcome }: { outcome: HttpActionOutcome }) {
  const failures = outcome.records?.filter((r) => r.result !== 'ok') ?? [];
  return (
    <div className="space-y-1 text-sm">
      <p>
        {outcome.retry ? 'The retry' : outcome.steps ? 'The steps' : 'The API call'}{' '}
        {OUTCOME_TEXT[outcome.result]}
        {outcome.status !== undefined && ` (HTTP ${outcome.status})`}
        {outcome.message && `: ${outcome.message}`}
      </p>
      {outcome.endpoint && (
        <p className="font-mono text-xs break-all text-muted-foreground">{outcome.endpoint}</p>
      )}
      {outcome.steps && (
        <ol className="list-decimal pl-5 text-muted-foreground">
          {outcome.steps.map((s) => (
            <li key={s.name}>
              <span className="font-mono">{s.name}</span>: {STEP_TEXT[s.result]}
              {s.earlier && ' earlier'}
              {s.status !== undefined && ` (HTTP ${s.status})`}
              {s.message && `: ${s.message}`}
              {s.compensation &&
                `; undo ${OUTCOME_TEXT[s.compensation.result]}${
                  s.compensation.status !== undefined ? ` (HTTP ${s.compensation.status})` : ''
                }`}
            </li>
          ))}
        </ol>
      )}
      {failures.length > 0 && (
        <ul className="list-disc pl-5 text-muted-foreground">
          {failures.map((r) => (
            <li key={r.id}>
              Record {r.id}: {OUTCOME_TEXT[r.result]}
              {r.status !== undefined && ` (HTTP ${r.status})`}
              {r.message && `: ${r.message}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A custom action's entry: what it was asked to do, and a link to the rows it changed. */
function ActionSummary({ entry, details }: { entry: AuditEntry; details: ActionDetails }) {
  const canViewLog = useCanViewAuditLog();
  const input = Object.entries(details.input);
  if (details.outcome) return <OutcomeSummary outcome={details.outcome} />;
  if (details.retryOf) {
    return <p className="text-sm">Retried the remaining steps of entry {details.retryOf}.</p>;
  }
  return (
    <div className="space-y-2 text-sm">
      {input.length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          {input.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-muted-foreground">{name}</dt>
              <dd className="min-w-0">
                <FieldValue field={{ dataType: 'text' }} value={value} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {details.redacted && (
        <p className="text-muted-foreground">
          Input that picked records from tables you can't see isn't shown.
        </p>
      )}
      {details.records.length > 1 && (
        <p className="text-muted-foreground">
          Ran on {numberFormat.format(details.records.length)} records.
        </p>
      )}
      {canViewLog && (
        <Link
          to={`${AUDIT_LOG_PATH}?${new URLSearchParams({ parent: entry.id })}`}
          className="underline underline-offset-4"
        >
          Rows it changed
        </Link>
      )}
    </div>
  );
}

/** A custom action's label, when the user may run it; its name otherwise. */
function useActionLabel(name: string | undefined): string | undefined {
  const { data } = useActions();
  if (name === undefined) return undefined;
  return data?.actions.find((a) => a.name === name)?.label ?? name;
}

const formatTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

/**
 * One audit entry: who did what and when, why, and the fields it changed. On the audit log page
 * (`showRecord`) it also names the record; a record's own history doesn't need to.
 */
export function AuditEntryItem({
  entry,
  entity,
  showRecord = false,
}: {
  entry: AuditEntry;
  /** The entry's entity, for field labels and types; entries only cover readable entities. */
  entity: Entity | undefined;
  showRecord?: boolean;
}) {
  // Entity field order, then anything the schema no longer lists.
  const changed = Object.keys(entry.diff);
  const ordered = [
    ...(entity?.fields.map((f) => f.name).filter((name) => changed.includes(name)) ?? []),
    ...changed.filter((name) => !entity?.fields.some((f) => f.name === name)),
  ];
  const accessEntity = Object.hasOwn(ACCESS_ENTITIES, entry.entity)
    ? ACCESS_ENTITIES[entry.entity]
    : undefined;
  const fieldOf = (name: string) =>
    entity?.fields.find((f) => f.name === name) ?? { name, label: name, dataType: 'text' };
  const actionDetails = isActionDetails(entry.details) ? entry.details : null;
  const parentLabel = useActionLabel(entry.parent?.action);
  const ownLabel = useActionLabel(actionDetails ? entry.action : undefined);
  const softDelete = isSoftDeleteDetails(entry.details) ? entry.details.softDelete : undefined;
  // A soft-deleted row is still there to link to.
  const recordLink =
    entity &&
    entity.primaryKey.length > 0 &&
    entry.recordId !== null &&
    (entry.action !== 'delete' || softDelete !== undefined)
      ? recordPath(entity, entry.recordId)
      : undefined;

  return (
    <article className="space-y-3 rounded-md border p-4" aria-label={`${entry.action} ${entry.id}`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Badge variant={ACTION_VARIANTS[entry.action] ?? 'outline'}>
          {ownLabel ?? entry.action}
        </Badge>
        {softDelete && (
          <Badge variant="outline">{softDelete === 'delete' ? 'soft delete' : 'restore'}</Badge>
        )}
        {showRecord && (
          <span className="font-medium">
            {entity?.label ?? accessEntity ?? entry.entity}
            {entry.recordId !== null && (
              <>
                {' '}
                {recordLink ? (
                  <Link to={recordLink} className="underline underline-offset-4">
                    {entry.recordId}
                  </Link>
                ) : (
                  entry.recordId
                )}
              </>
            )}
          </span>
        )}
        <span title={entry.actor.subject}>{entry.actor.email ?? entry.actor.subject}</span>
        {entry.actor.userId !== undefined && (
          <span className="text-muted-foreground">user {entry.actor.userId}</span>
        )}
        {entry.source != null && (
          <Badge variant="outline" title="Source">
            {entry.source}
          </Badge>
        )}
        <time dateTime={entry.occurredAt} className="text-muted-foreground">
          {formatTime(entry.occurredAt)}
        </time>
        {entry.parent && (
          <span className="text-muted-foreground">
            as part of <span className="font-medium text-foreground">{parentLabel}</span>
          </span>
        )}
      </header>
      {entry.reason && (
        <blockquote className="border-l-2 border-primary/60 pl-3 text-sm whitespace-pre-wrap">
          <span className="block text-xs font-medium text-muted-foreground">Internal note</span>
          {entry.reason}
        </blockquote>
      )}
      {accessEntity ? (
        <AccessSummary entry={entry} />
      ) : actionDetails ? (
        <ActionSummary entry={entry} details={actionDetails} />
      ) : entry.details && 'columns' in entry.details ? (
        <ExportSummary details={entry.details} entity={entity} />
      ) : ordered.length > 0 ? (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Field
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Before
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  After
                </th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((name) => {
                const field = fieldOf(name);
                const change = entry.diff[name]!;
                return (
                  <tr key={name} className="border-t align-top">
                    <th scope="row" className="px-3 py-2 text-left font-medium whitespace-nowrap">
                      {field.label}
                    </th>
                    <td className="max-w-md px-3 py-2">
                      {entry.before !== null && <FieldValue field={field} value={change.from} />}
                    </td>
                    <td className="max-w-md px-3 py-2">
                      {entry.after !== null && <FieldValue field={field} value={change.to} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No field changes.</p>
      )}
    </article>
  );
}
