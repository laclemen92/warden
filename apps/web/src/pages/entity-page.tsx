import { useParams } from 'react-router';
import { EntityGrid } from '@/components/entity-grid';
import { Skeleton } from '@/components/ui/skeleton';
import { NotFoundPage } from '@/pages/not-found-page';
import { useSchema } from '@/lib/schema';

export function EntityPage() {
  const { entity: key } = useParams();
  const { data: schema, isPending } = useSchema();

  if (isPending) return <Skeleton className="h-8 w-48" />;

  const entity = schema?.entities.find((e) => e.key === key);
  if (!entity) return <NotFoundPage />;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{entity.label}</h1>
        {entity.comment && <p className="text-muted-foreground">{entity.comment}</p>}
      </div>
      {/* Keyed so sort/filter UI state doesn't carry over between entities. */}
      <EntityGrid key={entity.key} entity={entity} />
    </div>
  );
}
