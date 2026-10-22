import type { Entity } from '@wardenhq/core';
import { Bookmark, Check, FileCode, Link2, RotateCcw, Save, Trash2, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ExportViewDialog } from '@/components/export-view-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { showsView, viewStateOf } from '@/lib/grid-state';
import {
  FROM_PARAM,
  fetchSharedViews,
  useIsViewsAdmin,
  useSavedViewMutations,
  useViewList,
  viewPath,
  type SavedView,
} from '@/lib/saved-views';
import { exportView, exportViews, type ConfigExport } from '@/lib/view-export';

interface SavedViewsMenuProps {
  entity: Entity;
  params: URLSearchParams;
  onApply: (view: SavedView) => void;
}

const ORIGIN_LABELS: Record<SavedView['origin'], string> = {
  config: 'Config',
  shared: 'Shared',
  personal: 'Personal',
};

function ViewRow({
  view,
  active,
  canShare,
  onApply,
  onUpdate,
  onShare,
  onDelete,
  onExport,
}: {
  view: SavedView;
  active: boolean;
  canShare: boolean;
  onApply: () => void;
  onUpdate: () => void;
  onShare: () => void;
  onDelete: () => void;
  onExport: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(new URL(viewPath(view), window.location.origin).href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const stale = view.state === null;
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
      {view.notInConfig ? (
        <Badge
          variant="outline"
          title="Shared views come from config. Nobody else sees this one: export it to config, then delete it."
        >
          Not in config
        </Badge>
      ) : (
        <Badge variant="secondary" title={`Origin: ${ORIGIN_LABELS[view.origin]}`}>
          {ORIGIN_LABELS[view.origin]}
        </Badge>
      )}
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
      {!stale && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Export ${view.name} to config`}
          title="Export to config"
          onClick={onExport}
        >
          <FileCode />
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
      {view.canDelete && (
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

function Section({ id, title, views }: { id: string; title: string; views: React.ReactNode[] }) {
  if (views.length === 0) return null;
  return (
    <section aria-labelledby={id} className="space-y-1">
      <h3 id={id} className="text-xs font-medium text-muted-foreground">
        {title}
      </h3>
      <ul aria-label={title}>{views}</ul>
    </section>
  );
}

/** Lists, applies, saves, shares and exports saved views of one entity's grid. */
export function SavedViewsMenu({ entity, params, onApply }: SavedViewsMenuProps) {
  const list = useViewList(entity.key);
  const { create, update, remove } = useSavedViewMutations(entity.key);
  const canShare = list.data?.canShare ?? false;
  const isAdmin = useIsViewsAdmin();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [exported, setExported] = useState<ConfigExport | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const views = list.data?.views;
  const isActive = (view: SavedView) =>
    view.state !== null && showsView(params, entity, view.state);
  const active = views?.find(isActive);
  // The config view the grid was opened from, when the grid no longer matches it.
  const from = views?.find((v) => v.origin === 'config' && v.id === params.get(FROM_PARAM));
  const modified = from?.state && !isActive(from) ? from : undefined;
  const configViews = views?.filter((v) => v.origin === 'config') ?? [];
  const mine = views?.filter((v) => v.origin === 'personal') ?? [];
  const sharedViews = views?.filter((v) => v.origin === 'shared') ?? [];
  const error = create.error ?? update.error ?? remove.error;
  const current = () => viewStateOf(params, entity);

  const showExport = (value: ConfigExport) => {
    setOpen(false);
    setExported(value);
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(
      { name: name.trim(), shared: canShare && shared, state: current() },
      {
        onSuccess: () => {
          setName('');
          setShared(false);
        },
      },
    );
  };

  const exportAll = async () => {
    setExportError(null);
    try {
      showExport(exportViews('every shared view', await fetchSharedViews()));
    } catch {
      setExportError("Couldn't load shared views.");
    }
  };

  const row = (view: SavedView) => (
    <ViewRow
      key={view.id}
      view={view}
      active={view === active}
      canShare={canShare}
      onApply={() => {
        if (view.state) onApply(view);
        setOpen(false);
      }}
      onUpdate={() => update.mutate({ id: view.id, changes: { state: current() } })}
      onShare={() => update.mutate({ id: view.id, changes: { shared: !view.shared } })}
      onDelete={() => remove.mutate(view.id)}
      onExport={() => view.state && showExport(exportView(entity.key, view, view.state))}
    />
  );

  return (
    <>
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
            {active ? (
              <span className="max-w-48 truncate">{active.name}</span>
            ) : modified ? (
              <span className="max-w-48 truncate">{modified.name} (modified)</span>
            ) : (
              'Views'
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[28rem] space-y-3">
          {list.isPending ? (
            <p className="text-sm text-muted-foreground">Loading views…</p>
          ) : list.isError ? (
            <p role="alert" className="text-sm text-destructive">
              Couldn't load saved views.
            </p>
          ) : (
            <>
              {modified && (
                <div
                  role="status"
                  className="flex items-center gap-2 rounded-md border border-dashed p-2 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{modified.name}</span>: Modified, not saved
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => showExport(exportView(entity.key, modified, current()))}
                  >
                    <FileCode />
                    Export to config
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onApply(modified);
                      setOpen(false);
                    }}
                  >
                    <RotateCcw />
                    Reset
                  </Button>
                </div>
              )}
              <Section id="config-views" title="From config" views={configViews.map(row)} />
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
              <Section id="shared-views" title="Shared views" views={sharedViews.map(row)} />
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

          <div className="flex flex-wrap gap-2 border-t pt-3">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                showExport(
                  exportView(
                    entity.key,
                    { name: name.trim() || `${entity.label} view` },
                    current(),
                  ),
                )
              }
            >
              <FileCode />
              Export current grid
            </Button>
            {isAdmin && sharedViews.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  showExport(exportViews(`shared views of ${entity.label}`, sharedViews))
                }
              >
                Export shared views
              </Button>
            )}
            {isAdmin && (
              <Button size="sm" variant="ghost" onClick={exportAll}>
                Export all tables
              </Button>
            )}
            {exportError && (
              <p role="alert" className="text-sm text-destructive">
                {exportError}
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <ExportViewDialog value={exported} onClose={() => setExported(null)} />
    </>
  );
}
