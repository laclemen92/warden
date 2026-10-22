import { gridColumnOrder, type Entity } from '@wardenhq/core';
import { Columns3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ColumnPickerProps {
  entity: Entity;
  /** Visible columns; undefined for all of them. */
  columns: string[] | undefined;
  /** `null` shows every column. */
  onChange: (columns: string[] | null) => void;
}

/** Shows and hides grid columns. At least one column stays visible. */
export function ColumnPicker({ entity, columns, onChange }: ColumnPickerProps) {
  const visible = new Set(columns ?? entity.fields.map((f) => f.name));
  const ordered = gridColumnOrder(entity).flatMap((name) => {
    const field = entity.fields.find((f) => f.name === name);
    return field ? [field] : [];
  });
  const toggle = (name: string, show: boolean) => {
    const next = entity.fields
      .map((f) => f.name)
      .filter((n) => (n === name ? show : visible.has(n)));
    onChange(next.length === entity.fields.length ? null : next);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Columns3 />
          Columns
          {columns && (
            <span className="text-xs text-muted-foreground">
              {columns.length}/{entity.fields.length}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 overflow-y-auto">
        <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
        {ordered.map((field) => (
          <DropdownMenuCheckboxItem
            key={field.name}
            checked={visible.has(field.name)}
            disabled={visible.size === 1 && visible.has(field.name)}
            onCheckedChange={(checked) => toggle(field.name, checked)}
            // Keep the menu open so several columns can be toggled in a row.
            onSelect={(e) => e.preventDefault()}
          >
            {field.label}
          </DropdownMenuCheckboxItem>
        ))}
        {columns && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange(null)}>Show all</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
