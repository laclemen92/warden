import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  createColumnHelper,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type SortingState,
  type Updater,
} from '@tanstack/react-table';
import { MAX_SORT_TERMS, isSortable, type Condition, type Entity } from '@wardenhq/core';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Search,
  X,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { cn } from 'cn';
import { FilterBuilder } from '@/components/filter-builder';
import { Badge } from '@/components/ui/badge';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api';
import { conditionsToFilter, describeCondition, filterToConditions } from '@/lib/filters';
import {
  PAGE_SIZES,
  listUrl,
  maxPage,
  readGridState,
  writeGridState,
  type GridUpdate,
} from '@/lib/grid-state';

export interface ListItem {
  /** Encoded record id; null when the entity has no primary key. */
  id: string | null;
  values: Record<string, unknown>;
}

export interface ListResponse {
  items: ListItem[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}

const features = tableFeatures({ rowSortingFeature });
const helper = createColumnHelper<typeof features, ListItem>();
const NO_ROWS: ListItem[] = [];
const SEARCH_DEBOUNCE_MS = 300;
const numberFormat = new Intl.NumberFormat();

function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground italic">null</span>;
  }
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return (
    <span className="block max-w-80 truncate" title={text}>
      {text}
    </span>
  );
}

function SearchBox({ value, onSearch }: { value: string; onSearch: (q: string) => void }) {
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Follow the URL when it changes elsewhere (back button, clearing filters).
  if (value !== synced) {
    setSynced(value);
    setText(value);
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        aria-label="Search"
        placeholder="Search…"
        className="h-8 w-64 pl-8"
        value={text}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => onSearch(next), SEARCH_DEBOUNCE_MS);
        }}
      />
    </div>
  );
}

