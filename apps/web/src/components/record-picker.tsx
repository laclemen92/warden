import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { relationFilter, type Entity, type Relation } from '@wardenhq/core';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown, X } from 'lucide-react';
import { cn } from 'cn';
import { displayText } from '@/components/field-value';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useParentRecord, useRecordSearch, type RecordItem, type Row } from '@/lib/records';
import type { Drafts } from '@/lib/form-fields';

const SEARCH_DEBOUNCE_MS = 250;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** The key values `item` would give the relation's columns, or null if a key is missing. */
function keyOf(relation: Relation, item: RecordItem): Drafts | null {
  const drafts: Drafts = {};
  for (const [i, column] of relation.columns.entries()) {
    const value = item.values[relation.targetColumns[i]!];
    if (value === null || value === undefined) return null;
    drafts[column] = String(value);
  }
  return drafts;
}

const keyText = (relation: Relation, values: Drafts) =>
  relation.columns.map((c) => values[c] ?? '').join(', ');

/**
 * Picks the record a `belongsTo` relation points at by searching the target entity, and sets
 * every column of the foreign key from it. Shows the current target by its display field.
 */
export function RecordPicker({
  id,
  relation,
  target,
  value,
  onChange,
  clearable,
  invalid,
  describedBy,
}: {
  id: string;
  relation: Relation;
  target: Entity;
  /** Drafts of the relation's columns. */
  value: Drafts;
  onChange: (value: Drafts) => void;
  clearable: boolean;
  invalid: boolean;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const query = useDebounced(term, SEARCH_DEBOUNCE_MS);
  const search = useRecordSearch(target, relation.targetColumns, query, open);
  const listId = useId();
  const queryClient = useQueryClient();

  const empty = relation.columns.every((c) => !value[c]);
  // Blank columns are null, which relates to nothing.
  const row: Row = Object.fromEntries(relation.columns.map((c) => [c, value[c] || null]));
  const { data: current, isPending: currentPending } = useParentRecord(relation, row);

  const items = (search.data?.items ?? []).filter((item) => keyOf(relation, item) !== null);
  const showsKey = !relation.targetColumns.includes(target.displayField);

  const choose = (item: RecordItem) => {
    const key = keyOf(relation, item);
    if (!key) return;
    // The chosen record is the parent the new key points at; no need to fetch it again.
    queryClient.setQueryData(['parent', relation.entity, relationFilter(relation, key)], item);
    onChange(key);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => Math.min(Math.max(i + step, 0), Math.max(items.length - 1, 0)));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[active];
      if (item) choose(item);
    }
  };

  let label: string;
  if (empty) label = `Choose ${target.label.toLowerCase()}…`;
  else if (current) label = displayText(current.values[target.displayField]);
  // Until it loads, or if the record can't be found, show the raw key.
  else
    label = currentPending ? keyText(relation, value) : `${keyText(relation, value)} (not found)`;

  return (
    <div className="flex items-center gap-1">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            setTerm('');
            setActive(0);
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            className={cn('w-full justify-between font-normal', empty && 'text-muted-foreground')}
          >
            <span className="truncate">{label}</span>
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-72 p-0">
          <div className="border-b p-2">
            <Input
              autoFocus
              type="search"
              role="searchbox"
              aria-label={`Search ${target.label.toLowerCase()}`}
              aria-controls={listId}
              placeholder={target.searchable.length > 0 ? 'Search…' : 'Search by key…'}
              className="h-8"
              value={term}
              onChange={(e) => {
                setTerm(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
            />
          </div>
          <ul
            id={listId}
            role="listbox"
            aria-label={target.label}
            className="max-h-64 overflow-y-auto p-1"
          >
            {items.map((item, i) => {
              const key = keyOf(relation, item)!;
              const selected = relation.columns.every((c) => value[c] === key[c]);
              const text = displayText(item.values[target.displayField]);
              return (
                <li
                  key={keyText(relation, key)}
                  role="option"
                  aria-selected={selected}
                  aria-label={showsKey ? `${text} (${keyText(relation, key)})` : text}
                  className={cn(
                    'flex cursor-default items-baseline justify-between gap-3 rounded-sm px-2 py-1.5 text-sm',
                    i === active && 'bg-accent text-accent-foreground',
                    selected && 'font-medium',
                  )}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(item)}
                >
                  <span className="truncate">{text}</span>
                  {showsKey && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {keyText(relation, key)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="px-3 pb-2 text-xs text-muted-foreground empty:hidden" aria-live="polite">
            {search.isError
              ? `Couldn't load ${target.label.toLowerCase()}.`
              : search.isPending
                ? 'Loading…'
                : items.length === 0
                  ? 'No matches.'
                  : search.data?.hasMore
                    ? 'Showing the first matches. Type to narrow them down.'
                    : ''}
          </p>
        </PopoverContent>
      </Popover>
      {clearable && !empty && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Clear"
          onClick={() => onChange(Object.fromEntries(relation.columns.map((c) => [c, ''])))}
        >
          <X />
        </Button>
      )}
    </div>
  );
}
