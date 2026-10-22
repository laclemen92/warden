import type { EffectiveSchema } from '@wardenhq/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createApp } from '../src/App';
import type { SavedView } from '../src/lib/saved-views';
import { routes } from '../src/routes';
import { orders } from './fixtures';

const schema: EffectiveSchema = { entities: [orders] };
const rows = {
  items: [{ id: '1', values: { id: '1', status: 'paid', notes: 'first' } }],
  nextCursor: null,
  hasMore: false,
  total: 1,
};

const savedView = (view: Partial<SavedView> & Pick<SavedView, 'id' | 'name'>): SavedView => ({
  entity: 'orders',
  origin: view.shared ? 'shared' : 'personal',
  shared: false,
  mine: true,
  owner: 'Ada',
  canEdit: true,
  state: {},
  updatedAt: '2026-01-01 00:00:00+00',
  ...view,
});

let views: SavedView[];
let admin: string[];
let canShareOverride: boolean | undefined;
let rowRequests: URL[];
let writes: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  views = [];
  admin = [];
  canShareOverride = undefined;
  rowRequests = [];
  writes = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://warden.test');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      let res: { status: number; body?: unknown } = { status: 404, body: { message: 'Not Found' } };
      const viewId = /^\/api\/views\/(\d+|config%3A[a-z-]+)$/.exec(url.pathname)?.[1];
      if (url.pathname === '/api/schema') res = { status: 200, body: schema };
      else if (url.pathname === '/api/views/sidebar') {
        res = { status: 200, body: { views: views.filter((v) => v.sidebar) } };
      } else if (url.pathname === '/api/views/shared') {
        res = { status: 200, body: { views: views.filter((v) => v.origin === 'shared') } };
      } else if (url.pathname === '/api/me') res = { status: 200, body: { name: 'Ada', admin } };
      else if (url.pathname.startsWith('/api/entities/')) {
        rowRequests.push(url);
        res = { status: 200, body: rows };
      } else if (url.pathname === '/api/views' && method === 'GET') {
        res = {
          status: 200,
          body: { views, canShare: canShareOverride ?? admin.includes('views') },
        };
      } else if (url.pathname === '/api/views' && method === 'POST') {
        writes.push({ method, path: url.pathname, body });
        const view = savedView({ id: String(views.length + 100), ...body });
        views.push(view);
        res = { status: 201, body: view };
      } else if (viewId) {
        const view = views.find((v) => v.id === decodeURIComponent(viewId));
        if (view && method === 'GET') res = { status: 200, body: view };
        if (view && method !== 'GET') {
          writes.push({ method, path: url.pathname, body });
          if (method === 'DELETE') views = views.filter((v) => v !== view);
          else Object.assign(view, body);
          res = method === 'DELETE' ? { status: 204 } : { status: 200, body: view };
        }
      }
      return new Response(res.status === 204 ? null : JSON.stringify(res.body), {
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

const search = (router: ReturnType<typeof renderAt>) =>
  Object.fromEntries(new URLSearchParams(router.state.location.search));

const headers = async () => {
  const table = await screen.findByRole('table', { name: 'Orders' });
  await within(table).findByRole('link', { name: '1' });
  return within(table)
    .getAllByRole('columnheader')
    .map((h) => h.textContent);
};

async function openViews() {
  await userEvent.click(await screen.findByRole('button', { name: /^(Views|View: .*)$/ }));
  return screen.findByRole('dialog');
}

// These tests click through menus, and the first also waits on a cold lazy-route import, which
// together can outlast the default 5s on CI runners.
const SLOW = { timeout: 15_000 };

describe('column picker', SLOW, () => {
  it('hides columns through the URL and keeps the page', async () => {
    const router = renderAt('/entities/orders?page=2');
    expect(await headers()).toHaveLength(orders.fields.length);

    await userEvent.click(screen.getByRole('button', { name: /Columns/ }));
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Notes' }));
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Metadata' }));
    expect(search(router)).toEqual({
      page: '2',
      columns: 'id,status,total,is_gift,placed_at,ship_by',
    });
    await userEvent.keyboard('{Escape}');
    expect(await headers()).not.toContain('Notes');

    await userEvent.click(screen.getByRole('button', { name: /Columns/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Show all' }));
    expect(search(router)).toEqual({ page: '2' });
  });

  it('opens with the columns from the URL', async () => {
    renderAt('/entities/orders?columns=status,id');
    expect(await headers()).toEqual(['Id', 'Status']);
  });
});

describe('saved views', SLOW, () => {
  it('saves the current filters, sort, and columns as a private view', async () => {
    const filter = { field: 'status', op: 'eq', value: 'paid' };
    renderAt(
      `/entities/orders?sort=-total&q=gift&columns=id,total&page=3&filter=${encodeURIComponent(
        JSON.stringify(filter),
      )}`,
    );
    await headers();
    const dialog = await openViews();
    expect(within(dialog).getByText('No saved views yet.')).toBeInTheDocument();
    // Sharing needs admin: [views].
    expect(within(dialog).queryByText('Share with everyone')).not.toBeInTheDocument();

    await userEvent.type(within(dialog).getByPlaceholderText('View name'), 'Big gifts');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'POST',
      path: '/api/views',
      body: {
        entity: 'orders',
        name: 'Big gifts',
        shared: false,
        state: { filter, q: 'gift', sort: '-total', columns: ['id', 'total'] },
      },
    });
    // The grid now shows that view, so the menu names it.
    expect(await screen.findByRole('button', { name: 'View: Big gifts' })).toBeInTheDocument();
  });

  it('applies a view in place of the current state, keeping the page size', async () => {
    views = [
      savedView({ id: '1', name: 'Paid', state: { sort: 'id', columns: ['id', 'status'] } }),
    ];
    const router = renderAt('/entities/orders?q=old&page=4&pageSize=25');
    await headers();
    const dialog = await openViews();
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Paid' }));
    expect(search(router)).toEqual({ sort: 'id', columns: 'id,status', pageSize: '25' });
    expect(await headers()).toEqual(['Id', 'Status']);
    expect(Object.fromEntries(rowRequests.at(-1)!.searchParams)).toMatchObject({ sort: 'id' });
  });

  it('opens a view link with the view applied, without loading the default first', async () => {
    views = [savedView({ id: '7', name: 'Linked', state: { sort: '-total', q: 'x' } })];
    const router = renderAt('/entities/orders?view=7');
    await waitFor(() => expect(search(router)).toEqual({ sort: '-total', q: 'x' }));
    await headers();
    expect(rowRequests.map((u) => u.searchParams.get('sort'))).toEqual(['-total']);
    expect(await screen.findByRole('button', { name: 'View: Linked' })).toBeInTheDocument();
  });

  it('explains a view link it cannot open', async () => {
    const router = renderAt('/entities/orders?view=99&sort=id');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "This saved view doesn't exist or isn't available to you.",
    );
    expect(search(router)).toEqual({ sort: 'id' });
    await headers();
  });

  it('copies a link to the view', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    views = [savedView({ id: '5', name: 'Mine' })];
    renderAt('/entities/orders');
    await headers();
    const dialog = await openViews();
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Copy link to Mine' }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/entities/orders?view=5`);
  });

  it('updates and deletes views the user may edit', async () => {
    views = [savedView({ id: '1', name: 'Old', state: { sort: 'id' } })];
    renderAt('/entities/orders?sort=-total');
    await headers();
    const dialog = await openViews();
    await userEvent.click(
      await within(dialog).findByRole('button', { name: 'Update Old to the current grid' }),
    );
    await waitFor(() =>
      expect(writes.at(-1)).toEqual({
        method: 'PATCH',
        path: '/api/views/1',
        body: { state: { sort: '-total' } },
      }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Old' }));
    await waitFor(() => expect(writes.at(-1)).toMatchObject({ method: 'DELETE' }));
    expect(await within(dialog).findByText('No saved views yet.')).toBeInTheDocument();
  });

  it('only offers sharing to users with admin: [views]', async () => {
    admin = ['views'];
    views = [
      savedView({ id: '1', name: 'Personal' }),
      savedView({ id: '2', name: 'Team', shared: true, mine: false, owner: 'Bob' }),
    ];
    renderAt('/entities/orders');
    await headers();
    const dialog = await openViews();
    const shared = await within(dialog).findByRole('list', { name: 'Shared views' });
    expect(within(shared).getByText('Bob')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Share Personal' }));
    await waitFor(() =>
      expect(writes.at(-1)).toEqual({
        method: 'PATCH',
        path: '/api/views/1',
        body: { shared: true },
      }),
    );

    await userEvent.type(within(dialog).getByPlaceholderText('View name'), 'Everyone');
    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes.at(-1)).toMatchObject({ body: { shared: true } }));
  });

  it("offers no changes to shared views the user can't edit", async () => {
    views = [
      savedView({ id: '2', name: 'Team', shared: true, mine: false, canEdit: false }),
      savedView({ id: '3', name: 'Broken', state: null }),
    ];
    renderAt('/entities/orders');
    await headers();
    const dialog = await openViews();
    const shared = await within(dialog).findByRole('list', { name: 'Shared views' });
    expect(
      within(shared)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([null, 'Copy link to Team', 'Export Team to config']);
    // An out-of-date view can't be applied, only updated or deleted.
    const mine = within(dialog).getByRole('list', { name: 'My views' });
    expect(within(mine).getByRole('button', { name: /^Broken/ })).toBeDisabled();
    expect(within(mine).getByText('Out of date')).toBeInTheDocument();
    expect(within(mine).getByRole('button', { name: 'Delete Broken' })).toBeEnabled();
  });
});

const configView = (view: Partial<SavedView> & Pick<SavedView, 'key' | 'name'>): SavedView =>
  savedView({
    id: `config:${view.key}`,
    origin: 'config',
    shared: true,
    mine: false,
    owner: null,
    canEdit: false,
    ...view,
  });

describe('config views', SLOW, () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  const paid = () =>
    configView({
      key: 'paid-orders',
      name: 'Paid orders',
      state: { filter: { field: 'status', op: 'eq', value: 'paid' }, sort: '-total' },
    });

  it('lists config views as read-only, with their origin', async () => {
    views = [paid(), savedView({ id: '1', name: 'Mine' })];
    renderAt('/entities/orders?sort=id');
    await headers();
    const dialog = await openViews();
    const config = await within(dialog).findByRole('list', { name: 'From config' });
    expect(within(config).getByText('Config')).toBeInTheDocument();
    expect(
      within(config)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([null, 'Copy link to Paid orders', 'Export Paid orders to config']);
    const mine = within(dialog).getByRole('list', { name: 'My views' });
    expect(within(mine).getByText('Personal')).toBeInTheDocument();

    await userEvent.click(within(config).getByRole('button', { name: 'Copy link to Paid orders' }));
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/entities/orders?view=config:paid-orders`,
    );
  });

  it('opens a config view link, then shows when the grid no longer matches it', async () => {
    views = [paid()];
    const router = renderAt('/entities/orders?view=config:paid-orders');
    await waitFor(() =>
      expect(search(router)).toMatchObject({ sort: '-total', from: 'config:paid-orders' }),
    );
    expect(await screen.findByRole('button', { name: 'View: Paid orders' })).toBeInTheDocument();

    await router.navigate(
      `/entities/orders?${new URLSearchParams({ ...search(router), sort: 'id' })}`,
    );
    await userEvent.click(await screen.findByRole('button', { name: /Paid orders \(modified\)/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      'Paid orders: Modified, not saved',
    );

    // Export keeps the key, so the snippet replaces the config entry.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Export to config' }));
    const exported = await screen.findByRole('alertdialog');
    const yaml = [
      '- key: paid-orders',
      '  name: Paid orders',
      '  filter: { field: status, op: eq, value: paid }',
      '  sort:',
      '    - { column: id, direction: asc }',
      '',
    ].join('\n');
    expect(within(exported).getByLabelText('Config snippet').textContent).toBe(yaml);
    expect(exported).toHaveTextContent('Paste it under tables.orders.views');
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(yaml));
    await userEvent.click(within(exported).getByRole('button', { name: 'Done' }));

    await userEvent.click(screen.getByRole('button', { name: /Paid orders \(modified\)/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(search(router).sort).toBe('-total'));
    expect(await screen.findByRole('button', { name: 'View: Paid orders' })).toBeInTheDocument();
  });

  it('applies the default view when the table opens without other state', async () => {
    views = [{ ...paid(), default: true }];
    const router = renderAt('/entities/orders');
    await waitFor(() =>
      expect(search(router)).toEqual({
        sort: '-total',
        filter: JSON.stringify({ field: 'status', op: 'eq', value: 'paid' }),
        from: 'config:paid-orders',
      }),
    );
    await headers();
    // The unfiltered grid is never loaded first.
    expect(rowRequests.map((u) => u.searchParams.get('sort'))).toEqual(['-total']);

    // Clearing the grid afterwards doesn't bring the default back.
    await router.navigate('/entities/orders');
    await headers();
    expect(search(router)).toEqual({});
  });

  it("doesn't apply the default view over a grid's own state", async () => {
    views = [{ ...paid(), default: true }];
    const router = renderAt('/entities/orders?sort=id');
    await headers();
    expect(search(router)).toEqual({ sort: 'id' });
  });

  it('pins sidebar views', async () => {
    views = [{ ...paid(), sidebar: true }];
    const router = renderAt('/entities/orders?sort=id');
    await headers();
    const nav = await screen.findByRole('navigation', { name: 'Queues' });
    await userEvent.click(within(nav).getByRole('link', { name: 'Paid orders' }));
    await waitFor(() => expect(search(router)).toMatchObject({ from: 'config:paid-orders' }));
  });

  it('exports the current grid, and flags shared views missing from config', async () => {
    admin = ['views'];
    views = [
      savedView({
        id: '9',
        name: 'Legacy',
        shared: true,
        canEdit: false,
        notInConfig: true,
        state: { q: 'x' },
      }),
    ];
    // Shared views come from config here, so the server says sharing is off.
    canShareOverride = false;
    renderAt('/entities/orders?sort=-total&columns=id,total');
    await headers();
    const dialog = await openViews();
    const shared = await within(dialog).findByRole('list', { name: 'Shared views' });
    expect(within(shared).getByText('Not in config')).toBeInTheDocument();
    expect(within(dialog).queryByText('Share with everyone')).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Export current grid' }));
    const exported = await screen.findByRole('alertdialog');
    expect(within(exported).getByLabelText('Config snippet').textContent).toBe(
      [
        '- key: orders-view',
        '  name: Orders view',
        '  sort:',
        '    - { column: total, direction: desc }',
        '  columns: [id, total]',
        '',
      ].join('\n'),
    );
    await userEvent.click(within(exported).getByRole('button', { name: 'Done' }));

    await userEvent.click(await screen.findByRole('button', { name: 'Views' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Export all tables' }));
    const all = await screen.findByRole('alertdialog');
    expect(within(all).getByLabelText('Config snippet').textContent).toBe(
      [
        'tables:',
        '  orders:',
        '    views:',
        '      - key: legacy',
        '        name: Legacy',
        '        search: x',
        '',
      ].join('\n'),
    );
  });
});
