import type { Entity } from '@wardenhq/core';
import { ApiError } from './api';
import type { GridState } from './grid-state';

/**
 * The export endpoint URL for a grid: the same filter, search, and sort as its list request,
 * and its visible columns, over every matching row. Sort is left out when it is the entity's
 * default, which the server applies anyway.
 */
export function exportUrl(entity: Entity, state: GridState, explicitSort: string | null): string {
  const params = new URLSearchParams();
  if (state.filter) params.set('filter', state.filter);
  if (state.q.trim()) params.set('q', state.q.trim());
  if (explicitSort?.trim()) params.set('sort', explicitSort.trim());
  if (state.columns) params.set('columns', state.columns.join(','));
  const query = params.toString();
  return `/api/export/${encodeURIComponent(entity.key)}${query ? `?${query}` : ''}`;
}

const FILENAME = /filename="([^"]+)"/;

/** Fetch an export and hand it to the browser as a download. Throws an ApiError on failure. */
export async function downloadExport(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof body?.message === 'string' ? body.message : res.statusText;
    throw new ApiError(res.status, message || `Export failed (${res.status})`);
  }
  const name = FILENAME.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const href = URL.createObjectURL(await res.blob());
  try {
    const link = document.createElement('a');
    link.href = href;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // After the click has started the download.
    setTimeout(() => URL.revokeObjectURL(href), 0);
  }
}
