import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="text-muted-foreground">
        This page doesn't exist.{' '}
        <Link to="/" className="underline">
          Go home
        </Link>
      </p>
    </div>
  );
}
