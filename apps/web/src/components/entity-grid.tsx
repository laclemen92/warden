import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  createColumnHelper,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type SortingState,
  type Updater,
} from '@tanstack/react-table';
import {
  MAX_SORT_TERMS,
  gridColumnOrder,
  isSortable,
  type Condition,
  type Entity,
} from '@wardenhq/core';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { cn } from 'cn';
import { BulkActionsBar, EntityActionsMenu, RowActionsMenu } from '@/components/actions-menu';
import { ColumnPicker } from '@/components/column-picker';
import { ExportButton } from '@/components/export-button';
import { FilterBuilder } from '@/components/filter-builder';
import { SavedViewsMenu } from '@/components/saved-views-menu';
import { SortMenu } from '@/components/sort-menu';
import { Badge } from '@/components/ui/badge';
import { displayText } from '@/components/field-value';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useEntityActions } from '@/lib/actions';
import { apiFetch } from '@/lib/api';
import { useCan } from '@/lib/capabilities';
import { exportUrl } from '@/lib/export';
import { conditionsToFilter, describeCondition, filterToConditions } from '@/lib/filters';
import {
  PAGE_SIZES,
  listUrl,
  maxPage,
  readGridState,
  viewParams,
  writeGridState,
  type GridUpdate,
} from '@/lib/grid-state';
import { recordPath, type RecordItem, type RecordList } from '@/lib/records';
import { FROM_PARAM, useSavedView, useViewList, type SavedView } from '@/lib/saved-views';

/** Params that make up a grid's state. A table opened without any gets its default view. */
const STATE_PARAMS = ['sort', 'filter', 'q', 'columns', 'page', 'view', FROM_PARAM];

/** URL params that show a view; config views remember where they came from. */
function paramsFor(view: SavedView, pageSize: string | null) {
  const next = viewParams(view.state ?? {});
  if (view.origin === 'config') next.set(FROM_PARAM, view.id);
  // Page size is the user's preference, not part of the view.
  if (pageSize) next.set('pageSize', pageSize);
  return next;
}

const features = tableFeatures({ rowSortingFeature });
const helper = createColumnHelper<typeof features, RecordItem>();
const NO_ROWS: RecordItem[] = [];
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

// Double-clicks on these keep their own meaning instead of opening the row.
const INTERACTIVE =
  'a, button, input, select, textarea, label, [role="checkbox"], [role="menuitem"]';

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

/**
 * Server-backed grid for one entity. Sort, filter, search, columns, and page all live in the
 * URL. A `?view=<id>` link is replaced by the saved view's state once it loads.
 */
