import type { Field } from '@wardenhq/core';

/** Read-only rendering of a column value as the API returns it. */
export function FieldValue({ field, value }: { field: Pick<Field, 'dataType'>; value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>;
  if (field.dataType === 'json' || field.dataType === 'jsonb' || typeof value === 'object') {
    return (
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return <span className="break-words whitespace-pre-wrap">{String(value)}</span>;
}

/** One-line text for a row in links and lists. */
export function displayText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
