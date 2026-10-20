import { useState, type MouseEvent } from 'react';
import type { Entity, Field, Relation } from '@wardenhq/core';
import { Trash2 } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { displayText, FieldValue } from '@/components/field-value';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/api';
import { useCan } from '@/lib/capabilities';
import {
  recordPath,
  useDeleteRecord,
  useChildRecords,
  useParentRecord,
  useRecord,
  type RecordItem,
  type Row,
} from '@/lib/records';
import { entityPath, useSchema } from '@/lib/schema';
import { NotFoundPage } from '@/pages/not-found-page';

type EntityMap = Map<string, Entity>;

export function RecordPage() {
  const { entity: key, id } = useParams();
  const { data: schema, isPending } = useSchema();

  if (isPending) return <Skeleton className="h-8 w-48" />;

  const entities: EntityMap = new Map(schema?.entities.map((e) => [e.key, e]));
  const entity = key === undefined ? undefined : entities.get(key);
  if (!entity || entity.primaryKey.length === 0 || !id) return <NotFoundPage />;

  // Keyed so tabs and paging reset when following a link to another record.
  return <RecordView key={`${entity.key}/${id}`} entity={entity} id={id} entities={entities} />;
}

function RecordView({ entity, id, entities }: { entity: Entity; id: string; entities: EntityMap }) {
  const { data: record, isPending, error } = useRecord(entity, id);

  if (isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error) return <p className="text-muted-foreground">Couldn't load this record.</p>;

  const row = record.values;
  const children = entity.relations.filter((r) => r.kind === 'hasMany');

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Link
            to={entityPath(entity)}
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            {entity.label}
          </Link>
          <h1 className="text-2xl font-semibold break-words">
            {displayText(row[entity.displayField])}
          </h1>
        </div>
        <DeleteRecord entity={entity} record={{ ...record, id }} />
      </div>

      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(8rem,max-content)_1fr]">
        {entity.fields.map((field) => (
          <div key={field.name} className="contents">
            <dt className="text-sm font-medium text-muted-foreground" title={field.comment}>
              {field.label}
            </dt>
            <dd className="min-w-0 text-sm">
              <FieldCell entity={entity} field={field} row={row} entities={entities} />
            </dd>
          </div>
        ))}
      </dl>

      {children.length > 0 && (
        <section aria-label="Related records" className="space-y-3">
          <h2 className="text-lg font-semibold">Related</h2>
          <Tabs defaultValue={tabValue(children[0]!)}>
            <TabsList className="h-auto flex-wrap">
              {children.map((relation) => (
                <TabsTrigger key={tabValue(relation)} value={tabValue(relation)}>
                  {childLabel(relation, children, entities)}
                </TabsTrigger>
              ))}
            </TabsList>
            {children.map((relation) => {
              const child = entities.get(relation.entity);
              return (
                child && (
                  <TabsContent key={tabValue(relation)} value={tabValue(relation)}>
                    <ChildList relation={relation} child={child} row={row} />
                  </TabsContent>
                )
              );
            })}
          </Tabs>
        </section>
      )}
    </div>
  );
}

// apps/server/src/routes/entities.ts: a stale version, as opposed to a constraint conflict.
const STALE_MESSAGE = 'the record has changed since it was read';

function deleteErrorMessage(error: Error): string {
  if (!(error instanceof ApiError)) return "Couldn't delete this record.";
  if (error.status === 403) return "You don't have permission to delete this record.";
  if (error.status === 409) {
    return error.message === STALE_MESSAGE
      ? 'This record changed since you opened it. Review the current values and try again.'
      : "This record can't be deleted while other records refer to it.";
  }
  return "Couldn't delete this record.";
}