export function EntityGrid({ entity }: { entity: Entity }) {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => readGridState(params, entity), [params, entity]);
  const conditions = useMemo(() => filterToConditions(state.filter), [state.filter]);
  const url = listUrl(entity, state);

  const viewId = params.get('view');
  const linked = useSavedView(viewId);
  // Carried in history state, so it goes away with the next change to the grid.
  const viewError = (useLocation().state as { viewError?: string } | null)?.viewError;
  useEffect(() => {
    if (!viewId || linked.isPending) return;
    const view = linked.data;
    if (view?.state && view.entity === entity.key) {
      setParams(paramsFor(view, params.get('pageSize')), { replace: true });
      return;
    }
    const next = new URLSearchParams(params);
    next.delete('view');
    setParams(next, {
      replace: true,
      state: {
        viewError:
          view?.state === null
            ? `The view "${view.name}" uses a column you can't see.`
            : "This saved view doesn't exist or isn't available to you.",
      },
    });
  }, [viewId, linked.isPending, linked.data, entity.key, params, setParams]);

  // A config view marked `default` applies when the table is opened without grid state. Only
  // on opening: clearing the grid afterwards shows every row.
  const viewList = useViewList(entity.key);
  const bare = !STATE_PARAMS.some((key) => params.has(key));
  const [defaultChecked, setDefaultChecked] = useState<string | null>(null);
  const checkingDefault = defaultChecked !== entity.key;
  const defaultView =
    checkingDefault && bare
      ? viewList.data?.views.find((v) => v.origin === 'config' && v.default && v.state)
      : undefined;
  if (checkingDefault && !defaultView && !(bare && viewList.isPending)) {
    setDefaultChecked(entity.key);
  }
  useEffect(() => {
    if (defaultView) setParams(paramsFor(defaultView, params.get('pageSize')), { replace: true });
  }, [defaultView, params, setParams]);

  const rows = useQuery({
    queryKey: ['rows', entity.key, url],
    queryFn: () => apiFetch<RecordList>(url),
    placeholderData: keepPreviousData,
    // Don't load rows for the default state while a view is about to replace it.
    enabled: !viewId && !(checkingDefault && bare && (viewList.isPending || defaultView)),
  });

  const update = (change: GridUpdate, options?: { replace?: boolean }) =>
    setParams((current) => writeGridState(current, change), options);

  const applyView = (view: SavedView) =>
    setParams((current) => paramsFor(view, current.get('pageSize')));

  const fields = useMemo(() => {
    const byName = new Map(entity.fields.map((f) => [f.name, f]));
    return gridColumnOrder(entity).flatMap((name) => {
      const field = byName.get(name);
      return field && (!state.columns || state.columns.includes(name)) ? [field] : [];
    });
  }, [entity, state.columns]);

  const navigate = useNavigate();
  // The double-click itself selects a word, so check for a selection when it starts instead: a
  // user who had text selected is copying, not opening.
  const selectedOnPress = useRef(false);
  const pressRow = (e: MouseEvent<HTMLTableRowElement>) => {
    if (e.detail === 1) selectedOnPress.current = Boolean(window.getSelection()?.toString());
  };
  const openRow = (e: MouseEvent<HTMLTableRowElement>, id: string) => {
    const target = e.target as Element;
    // Events from portals (an open actions menu) bubble through React's tree, not the DOM's.
    if (!e.currentTarget.contains(target) || target.closest(INTERACTIVE)) return;
    if (selectedOnPress.current) return;
    void navigate(recordPath(entity, id));
  };

  // Custom actions: per row, and on a selection of rows. Rows need ids for either.
  const addressable = entity.primaryKey.length > 0;
  const rowActions = useEntityActions(entity.key, 'one');
  const bulkActions = useEntityActions(entity.key, 'many');
  const selectable = addressable && bulkActions.length > 0;
  // The selection belongs to the rows it was made on, so it clears when the grid changes.
  const [selection, setSelection] = useState({ url, ids: [] as string[] });
  const selected = useMemo(() => (selection.url === url ? selection.ids : []), [selection, url]);
  const pageIds = useMemo(
    () => (rows.data?.items ?? []).flatMap((item) => (item.id === null ? [] : [item.id])),
    [rows.data],
  );

  const dataColumns = useMemo(
    () =>
      fields.map((field) =>
        helper.accessor((row) => row.values[field.name], {
          id: field.name,
          header: field.label,
          enableSorting: isSortable(field),
          cell: (info) => {
            const id = info.row.original.id;
            // The display field opens the record; rows without a primary key can't be opened.
            return field.name === entity.displayField && id !== null ? (
              <Link
                to={recordPath(entity, id)}
                className="font-medium underline underline-offset-4"
              >
                <CellValue value={info.getValue()} />
              </Link>
            ) : (
              <CellValue value={info.getValue()} />
            );
          },
        }),
      ),
    [entity, fields],
  );

  const columns = useMemo(() => {
    const select = (ids: string[]) => setSelection({ url, ids });
    const label = (item: RecordItem) => displayText(item.values[entity.displayField]);
    const all = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
    const selectColumn = helper.display({
      id: '_select',
      header: () => (
        <Checkbox
          aria-label="Select all rows on this page"
          checked={all ? true : selected.length > 0 ? 'indeterminate' : false}
          onCheckedChange={(checked) => select(checked === true ? pageIds : [])}
        />
      ),
      cell: (info) => {
        const item = info.row.original;
        const id = item.id;
        return (
          id !== null && (
            <Checkbox
              aria-label={`Select ${label(item)}`}
              checked={selected.includes(id)}
              onCheckedChange={(checked) =>
                select(checked === true ? [...selected, id] : selected.filter((x) => x !== id))
              }
            />
          )
        );
      },
    });
    const actionsColumn = helper.display({
      id: '_actions',
      header: () => <span className="sr-only">Actions</span>,
      cell: (info) => {
        const item = info.row.original;
        return (
          item.id !== null && (
            <RowActionsMenu actions={rowActions} id={item.id} label={label(item)} />
          )
        );
      },
    });
    // Up front, so the row menu doesn't scroll out of view on wide tables.
    return [
      ...(selectable ? [selectColumn] : []),
      ...(addressable && rowActions.length > 0 ? [actionsColumn] : []),
      ...dataColumns,
    ];
  }, [addressable, dataColumns, entity, pageIds, rowActions, selectable, selected, url]);

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
  const canExport = useCan(entity.key, 'export');

  return (
    <div className="space-y-3">
      {viewError && (
        <div role="alert" className="rounded-md border border-destructive/50 p-3 text-sm">
          {viewError}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <SavedViewsMenu entity={entity} params={params} onApply={applyView} />
        {entity.searchable.length > 0 && (
          <SearchBox value={state.q} onSearch={(q) => update({ q }, { replace: true })} />
        )}
        <FilterBuilder entity={entity} conditions={conditions} onApply={applyConditions} />
        <SortMenu
          entity={entity}
          sort={state.sort}
          explicit={Boolean(params.get('sort')?.trim())}
          onChange={(sort) => update({ sort })}
        />
        <ColumnPicker
          entity={entity}
          columns={state.columns}
          onChange={(next) => update({ columns: next })}
        />
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
        <div className="ml-auto flex items-center gap-2">
          <EntityActionsMenu entity={entity} />
          {canExport && (
            <ExportButton
              url={exportUrl(entity, state, params.get('sort'))}
              fallbackName={`${entity.key}.csv`}
            />
          )}
        </div>
      </div>

      {selectable && (
        <BulkActionsBar
          actions={bulkActions}
          selected={selected}
          onClear={() => setSelection({ url, ids: [] })}
        />
      )}

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
                table.getRowModel().rows.map((row) => {
                  const id = row.original.id;
                  return (
                    <TableRow
                      key={row.id}
                      {...(id !== null
                        ? {
                            className: 'cursor-pointer',
                            onMouseDown: pressRow,
                            onDoubleClick: (e) => openRow(e, id),
                          }
                        : {})}
                    >
                      {row.getAllCells().map((cell) => (
                        <TableCell key={cell.id}>
                          <table.FlexRender cell={cell} />
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })
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
