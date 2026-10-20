import type { ReactNode } from 'react';
import {
  parseSortFields,
  type Entity,
  type ExportDetails,
  type RevokeSessionsDetails,
} from '@wardenhq/core';
import { Link } from 'react-router';
import { FieldValue } from '@/components/field-value';
import { Badge } from '@/components/ui/badge';
import type { AuditEntry } from '@/lib/audit';
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
  const recordLink =
    entity && entity.primaryKey.length > 0 && entry.recordId !== null && entry.action !== 'delete'
      ? recordPath(entity, entry.recordId)
      : undefined;

  return (
    <article className="space-y-3 rounded-md border p-4" aria-label={`${entry.action} ${entry.id}`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Badge variant={ACTION_VARIANTS[entry.action] ?? 'outline'}>{entry.action}</Badge>
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
        <time dateTime={entry.occurredAt} className="text-muted-foreground">
          {formatTime(entry.occurredAt)}
        </time>
      </header>
      {entry.reason && (
        <p className="text-sm">
          <span className="text-muted-foreground">Reason: </span>
          {entry.reason}
        </p>
      )}
      {accessEntity ? (
        <AccessSummary entry={entry} />
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
