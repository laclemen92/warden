import type { Entity, ViewState } from '@wardenhq/core';
import { Bookmark, Check, Link2, Save, Trash2, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { showsView, viewStateOf } from '@/lib/grid-state';
import {
  useCanShareViews,
  useSavedViewMutations,
  useSavedViews,
  viewPath,
  type SavedView,
} from '@/lib/saved-views';

interface SavedViewsMenuProps {
  entity: Entity;
  params: URLSearchParams;
  onApply: (state: ViewState) => void;
}

function ViewRow({
  view,
  active,
  canShare,
  onApply,
  onUpdate,
  onShare,
  onDelete,
}: {
  view: SavedView;
  active: boolean;
  canShare: boolean;
  onApply: () => void;
  onUpdate: () => void;
  onShare: () => void;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(new URL(viewPath(view), window.location.origin).href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const stale = view.state === null;
  // Owners can always delete; the server says whether they can still change it.
  const canDelete = view.canEdit || view.mine;

  return (
    <li className="group flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="min-w-0 flex-1 justify-start"
        disabled={stale}
        aria-current={active ? 'true' : undefined}
        onClick={onApply}
      >
        <Check className={active ? '' : 'invisible'} />
        <span className="truncate">{view.name}</span>
        {stale && (
          <Badge variant="outline" title="Uses a column you can't see. Update or delete it.">
            Out of date
          </Badge>
        )}
        {view.shared && !view.mine && view.owner && (
          <span className="truncate text-xs text-muted-foreground">{view.owner}</span>
        )}
      </Button>
      {!stale && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={copied ? `Copied link to ${view.name}` : `Copy link to ${view.name}`}
          title="Copy link"
          onClick={copy}
        >
          {copied ? <Check /> : <Link2 />}
        </Button>
      )}
      {view.canEdit && !active && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Update ${view.name} to the current grid`}
          title="Update to the current grid"
          onClick={onUpdate}
        >
          <Save />
        </Button>
      )}
      {view.canEdit && canShare && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={view.shared ? `Stop sharing ${view.name}` : `Share ${view.name}`}
          aria-pressed={view.shared}
          title={view.shared ? 'Stop sharing' : 'Share with everyone'}
          onClick={onShare}
        >
          <Users className={view.shared ? 'text-foreground' : undefined} />
        </Button>
      )}
      {canDelete && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Delete ${view.name}`}
          title="Delete"
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      )}
    </li>
  );
}

/** Lists, applies, saves, and shares saved views of one entity's grid. */
export function SavedViewsMenu({ entity, params, onApply }: SavedViewsMenuProps) {
  const views = useSavedViews(entity.key);
  const { create, update, remove } = useSavedViewMutations(entity.key);
  const canShare = useCanShareViews();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);

  const isActive = (view: SavedView) =>
    view.state !== null && showsView(params, entity, view.state);
  const active = views.data?.find(isActive);
  const mine = views.data?.filter((v) => v.mine && !v.shared) ?? [];
  const sharedViews = views.data?.filter((v) => v.shared) ?? [];
  const error = create.error ?? update.error ?? remove.error;

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(
      { name: name.trim(), shared: canShare && shared, state: viewStateOf(params, entity) },
      {
        onSuccess: () => {
          setName('');
          setShared(false);
        },
      },
    );
  };

  const row = (view: SavedView) => (
    <ViewRow
      key={view.id}
      view={view}
      active={view === active}
      canShare={canShare}
      onApply={() => {
        if (view.state) onApply(view.state);
        setOpen(false);
      }}
      onUpdate={() =>
        update.mutate({ id: view.id, changes: { state: viewStateOf(params, entity) } })
      }
      onShare={() => update.mutate({ id: view.id, changes: { shared: !view.shared } })}
      onDelete={() => remove.mutate(view.id)}
    />
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) [create, update, remove].forEach((m) => m.reset());
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          {...(active ? { 'aria-label': `View: ${active.name}` } : {})}
        >
          <Bookmark />
          {active ? <span className="max-w-48 truncate">{active.name}</span> : 'Views'}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 space-y-3">
        {views.isPending ? (
          <p className="text-sm text-muted-foreground">Loading views…</p>
        ) : views.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Couldn't load saved views.
          </p>
        ) : (
          <>
            <section aria-labelledby="my-views" className="space-y-1">
              <h3 id="my-views" className="text-xs font-medium text-muted-foreground">
                My views
              </h3>
              {mine.length > 0 ? (
                <ul aria-label="My views">{mine.map(row)}</ul>
              ) : (
                <p className="text-sm text-muted-foreground">No saved views yet.</p>
              )}
            </section>
            {sharedViews.length > 0 && (
              <section aria-labelledby="shared-views" className="space-y-1">
                <h3 id="shared-views" className="text-xs font-medium text-muted-foreground">
                  Shared
                </h3>
                <ul aria-label="Shared views">{sharedViews.map(row)}</ul>
              </section>
            )}
          </>
        )}

        <form onSubmit={save} className="space-y-2 border-t pt-3">
          <label htmlFor="view-name" className="text-xs font-medium text-muted-foreground">
            Save the current filters, sort, and columns
          </label>
          <div className="flex gap-2">
            <Input
              id="view-name"
              placeholder="View name"
              className="h-8"
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>
              Save
            </Button>
          </div>
          {canShare && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={shared} onCheckedChange={(next) => setShared(next === true)} />
              Share with everyone
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error.message}
            </p>
          )}
        </form>
      </PopoverContent>
    </Popover>
  );
}
