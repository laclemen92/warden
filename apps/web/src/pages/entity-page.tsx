import type { Entity } from '@wardenhq/core';
import { Plus } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { EntityGrid } from '@/components/entity-grid';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { NotFoundPage } from '@/pages/not-found-page';
import { useCan } from '@/lib/capabilities';
import { createRecordPath } from '@/lib/records';
import { useSchema } from '@/lib/schema';

export function EntityPage() {
  const { entity: key } = useParams();
  const { data: schema, isPending } = useSchema();

  if (isPending) return <Skeleton className="h-8 w-48" />;

  const entity = schema?.entities.find((e) => e.key === key);
  if (!entity) return <NotFoundPage />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">{entity.label}</h1>
          {entity.comment && <p className="text-muted-foreground">{entity.comment}</p>}
        </div>
        <NewRecordButton entity={entity} />
      </div>
      {/* Keyed so sort/filter UI state doesn't carry over between entities. */}
      <EntityGrid key={entity.key} entity={entity} />
    </div>
  );
}

/** Shown only to users who may create; the server enforces the policy either way. */
function NewRecordButton({ entity }: { entity: Entity }) {
  const canCreate = useCan(entity.key, 'create');
  if (!canCreate) return null;
  return (
    <Button asChild>
      <Link to={createRecordPath(entity)}>
        <Plus />
        New
      </Link>
    </Button>
  );
}
