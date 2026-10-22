import type { EffectiveSchema, Entity } from '@wardenhq/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createApp } from '../src/App';
import type { SavedView } from '../src/lib/saved-views';
import { routes } from '../src/routes';
import { orders } from './fixtures';

/** No configured default sort and no primary key, so no default sort at all. */
const events: Entity = {
  ...orders,
  key: 'events',
  name: 'events',
  label: 'Events',
  primaryKey: [],
};
delete events.defaultSort;
const schema: EffectiveSchema = { entities: [orders, events] };
const rows = {
  items: [{ id: '1', values: { id: '1', status: 'paid', total: '1.00', notes: 'first' } }],
  nextCursor: null,
  hasMore: false,
  total: 1,
};

let views: SavedView[];
let requests: URL[];

beforeEach(() => {
  views = [];
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://warden.test');
      let res: { status: number; body: unknown } = { status: 404, body: { message: 'Not Found' } };
      const viewId = /^\/api\/views\/(\d+)$/.exec(url.pathname)?.[1];
      if (url.pathname === '/api/schema') res = { status: 200, body: schema };
      else if (url.pathname === '/api/me') res = { status: 200, body: { name: 'Ada' } };
      else if (url.pathname.startsWith('/api/entities/')) {
        requests.push(url);
        res = { status: 200, body: rows };
      } else if (url.pathname === '/api/views') res = { status: 200, body: { views } };
      else if (viewId) {
        const view = views.find((v) => v.id === viewId);
        if (view) res = { status: 200, body: view };
      }
      return new Response(JSON.stringify(res.body), {
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
const lastSort = () => requests.at(-1)?.searchParams.get('sort') ?? null;

async function table(name = 'Orders') {
  const grid = await screen.findByRole('table', { name });
  await waitFor(() => expect(within(grid).queryByText('paid')).toBeInTheDocument());
  return grid;
}

async function openSort() {
  await userEvent.click(screen.getByRole('button', { name: /^Sort/ }));
  return screen.findByRole('dialog');
}

/** Pick a column from a sort column combobox by typing and pressing Enter. */
async function pick(trigger: HTMLElement, search: string) {
  await userEvent.click(trigger);
  const box = await screen.findByRole('searchbox', { name: 'Search columns' });
  await userEvent.type(box, `${search}{Enter}`);
}

const terms = (dialog: HTMLElement) =>
  within(within(dialog).getByRole('list', { name: 'Sort columns' }))
    .getAllByRole('combobox')
    .map((c) => c.textContent);

const SLOW = { timeout: 15_000 };

describe('sort menu', SLOW, () => {
  it('shows the default sort, and builds, reorders and clears a multi-column sort', async () => {
    const router = renderAt('/entities/orders?page=2');
    await table();
    expect(screen.getByRole('button', { name: /^Sort/ })).toHaveTextContent('Sort: Placed at ↓');

    let dialog = await openSort();
    expect(within(dialog).getByText('Default sort')).toBeInTheDocument();
    expect(terms(dialog)).toEqual(['Placed at']);
    expect(within(dialog).getByRole('button', { name: 'Remove Placed at sort' })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: 'Reset to default' })).toBeNull();

    // Replace the default with another column; changing sort goes back to page 1.
    await pick(within(dialog).getByRole('combobox', { name: 'Sort column 1: Placed at' }), 'tot');
    await waitFor(() => expect(search(router)).toEqual({ sort: '-total' }));
    await waitFor(() => expect(lastSort()).toBe('-total'));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Total: descending' }));
    await waitFor(() => expect(search(router).sort).toBe('total'));

    await pick(within(dialog).getByRole('combobox', { name: 'Add sort' }), 'stat');
    await pick(within(dialog).getByRole('combobox', { name: 'Add sort' }), 'gift');
    await waitFor(() => expect(search(router).sort).toBe('total,status,is_gift'));
    expect(terms(dialog)).toEqual(['Total', 'Status', 'Gift']);
    expect(screen.getByRole('button', { name: /^Sort/ })).toHaveTextContent('Sort: 3 columns');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Move Gift up' }));
    await waitFor(() => expect(search(router).sort).toBe('total,is_gift,status'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move Total down' }));
    await waitFor(() => expect(search(router).sort).toBe('is_gift,total,status'));
    expect(within(dialog).getByRole('button', { name: 'Move Gift up' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Move Status down' })).toBeDisabled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove Total sort' }));
    await waitFor(() => expect(search(router).sort).toBe('is_gift,status'));
    await waitFor(() => expect(lastSort()).toBe('is_gift,status'));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(search(router)).toEqual({}));
    await waitFor(() => expect(lastSort()).toBe('-placed_at'));
    dialog = screen.getByRole('dialog');
    expect(terms(dialog)).toEqual(['Placed at']);
  });

  it('only offers sortable columns not already in the sort, including hidden ones', async () => {
    const router = renderAt('/entities/orders?columns=id,status&sort=id');
    await table();
    const dialog = await openSort();
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Add sort' }));
    const list = await screen.findByRole('listbox', { name: 'Columns' });
    // Id is already sorted, and json columns can't be sorted.
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Status', 'Total', 'Notes', 'Gift', 'Placed at', 'Ship by']);

    await userEvent.type(screen.getByRole('searchbox', { name: 'Search columns' }), 'meta');
    expect(within(list).queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No matches.')).toBeInTheDocument();

    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search columns' }));
    await userEvent.click(within(list).getByRole('option', { name: 'Total' }));
    await waitFor(() => expect(search(router).sort).toBe('id,total'));
    // Hidden columns stay hidden.
    expect(search(router).columns).toBe('id,status');
  });

  it('stops adding at the server limit', async () => {
    renderAt('/entities/orders?sort=id,status,total,notes,is_gift');
    await table();
    const dialog = await openSort();
    expect(within(dialog).getByRole('combobox', { name: 'Add sort' })).toBeDisabled();
  });

  it('agrees with the column headers in both directions', async () => {
    const router = renderAt('/entities/orders');
    const grid = await table();

    await userEvent.click(within(grid).getByRole('button', { name: /^Total/ }));
    await waitFor(() => expect(search(router).sort).toBe('total'));
    expect(screen.getByRole('button', { name: /^Sort/ })).toHaveTextContent('Sort: Total ↑');

    const dialog = await openSort();
    expect(terms(dialog)).toEqual(['Total']);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Total: ascending' }));
    await waitFor(() => expect(search(router).sort).toBe('-total'));
    expect(within(grid).getByRole('columnheader', { name: /Total/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('works from the keyboard', async () => {
    const router = renderAt('/entities/orders?sort=id');
    await table();
    const user = userEvent.setup();

    screen.getByRole('button', { name: /^Sort/ }).focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');
    within(dialog).getByRole('combobox', { name: 'Add sort' }).focus();
    await user.keyboard('{Enter}');
    const box = await screen.findByRole('searchbox', { name: 'Search columns' });
    expect(box).toHaveFocus();
    // Status is first; arrow down to Total.
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(search(router).sort).toBe('id,total'));

    within(dialog).getByRole('button', { name: 'Total: ascending' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(search(router).sort).toBe('id,-total'));
  });

  it('shows the sort of a saved view link', async () => {
    views = [
      {
        id: '7',
        name: 'Linked',
        entity: 'orders',
        shared: false,
        mine: true,
        owner: 'Ada',
        canEdit: true,
        state: { sort: '-total,status' },
        updatedAt: '2026-01-01 00:00:00+00',
      },
    ];
    const router = renderAt('/entities/orders?view=7');
    await waitFor(() => expect(search(router)).toEqual({ sort: '-total,status' }));
    await table();
    expect(screen.getByRole('button', { name: /^Sort/ })).toHaveTextContent('Sort: 2 columns');
    const dialog = await openSort();
    expect(terms(dialog)).toEqual(['Total', 'Status']);
    expect(within(dialog).getByRole('button', { name: 'Total: descending' })).toBeInTheDocument();
  });

  it('starts empty on an entity without a default sort', async () => {
    const router = renderAt('/entities/events?sort=id');
    await table('Events');
    const dialog = await openSort();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear sort' }));
    await waitFor(() => expect(search(router)).toEqual({}));
    expect(screen.getByRole('button', { name: /^Sort/ })).toHaveTextContent(/^Sort$/);
    expect(within(dialog).getByText('No sort applied.')).toBeInTheDocument();
  });
});
