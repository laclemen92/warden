import { useState } from 'react';
import type { Entity } from '@wardenhq/core';
import { ChevronDown, MoreHorizontal, Zap } from 'lucide-react';
import { ActionDialog } from '@/components/action-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useEntityActions, type ActionDescriptor } from '@/lib/actions';

/** A menu of actions, each opening its dialog for `records`. */
function ActionsMenu({
  actions,
  records,
  trigger,
}: {
  actions: ActionDescriptor[];
  records: string[];
  trigger: React.ReactNode;
}) {
  const [active, setActive] = useState<ActionDescriptor | null>(null);
  if (actions.length === 0) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {actions.map((action) => (
            <DropdownMenuItem
              key={action.name}
              variant={action.destructive ? 'destructive' : 'default'}
              onSelect={() => setActive(action)}
            >
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {active && <ActionDialog action={active} records={records} onClose={() => setActive(null)} />}
    </>
  );
}

/** The detail page's actions on its record. Shown only when the user may run some. */
export function RecordActionsMenu({ entity, id }: { entity: Entity; id: string }) {
  const actions = useEntityActions(entity.key, 'one');
  return (
    <ActionsMenu
      actions={actions}
      records={[id]}
      trigger={
        <Button variant="outline">
          <Zap />
          Actions
          <ChevronDown />
        </Button>
      }
    />
  );
}

/** A grid row's actions. */
export function RowActionsMenu({
  actions,
  id,
  label,
}: {
  actions: ActionDescriptor[];
  id: string;
  /** Names the row for screen readers. */
  label: string;
}) {
  return (
    <ActionsMenu
      actions={actions}
      records={[id]}
      trigger={
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${label}`}>
          <MoreHorizontal />
        </Button>
      }
    />
  );
}

/** Actions on the entity as a whole, in the grid's toolbar. */
export function EntityActionsMenu({ entity }: { entity: Entity }) {
  const actions = useEntityActions(entity.key, 'none');
  return (
    <ActionsMenu
      actions={actions}
      records={[]}
      trigger={
        <Button variant="outline" size="sm">
          <Zap />
          Actions
          <ChevronDown />
        </Button>
      }
    />
  );
}

/** Shown while grid rows are selected: the actions that run against several records. */
export function BulkActionsBar({
  actions,
  selected,
  onClear,
}: {
  actions: ActionDescriptor[];
  selected: string[];
  onClear: () => void;
}) {
  const [active, setActive] = useState<ActionDescriptor | null>(null);
  if (selected.length === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label="Selected rows"
      className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
    >
      <span className="font-medium">{selected.length} selected</span>
      {actions.map((action) => (
        <Button
          key={action.name}
          size="sm"
          variant={action.destructive ? 'destructive' : 'outline'}
          onClick={() => setActive(action)}
        >
          {action.label}
        </Button>
      ))}
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}>
        Clear selection
      </Button>
      {active && (
        <ActionDialog action={active} records={selected} onClose={() => setActive(null)} />
      )}
    </div>
  );
}
