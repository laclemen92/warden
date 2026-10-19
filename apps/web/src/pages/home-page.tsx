import { Link } from 'react-router';
import { entityPath, useSchema } from '@/lib/schema';

export function HomePage() {
  const { data: schema } = useSchema();
  const entities = [...(schema?.entities ?? [])].sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Entities</h1>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {entities.map((entity) => (
          <li key={entity.key}>
            <Link
              to={entityPath(entity)}
              className="block rounded-lg border p-4 transition-colors hover:bg-accent"
            >
              <div className="font-medium">{entity.label}</div>
              {entity.comment && (
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{entity.comment}</p>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
