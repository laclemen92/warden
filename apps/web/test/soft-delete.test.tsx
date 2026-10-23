import type { EffectiveSchema, Entity, Field } from '@wardenhq/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createApp } from '../src/App';
import { exportUrl } from '../src/lib/export';
import { readGridState } from '../src/lib/grid-state';
import { routes } from '../src/routes';

const field = (name: string, label: string, dataType = 'text'): Field => ({
  name,
  label,
  dataType,
  formattedType: dataType,
  isArray: false,
  nullable: true,
  hasDefault: false,
  readOnly: false,
});

const certificates: Entity = {
  key: 'certificates',
  schema: 'public',
  name: 'certificates',
  kind: 'table',
  label: 'Certificates',
  primaryKey: ['id'],
  displayField: 'name',
  searchable: [],
  softDelete: { column: 'deleted_at', kind: 'timestamp', by: 'deleted_by' },
  requireReason: ['update', 'delete'],
  reasonMinLength: 3,
  fields: [
    field('id', 'ID', 'int4'),
    field('name', 'Name'),
    field('deleted_at', 'Deleted at', 'timestamptz'),
    field('deleted_by', 'Deleted by', 'int8'),
  ],
  relations: [],
};
const schema: EffectiveSchema = { entities: [certificates] };

const item = (id: number, name: string, deletedAt: string | null = null) => ({
  id: String(id),
  version: `v${id}`,
  values: {
    id,
    name,
    deleted_at: deletedAt,
    deleted_by: deletedAt ? '7' : null,
  },
});
const live = item(1, 'Live cert');
const gone = item(2, 'Gone cert', '2026-01-02 03:04:05+00');

type Response_ = { status: number; body?: unknown };
let requests: { url: URL; init: RequestInit | undefined }[];
let actions: string[];
let restoreResponse: Response_;

beforeEach(() => {
  requests = [];
  actions = ['read', 'update', 'delete'];
  restoreResponse = {
    status: 200,
    body: { ...gone, values: { ...gone.values, deleted_at: null } },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://warden.test');
      requests.push({ url, init });
      let res: Response_ = { status: 404, body: { message: 'Not Found' } };
      if (url.pathname === '/api/schema') res = { status: 200, body: schema };
      else if (url.pathname === '/api/capabilities') {
        res = { status: 200, body: { entities: { certificates: { actions, customActions: [] } } } };
      } else if (url.pathname === '/api/entities/certificates') {
        const items = url.searchParams.get('deleted') === 'include' ? [live, gone] : [live];
        res = {
          status: 200,
          body: { items, nextCursor: null, hasMore: false, total: items.length },
        };
      } else if (url.pathname === '/api/entities/certificates/2') {
        res = { status: 200, body: gone };
      } else if (url.pathname === '/api/entities/certificates/1') {
        res = init?.method === 'DELETE' ? { status: 204 } : { status: 200, body: live };
      } else if (url.pathname === '/api/entities/certificates/2/restore') {
        res = restoreResponse;
      } else if (url.pathname.endsWith('/history')) {
        res = { status: 200, body: { items: [], nextCursor: null } };
      }
      return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

function renderAt(path: string) {
  const { router, queryClient } = createApp(() =>
    createMemoryRouter(routes, { initialEntries: [path] }),
  );
  render(<App router={router} queryClient={queryClient} />);
  return router;
}

const listRequests = () =>
  requests.filter(({ url }) => url.pathname === '/api/entities/certificates');

describe('grid of a soft-deleting entity', () => {
  it('hides deleted rows until "Show deleted" is on, then marks them', async () => {
    const router = renderAt('/entities/certificates');
    const table = await screen.findByRole('table', { name: 'Certificates' });
    await within(table).findByText('Live cert');
    expect(within(table).queryByText('Gone cert')).not.toBeInTheDocument();
    expect(listRequests().at(-1)?.url.searchParams.has('deleted')).toBe(false);

    await userEvent.click(screen.getByRole('checkbox', { name: 'Show deleted' }));
    await within(table).findByText('Gone cert');
    expect(listRequests().at(-1)?.url.searchParams.get('deleted')).toBe('include');
    expect(router.state.location.search).toContain('deleted=include');
    const rows = within(table).getAllByRole('row');
    const goneRow = rows.find((r) => within(r).queryByText('Gone cert'))!;
    const liveRow = rows.find((r) => within(r).queryByText('Live cert'))!;
    expect(within(goneRow).getByText('Deleted')).toBeInTheDocument();
    expect(within(liveRow).queryByText('Deleted')).not.toBeInTheDocument();
  });

  it('reads "Show deleted" from the URL, and carries it into exports', async () => {
    renderAt('/entities/certificates?deleted=include');
    await screen.findByText('Gone cert');
    expect(listRequests().at(-1)?.url.searchParams.get('deleted')).toBe('include');
    expect(screen.getByRole('checkbox', { name: 'Show deleted' })).toBeChecked();
    const state = readGridState(new URLSearchParams('deleted=include'), certificates);
    expect(
      new URL(exportUrl(certificates, state, null), 'http://x').searchParams.get('deleted'),
    ).toBe('include');
    // Ignored for entities that don't soft-delete.
    const plain: Entity = { ...certificates };
    delete plain.softDelete;
    expect(
      readGridState(new URLSearchParams('deleted=include'), plain).showDeleted,
    ).toBeUndefined();
  });
});

describe('record page of a soft-deleting entity', () => {
  it('marks a deleted record and offers Restore instead of Delete', async () => {
    renderAt('/entities/certificates/2');
    const heading = await screen.findByRole('heading', { name: /Gone cert/ });
    expect(within(heading).getByText('Deleted')).toBeInTheDocument();
    await screen.findByRole('button', { name: 'Restore' });
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('restores with a reason, sending the version shown', async () => {
    renderAt('/entities/certificates/2');
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Restore Gone cert?' });
    const confirm = within(dialog).getByRole('button', { name: 'Restore' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'issued by mistake');
    await userEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    const restore = requests.find(({ url }) => url.pathname.endsWith('/restore'));
    expect(restore?.init?.method).toBe('POST');
    expect(JSON.parse(String(restore?.init?.body))).toEqual({
      version: 'v2',
      reason: 'issued by mistake',
    });
  });

  it('shows why a restore failed', async () => {
    restoreResponse = { status: 403, body: { message: 'Forbidden' } };
    renderAt('/entities/certificates/2');
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'issued by mistake');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "You don't have permission to restore this record.",
    );
  });

  it('hides Restore from users who may not update', async () => {
    actions = ['read', 'delete'];
    renderAt('/entities/certificates/2');
    await screen.findByRole('heading', { name: /Gone cert/ });
    await waitFor(() =>
      expect(requests.some(({ url }) => url.pathname === '/api/capabilities')).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
  });

  it('says a delete can be undone', async () => {
    renderAt('/entities/certificates/1');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Live cert?' });
    expect(dialog).toHaveTextContent('This marks the record as deleted');
    expect(dialog).toHaveTextContent('can be restored');
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
  });
});
