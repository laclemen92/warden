import type { Entity } from '@wardenhq/core';
import { Link } from 'react-router';
import { FieldValue } from '@/components/field-value';
import { Badge } from '@/components/ui/badge';
import type { AuditEntry } from '@/lib/audit';
import { recordPath } from '@/lib/records';

const ACTION_VARIANTS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  create: 'default',
  update: 'secondary',
  delete: 'destructive',
};

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
            {entity?.label ?? entry.entity}
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
      {ordered.length > 0 ? (
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
