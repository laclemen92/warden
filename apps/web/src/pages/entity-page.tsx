import { useParams } from 'react-router';
import { Skeleton } from '@/components/ui/skeleton';
import { NotFoundPage } from '@/pages/not-found-page';
import { useSchema } from '@/lib/schema';

// The grid (#21) and detail view (#22) mount here.
export function EntityPage() {
  const { entity: key } = useParams();
  const { data: schema, isPending } = useSchema();

  if (isPending) return <Skeleton className="h-8 w-48" />;

  const entity = schema?.entities.find((e) => e.key === key);
  if (!entity) return <NotFoundPage />;

  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">{entity.label}</h1>
      {entity.comment && <p className="text-muted-foreground">{entity.comment}</p>}
    </div>
  );
}
