import {
  toExportedView,
  viewEntryYaml,
  viewKeyFor,
  viewsConfigYaml,
  type ViewState,
} from '@wardenhq/core';
import type { SavedView } from './saved-views';

/** A ready-to-paste config snippet, and where in the config file it goes. */
export interface ConfigExport {
  title: string;
  yaml: string;
  /** The config key to paste it under, or null for a top-level `tables:` section. */
  pasteUnder: string | null;
}

/**
 * One view as a `tables.<table>.views` entry. A config view keeps its key, so pasting the entry
 * over the old one updates it; any other view gets a key made from its name.
 */
export function exportView(
  entity: string,
  view: { name: string; key?: string | undefined },
  state: ViewState,
): ConfigExport {
  return {
    title: view.name,
    yaml: viewEntryYaml(toExportedView(view.key ?? viewKeyFor(view.name), view.name, state)),
    pasteUnder: `tables.${entity}.views`,
  };
}

/** Several tables' views as one `tables:` section, with keys unique across it. */
export function exportViews(title: string, views: SavedView[]): ConfigExport {
  const taken = new Set<string>();
  const byTable = new Map<string, ReturnType<typeof toExportedView>[]>();
  for (const view of views) {
    if (!view.state) continue;
    const key = view.key ?? viewKeyFor(view.name, taken);
    taken.add(key);
    const list = byTable.get(view.entity) ?? [];
    list.push(toExportedView(key, view.name, view.state));
    byTable.set(view.entity, list);
  }
  return {
    title,
    yaml: viewsConfigYaml([...byTable].map(([table, list]) => ({ table, views: list }))),
    pasteUnder: null,
  };
}
