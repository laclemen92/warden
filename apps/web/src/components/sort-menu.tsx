import {
  MAX_SORT_TERMS,
  defaultSortOf,
  gridColumnOrder,
  isSortable,
  type Entity,
  type Field,
  type SortTerm,
} from '@wardenhq/core';
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Plus,
  X,
} from 'lucide-react';
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface FieldComboboxProps {
  fields: Field[];
  selected?: string;
  label: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
  onChoose: (field: Field) => void;
}

/** A button that opens a searchable list of fields. */
function FieldCombobox({
  fields,
  selected,
  label,
  disabled,
  className,
  children,
  onChoose,
}: FieldComboboxProps) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();

  const needle = term.trim().toLowerCase();
  const matches = needle
    ? fields.filter(
        (f) => f.label.toLowerCase().includes(needle) || f.name.toLowerCase().includes(needle),
      )
    : fields;

  const choose = (field: Field) => {
    onChoose(field);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => Math.min(Math.max(i + step, 0), Math.max(matches.length - 1, 0)));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const field = matches[active];
      if (field) choose(field);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setTerm('');
          setActive(
            Math.max(
              0,
              fields.findIndex((f) => f.name === selected),
            ),
          );
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          disabled={disabled}
          className={className}
        >
          {children}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="border-b p-2">
          <Input
            autoFocus
            type="search"
            role="searchbox"
            aria-label="Search columns"
            aria-controls={listId}
            aria-activedescendant={matches[active] ? `${listId}-${active}` : undefined}
            placeholder="Search columns…"
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
          aria-label="Columns"
          className="max-h-64 overflow-y-auto p-1"
        >
          {matches.map((field, i) => (
            <li
              key={field.name}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={field.name === selected}
              className={cn(
                'cursor-default truncate rounded-sm px-2 py-1.5 text-sm',
                i === active && 'bg-accent text-accent-foreground',
                field.name === selected && 'font-medium',
              )}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(field)}
            >
              {field.label}
            </li>
          ))}
        </ul>
        {matches.length === 0 && (
          <p className="px-3 pb-2 text-xs text-muted-foreground">No matches.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

interface SortMenuProps {
  entity: Entity;
  /** The sort in effect: the URL's, or the entity's default when the URL has none. */
  sort: SortTerm[];
  /** Whether the URL sets the sort, so it can be cleared back to the default. */
  explicit: boolean;
  /** An empty list clears the sort back to the entity's default. */
  onChange: (sort: SortTerm[]) => void;
}

/**
 * Toolbar popover for building the grid's sort from any sortable field, including ones hidden
 * via the column picker. Edits apply straight away, through the same URL state as the headers.
 */
export function SortMenu({ entity, sort, explicit, onChange }: SortMenuProps) {
  const sortable = gridColumnOrder(entity).flatMap((name) => {
    const field = entity.fields.find((f) => f.name === name);
    return field && isSortable(field) ? [field] : [];
  });
  const labelOf = (name: string) => entity.fields.find((f) => f.name === name)?.label ?? name;
  const unused = (except?: string) =>
    sortable.filter((f) => f.name === except || !sort.some((t) => t.field === f.name));

  const replace = (index: number, term: SortTerm) =>
    onChange(sort.map((t, i) => (i === index ? term : t)));
  const move = (index: number, to: number) => {
    const next = [...sort];
    const [term] = next.splice(index, 1);
    if (term) next.splice(to, 0, term);
    onChange(next);
  };

  const first = sort[0];
  const summary =
    sort.length > 1
      ? `${sort.length} columns`
      : first
        ? `${labelOf(first.field)} ${first.direction === 'desc' ? '↓' : '↑'}`
        : undefined;
  const addable = unused();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <ArrowDownUp />
          {summary ? `Sort: ${summary}` : 'Sort'}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] min-w-80">
        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-sm font-medium">Sort by</p>
            {!explicit && sort.length > 0 && (
              <p className="text-xs text-muted-foreground">Default sort</p>
            )}
          </div>
          {sort.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sort applied.</p>
          ) : (
            <ol aria-label="Sort columns" className="space-y-2">
              {sort.map((term, i) => {
                const label = labelOf(term.field);
                const desc = term.direction === 'desc';
                return (
                  <li key={term.field} className="flex items-center gap-1.5">
                    <span className="w-4 text-right text-xs text-muted-foreground">{i + 1}</span>
                    <FieldCombobox
                      fields={unused(term.field)}
                      selected={term.field}
                      label={`Sort column ${i + 1}: ${label}`}
                      className="min-w-36 justify-between font-normal"
                      onChoose={(f) => replace(i, { ...term, field: f.name })}
                    >
                      <span className="truncate">{label}</span>
                      <ChevronsUpDown className="opacity-50" />
                    </FieldCombobox>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-28 justify-start"
                      aria-label={`${label}: ${desc ? 'descending' : 'ascending'}`}
                      title="Toggle direction"
                      onClick={() => replace(i, { ...term, direction: desc ? 'asc' : 'desc' })}
                    >
                      {desc ? <ArrowDown /> : <ArrowUp />}
                      {desc ? 'Descending' : 'Ascending'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Move ${label} up`}
                      disabled={i === 0}
                      onClick={() => move(i, i - 1)}
                    >
                      <ChevronUp />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Move ${label} down`}
                      disabled={i === sort.length - 1}
                      onClick={() => move(i, i + 1)}
                    >
                      <ChevronDown />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${label} sort`}
                      // The default sort is what an empty sort means, so there's nothing to remove.
                      disabled={!explicit}
                      onClick={() => onChange(sort.filter((_, j) => j !== i))}
                    >
                      <X />
                    </Button>
                  </li>
                );
              })}
            </ol>
          )}
          <div className="flex items-center justify-between gap-2">
            <FieldCombobox
              fields={addable}
              label="Add sort"
              disabled={sort.length >= MAX_SORT_TERMS || addable.length === 0}
              onChoose={(f) => onChange([...sort, { field: f.name, direction: 'asc' }])}
            >
              <Plus />
              Add sort
            </FieldCombobox>
            {explicit && (
              <Button variant="ghost" size="sm" onClick={() => onChange([])}>
                {defaultSortOf(entity) ? 'Reset to default' : 'Clear sort'}
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