/** Shown only to users who may delete; the server enforces the policy either way. */
function DeleteRecord({ entity, record }: { entity: Entity; record: RecordItem & { id: string } }) {
  const canDelete = useCan(entity.key, 'delete');
  const remove = useDeleteRecord(entity);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  if (!canDelete) return null;

  const title = displayText(record.values[entity.displayField]);
  const confirm = (event: MouseEvent) => {
    // Keep the dialog open until the delete settles, so errors show in it.
    event.preventDefault();
    remove.mutate(record, {
      onSuccess: () => void navigate(entityPath(entity), { replace: true }),
      onError: (error) => {
        // Someone else already deleted it.
        if (error instanceof ApiError && error.status === 404) {
          void navigate(entityPath(entity), { replace: true });
        }
      },
    });
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) remove.reset();
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="outline">
          <Trash2 />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {title}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the record from {entity.label}. It can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {remove.error && (
          <p role="alert" className="text-sm text-destructive">
            {deleteErrorMessage(remove.error)}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: 'destructive' })}
            disabled={remove.isPending}
            onClick={confirm}
          >
            {remove.isPending ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Constraint names are only unique per table, so qualify them with the child entity.
const tabValue = (relation: Relation) => `${relation.entity}:${relation.name}`;

/** The child entity's label, plus the FK columns when it references this entity more than once. */
function childLabel(relation: Relation, all: Relation[], entities: EntityMap): string {
  const child = entities.get(relation.entity);
  const label = child?.label ?? relation.entity;
  if (all.filter((r) => r.entity === relation.entity).length < 2) return label;
  const via = relation.targetColumns
    .map((c) => child?.fields.find((f) => f.name === c)?.label ?? c)
    .join(', ');
  return `${label} (${via})`;
}

function FieldCell({
  entity,
  field,
  row,
  entities,
}: {
  entity: Entity;
  field: Field;
  row: Row;
  entities: EntityMap;
}) {
  // A composite FK links from its first column; the rest render as plain values.
  const relation = entity.relations.find(
    (r) => r.kind === 'belongsTo' && r.columns[0] === field.name,
  );
  const target = relation && entities.get(relation.entity);
  if (!relation || !target) return <FieldValue field={field} value={row[field.name]} />;
  return <ParentLink relation={relation} target={target} field={field} row={row} />;
}

function ParentLink({
  relation,
  target,
  field,
  row,
}: {
  relation: Relation;
  target: Entity;
  field: Field;
  row: Row;
}) {
  const { data: parent } = useParentRecord(relation, row);
  const raw = <FieldValue field={field} value={row[field.name]} />;
  // Until it loads, or if the parent can't be found, show the raw key.
  if (!parent?.id) return raw;
  return (
    <Link
      to={recordPath(target, parent.id)}
      className="font-medium underline underline-offset-4"
      title={`${target.label} ${displayText(row[field.name])}`}
    >
      {displayText(parent.values[target.displayField])}
    </Link>
  );
}

const MAX_CHILD_COLUMNS = 5;

function ChildList({ relation, child, row }: { relation: Relation; child: Entity; row: Row }) {
  const { data, isPending, isError, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useChildRecords(relation, row);

  if (isPending) return <Skeleton className="h-24 w-full" />;
  if (isError) return <p className="text-sm text-muted-foreground">Couldn't load records.</p>;

  const items: RecordItem[] = data.pages.flatMap((p) => p.items);
  const total = data.pages[0]?.total;
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No {child.label.toLowerCase()}.</p>;
  }

  // The display field first; the FK back to this record is the same on every row, so skip it.
  const display = child.fields.find((f) => f.name === child.displayField);
  const columns = [
    ...(display ? [display] : []),
    ...child.fields.filter(
      (f) => f !== display && !relation.targetColumns.includes(f.name) && !isBulky(f),
    ),
  ].slice(0, MAX_CHILD_COLUMNS);

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              {columns.map((f) => (
                <th key={f.name} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                  {f.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={item.id ?? i} className="border-t">
                {columns.map((f, j) => (
                  <td key={f.name} className="max-w-xs truncate px-3 py-2">
                    {j === 0 && item.id !== null ? (
                      <Link
                        to={recordPath(child, item.id)}
                        className="font-medium underline underline-offset-4"
                      >
                        {displayText(item.values[f.name])}
                      </Link>
                    ) : (
                      <FieldValue field={f} value={item.values[f.name]} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span>{total !== undefined ? `${items.length} of ${total}` : `${items.length}`} shown</span>
        {hasNextPage && (
          <Button
            variant="outline"
            size="sm"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        )}
      </div>
    </div>
  );
}

// JSON and arrays don't fit in a table cell.
const isBulky = (f: Field) => f.isArray || f.dataType === 'json' || f.dataType === 'jsonb';
