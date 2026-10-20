import { useState, type ReactNode } from 'react';
import type { Action, Entity } from '@wardenhq/core';
import { Link, useNavigate, useParams } from 'react-router';
import { displayText } from '@/components/field-value';
import { RecordForm, type RecordSubmission } from '@/components/record-form';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { useCan, useCapabilities } from '@/lib/capabilities';
import { recordPath, useCreateRecord, useRecord, useUpdateRecord } from '@/lib/records';
import { entityPath, useSchema } from '@/lib/schema';
import { NotFoundPage } from '@/pages/not-found-page';

/** The entity named in the URL, with every entity by key (for foreign key pickers). */
function useEntity() {
  const { entity: key } = useParams();
  const { data: schema, isPending } = useSchema();
  const entities = new Map(schema?.entities.map((e) => [e.key, e]));
  const entity = key === undefined ? undefined : entities.get(key);
  return { entity, entities, isPending };
}

function FormLayout({
  entity,
  title,
  children,
}: {
  entity: Entity;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="min-w-0 space-y-1">
        <Link
          to={entityPath(entity)}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          {entity.label}
        </Link>
        <h1 className="text-2xl font-semibold break-words">{title}</h1>
      </div>
      {children}
    </div>
  );
}

/**
 * Renders `children` only for users who may perform `action`. The server enforces the policy
 * either way; this just saves filling in a form that can't be saved.
 */
function Permitted({
  entity,
  action,
  children,
}: {
  entity: Entity;
  action: Action;
  children: ReactNode;
}) {
  const { isPending } = useCapabilities();
  const allowed = useCan(entity.key, action);
  if (isPending) return <Skeleton className="h-48 w-full" />;
  if (!allowed) {
    return (
      <p className="text-muted-foreground">
        You don't have permission to {action === 'create' ? 'create' : 'edit'} records in{' '}
        {entity.label}.
      </p>
    );
  }
  return children;
}

export function CreateRecordPage() {
  const { entity, entities, isPending } = useEntity();
  if (isPending) return <Skeleton className="h-8 w-48" />;
  if (!entity) return <NotFoundPage />;
  return (
    <FormLayout entity={entity} title={`New ${entity.label.toLowerCase()} record`}>
      <Permitted entity={entity} action="create">
        <CreateForm key={entity.key} entity={entity} entities={entities} />
      </Permitted>
    </FormLayout>
  );
}

function CreateForm({ entity, entities }: { entity: Entity; entities: Map<string, Entity> }) {
  const create = useCreateRecord(entity);
  const navigate = useNavigate();
  const canRead = useCan(entity.key, 'read');

  const submit = async (submission: RecordSubmission) => {
    const written = await create.mutateAsync(submission);
    // A caller who can't read the entity only gets the id back, and couldn't open the record.
    const to = written.id !== null && canRead ? recordPath(entity, written.id) : entityPath(entity);
    void navigate(to, { replace: true });
  };

  return (
    <RecordForm
      entity={entity}
      entities={entities}
      mode="create"
      onSubmit={submit}
      cancelTo={entityPath(entity)}
    />
  );
}

export function EditRecordPage() {
  const { entity, entities, isPending } = useEntity();
  const { id } = useParams();
  if (isPending) return <Skeleton className="h-8 w-48" />;
  if (!entity || entity.primaryKey.length === 0 || !id) return <NotFoundPage />;
  return <EditForm key={`${entity.key}/${id}`} entity={entity} entities={entities} id={id} />;
}

function EditForm({
  entity,
  entities,
  id,
}: {
  entity: Entity;
  entities: Map<string, Entity>;
  id: string;
}) {
  const { data: record, isPending, error, refetch } = useRecord(entity, id);
  const update = useUpdateRecord(entity);
  const navigate = useNavigate();
  // The form keeps its edits while the record refetches in the background; reloading after a
  // conflict starts it over from the current version.
  const [loaded, setLoaded] = useState(record);
  if (record && !loaded) setLoaded(record);

  if (isPending && !loaded) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (!loaded) return <p className="text-muted-foreground">Couldn't load this record.</p>;

  const submit = async ({ values, reason }: RecordSubmission) => {
    const written = await update.mutateAsync({
      id,
      version: loaded.version ?? '',
      values,
      ...(reason ? { reason } : {}),
    });
    // Changing the primary key moves the record.
    void navigate(recordPath(entity, written.id ?? id), { replace: true });
  };

  const reload = async () => {
    const { data } = await refetch();
    if (data) setLoaded(data);
  };

  return (
    <FormLayout entity={entity} title={`Edit ${displayText(loaded.values[entity.displayField])}`}>
      <Permitted entity={entity} action="update">
        <RecordForm
          key={loaded.version}
          entity={entity}
          entities={entities}
          mode="update"
          record={loaded.values}
          onSubmit={submit}
          onReload={() => void reload()}
          cancelTo={recordPath(entity, id)}
        />
      </Permitted>
    </FormLayout>
  );
}