/** Server-backed grid for one entity. Sort, filter, search, and page all live in the URL. */
export function EntityGrid({ entity }: { entity: Entity }) {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => readGridState(params, entity), [params, entity]);
  const conditions = useMemo(() => filterToConditions(state.filter), [state.filter]);
  const url = listUrl(entity, state);

  const rows = useQuery({
    queryKey: ['rows', entity.key, url],
    queryFn: () => apiFetch<ListResponse>(url),
    placeholderData: keepPreviousData,
  });

  const update = (change: GridUpdate, options?: { replace?: boolean }) =>
    setParams((current) => writeGridState(current, change), options);

  const columns = useMemo(
    () =>
      entity.fields.map((field) =>
        helper.accessor((row) => row.values[field.name], {
          id: field.name,
          header: field.label,
          enableSorting: isSortable(field),
          cell: (info) => <CellValue value={info.getValue()} />,
        }),
      ),
    [entity],
  );

  const sorting = useMemo<SortingState>(
    () => state.sort.map((t) => ({ id: t.field, desc: t.direction === 'desc' })),
    [state.sort],
  );

  const onSortingChange = (updater: Updater<SortingState>) => {
    const next = typeof updater === 'function' ? updater(sorting) : updater;
    update({
      sort: next.map((s) => ({ field: s.id, direction: s.desc ? 'desc' : 'asc' })),
    });
  };

  const table = useTable({
    features,
    columns,
    data: rows.data?.items ?? NO_ROWS,
    getRowId: (row, index) => row.id ?? String(index),
    state: { sorting },
    onSortingChange,
    manualSorting: true,
    // An empty sort would fall back to the default sort server-side; never offer it.
    enableSortingRemoval: false,
    enableMultiSort: true,
    maxMultiSortColCount: MAX_SORT_TERMS,
    sortDescFirst: false,
  });

  const applyConditions = (next: Condition[]) => {
    const filter = conditionsToFilter(next);
    update({ filter: filter ? JSON.stringify(filter) : null });
  };

  const total = rows.data?.total;
  const count = rows.data?.items.length ?? 0;
  const first = (state.page - 1) * state.pageSize;
  const lastPage = Math.min(
    maxPage(state.pageSize),
    total !== undefined ? Math.max(1, Math.ceil(total / state.pageSize)) : Infinity,
  );
  const hasFilters = Boolean(state.filter || state.q);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {entity.searchable.length > 0 && (
          <SearchBox value={state.q} onSearch={(q) => update({ q }, { replace: true })} />
        )}
        <FilterBuilder entity={entity} conditions={conditions} onApply={applyConditions} />
        <ul aria-label="Active filters" className="flex flex-wrap items-center gap-1.5">
          {conditions === undefined ? (
            <li>
              <Badge variant="secondary">Custom filter</Badge>
            </li>
          ) : (
            conditions.map((c, i) => {
              const text = describeCondition(entity, c);
              return (
                <li key={i}>
                  <Badge variant="secondary" className="gap-1 pr-1">
                    {text}
                    <button
                      type="button"
                      aria-label={`Remove filter: ${text}`}
                      className="rounded-sm opacity-70 hover:opacity-100"
                      onClick={() => applyConditions(conditions.filter((_, j) => j !== i))}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                </li>
              );
            })
          )}
        </ul>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={() => update({ filter: null, q: '' })}>
            Clear filters
          </Button>
        )}
      </div>

      {rows.isError ? (
        <div role="alert" className="rounded-md border border-destructive/50 p-4 text-sm">
          <p className="font-medium">Couldn't load rows.</p>
          <p className="text-muted-foreground">{rows.error.message}</p>
        </div>
      ) : (
        <div
          className={cn(
            'rounded-md border transition-opacity',
            rows.isPlaceholderData && 'opacity-60',
          )}
          aria-busy={rows.isFetching}
        >
          <Table aria-label={entity.label}>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => {
                    const sorted = header.column.getIsSorted();
                    const index = header.column.getSortIndex();
                    const Icon =
                      sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ArrowUpDown;
                    return (
                      <TableHead
                        key={header.id}
                        aria-sort={
                          sorted === 'asc'
                            ? 'ascending'
                            : sorted === 'desc'
                              ? 'descending'
                              : undefined
                        }
                      >
                        {header.column.getCanSort() ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="-ml-3"
                            title="Click to sort; Shift+click to sort by several columns"
                            onClick={header.column.getToggleSortingHandler()}
                          >
                            <table.FlexRender header={header} />
                            <Icon className={cn(!sorted && 'text-muted-foreground/50')} />
                            {sorted && sorting.length > 1 && (
                              <span className="text-xs text-muted-foreground">{index + 1}</span>
                            )}
                          </Button>
                        ) : (
                          <table.FlexRender header={header} />
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {rows.isPending ? (
                Array.from({ length: 5 }, (_, i) => (
                  <TableRow key={i}>
                    {columns.map((c) => (
                      <TableCell key={c.id}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : count === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={Math.max(1, columns.length)}
                    className="h-24 text-center text-muted-foreground"
                  >
                    {hasFilters ? 'No rows match these filters.' : 'No rows.'}
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getAllCells().map((cell) => (
                      <TableCell key={cell.id}>
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <nav
        aria-label="Pagination"
        className="flex flex-wrap items-center justify-between gap-2 text-sm"
      >
        <p className="text-muted-foreground" aria-live="polite">
          {count > 0
            ? `${numberFormat.format(first + 1)}–${numberFormat.format(first + count)}` +
              (total !== undefined ? ` of ${numberFormat.format(total)}` : '')
            : total !== undefined
              ? `0 of ${numberFormat.format(total)}`
              : ''}
        </p>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Rows per page</span>
          <Select
            value={String(state.pageSize)}
            onValueChange={(v) => update({ pageSize: Number(v) })}
          >
            <SelectTrigger size="sm" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="px-2 text-muted-foreground">
            Page {numberFormat.format(state.page)}
            {Number.isFinite(lastPage) ? ` of ${numberFormat.format(lastPage)}` : ''}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous page"
            disabled={state.page <= 1}
            onClick={() => update({ page: Math.min(state.page - 1, lastPage) })}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next page"
            disabled={!rows.data?.hasMore || state.page >= lastPage}
            onClick={() => update({ page: state.page + 1 })}
          >
            <ChevronRight />
          </Button>
        </div>
      </nav>
    </div>
  );
}
