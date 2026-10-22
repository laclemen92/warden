import type { Entity } from '@wardenhq/core';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { AuditEntryItem } from '@/components/audit-entry';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { filtersFromParams, filtersToParams, useAuditSearch, type AuditFilters } from '@/lib/audit';
import { useSchema } from '@/lib/schema';
import { NotFoundPage } from '@/pages/not-found-page';

// Radix selects can't have an empty value, so "any" stands for no filter.
const ANY = '*';
const ACTIONS = ['create', 'update', 'delete', 'export', 'assign', 'unassign', 'revoke_sessions'];

export function AuditLogPage() {
  const [params, setParams] = useSearchParams();
  const filters = filtersFromParams(params);
  const { data: schema } = useSchema();
  const entities = new Map(schema?.entities.map((e) => [e.key, e]));
  const search = useAuditSearch(filters);
  // Entries carry a source only when the audit table is shared with the application.
  const hasSource =
    filters.source !== undefined ||
    (search.data?.pages[0]?.items.some((e) => e.source !== undefined) ?? false);

  // Users without access get the same 404 as a page that doesn't exist.
  if (search.error instanceof ApiError && search.error.status === 404) return <NotFoundPage />;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="text-sm text-muted-foreground">
          Every change made through Warden, and who was given access, newest first.
        </p>
      </div>

      <AuditFilterForm
        // Remounted when the URL changes (back/forward), so the form shows the applied filters.
        key={params.toString()}
        filters={filters}
        hasSource={hasSource}
        entities={[...entities.values()].sort((a, b) => a.label.localeCompare(b.label))}
        onApply={(next) => setParams(filtersToParams(next))}
      />

      <AuditResults search={search} entities={entities} />
    </div>
  );
}

function AuditFilterForm({
  filters,
  hasSource,
  entities,
  onApply,
}: {
  filters: AuditFilters;
  hasSource: boolean;
  entities: Entity[];
  onApply: (filters: AuditFilters) => void;
}) {
  const [draft, setDraft] = useState(filters);
  const set = (key: keyof AuditFilters, value: string) =>
    setDraft((d) => ({ ...d, [key]: value === ANY ? '' : value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply(draft);
  };

  return (
    <form
      aria-label="Filter audit log"
      onSubmit={submit}
      className="flex flex-wrap items-end gap-3 rounded-md border p-4"
    >
      <label className="space-y-1 text-sm">
        <span className="font-medium">Actor</span>
        <Input
          className="w-56"
          placeholder="Email or subject"
          value={draft.actor ?? ''}
          onChange={(e) => set('actor', e.target.value)}
        />
      </label>
      <div className="space-y-1 text-sm">
        <span className="font-medium">Entity</span>
        <Select value={draft.entity || ANY} onValueChange={(v) => set('entity', v)}>
          <SelectTrigger className="w-48" aria-label="Entity">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any entity</SelectItem>
            {entities.map((e) => (
              <SelectItem key={e.key} value={e.key}>
                {e.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1 text-sm">
        <span className="font-medium">Action</span>
        <Select value={draft.action || ANY} onValueChange={(v) => set('action', v)}>
          <SelectTrigger className="w-36" aria-label="Action">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any action</SelectItem>
            {ACTIONS.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {hasSource && (
        <label className="space-y-1 text-sm">
          <span className="font-medium">Source</span>
          <Input
            className="w-36"
            placeholder="Any source"
            value={draft.source ?? ''}
            onChange={(e) => set('source', e.target.value)}
          />
        </label>
      )}
      <label className="space-y-1 text-sm">
        <span className="font-medium">From</span>
        <Input
          type="date"
          className="w-40"
          value={draft.from ?? ''}
          max={draft.to || undefined}
          onChange={(e) => set('from', e.target.value)}
        />
      </label>
      <label className="space-y-1 text-sm">
        <span className="font-medium">To</span>
        <Input
          type="date"
          className="w-40"
          value={draft.to ?? ''}
          min={draft.from || undefined}
          onChange={(e) => set('to', e.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit">Search</Button>
        <Button type="button" variant="ghost" onClick={() => onApply({})}>
          Clear
        </Button>
      </div>
    </form>
  );
}

function AuditResults({
  search: { data, isPending, error, hasNextPage, fetchNextPage, isFetchingNextPage },
  entities,
}: {
  search: ReturnType<typeof useAuditSearch>;
  entities: Map<string, Entity>;
}) {
  if (isPending) return <Skeleton className="h-48 w-full" />;
  if (error) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        {error instanceof ApiError && error.status === 400
          ? `Couldn't search: ${error.message}.`
          : error instanceof ApiError && error.status === 503
            ? `Couldn't load the audit log: ${error.message}.`
            : "Couldn't load the audit log."}
      </p>
    );
  }

  const entries = data.pages.flatMap((p) => p.items);
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No matching entries.</p>;
  }
  return (
    <div className="space-y-3">
      {entries.map((entry) => (
        <AuditEntryItem
          key={entry.id}
          entry={entry}
          entity={entities.get(entry.entity)}
          showRecord
        />
      ))}
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
  );
}
