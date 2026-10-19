import type { EffectiveSchema } from '@wardenhq/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createApp } from '../src/App';
import type { RecordList } from '../src/lib/records';
import { routes } from '../src/routes';
import { orders } from './fixtures';

const schema: EffectiveSchema = { entities: [orders] };

function page(ids: number[], total: number, hasMore = false): RecordList {
  return {
    items: ids.map((id) => ({
      id: String(id),
      values: {
        id: String(id),
        status: 'paid',
        total: '10.00',
        notes: id % 2 ? null : `note ${id}`,
        is_gift: false,
        placed_at: '2026-01-02 03:04:05+00',
        ship_by: '2026-01-05',
        metadata: { tag: 'a' },
      },
    })),
    nextCursor: null,
    hasMore,
    total,
  };
}

type Handler = (url: URL) => { status: number; body: unknown };
let rowsHandler: Handler;
let requests: URL[];

beforeEach(() => {
  requests = [];
  rowsHandler = () => ({ status: 200, body: page([1, 2], 2) });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://warden.test');
      let res: { status: number; body: unknown };
      if (url.pathname === '/api/schema') res = { status: 200, body: schema };
      else if (url.pathname === '/api/me') res = { status: 200, body: { name: 'Ada' } };
      else if (url.pathname.startsWith('/api/entities/')) {
        requests.push(url);
        res = rowsHandler(url);
      } else res = { status: 404, body: { message: 'Not Found' } };
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

const lastRequest = () => {
  const url = requests.at(-1);
  if (!url) throw new Error('no list request');
  return Object.fromEntries(url.searchParams);
};
const search = (router: ReturnType<typeof renderAt>) =>
  Object.fromEntries(new URLSearchParams(router.state.location.search));

async function grid() {
  const table = await screen.findByRole('table', { name: 'Orders' });
  await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(2));
  await waitFor(() => expect(within(table).queryByText('note 2')).toBeInTheDocument());
  return table;
}

/** Pick an option from a Radix select. */
async function choose(trigger: HTMLElement, option: string) {
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

describe('entity grid', () => {
  it('loads the first page with the default sort and a total', async () => {
    renderAt('/entities/orders');
    const table = await grid();
    expect(lastRequest()).toEqual({ sort: '-placed_at', limit: '50', count: 'true' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Id', 'Status', 'Total', 'Notes', 'Gift', 'Placed at', 'Ship by', 'Metadata']);
    expect(within(table).getByRole('columnheader', { name: /Placed at/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(within(table).getAllByText('null')).toHaveLength(1);
    expect(within(table).getAllByText('{"tag":"a"}')).toHaveLength(2);
    expect(screen.getByText('1–2 of 2')).toBeInTheDocument();
  });

  it('links each row to its record through the display field', async () => {
    renderAt('/entities/orders');
    const table = await grid();
    expect(within(table).getByRole('link', { name: '2' })).toHaveAttribute(
      'href',
      '/entities/orders/2',
    );
    expect(within(table).getAllByRole('link')).toHaveLength(2);
  });

  it('sorts on the server and keeps the sort in the URL', async () => {
    const router = renderAt('/entities/orders?page=3');
    const table = await grid();

    await userEvent.click(within(table).getByRole('button', { name: /^Total/ }));
    await waitFor(() => expect(search(router)).toEqual({ sort: 'total' }));
    await waitFor(() => expect(lastRequest().sort).toBe('total'));

    await userEvent.click(within(table).getByRole('button', { name: /^Total/ }));
    await waitFor(() => expect(lastRequest().sort).toBe('-total'));

    // Shift+click adds a secondary sort.
    const user = userEvent.setup();
    await user.keyboard('{Shift>}');
    await user.click(within(table).getByRole('button', { name: /^Id/ }));
    await user.keyboard('{/Shift}');
    await waitFor(() => expect(lastRequest().sort).toBe('-total,id'));
    expect(search(router).sort).toBe('-total,id');
  });

  it('does not offer sorting on json columns', async () => {
    renderAt('/entities/orders');
    const table = await grid();
    expect(within(table).queryByRole('button', { name: /Metadata/ })).toBeNull();
  });

  it('paginates with offsets and keeps the page in the URL', async () => {
    rowsHandler = (url) => {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return { status: 200, body: page([offset + 1, offset + 2], 120, offset + 50 < 120) };
    };
    const router = renderAt('/entities/orders?q=gift');
    await grid();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(search(router)).toEqual({ q: 'gift', page: '2' }));
    await waitFor(() => expect(lastRequest()).toMatchObject({ offset: '50', q: 'gift' }));
    expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(lastRequest().offset).toBe('100'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled());

    await choose(screen.getByRole('combobox', { name: 'Rows per page' }), '100');
    await waitFor(() => expect(search(router)).toEqual({ q: 'gift', pageSize: '100' }));
    await waitFor(() => expect(lastRequest()).toMatchObject({ limit: '100' }));
    expect(lastRequest().offset).toBeUndefined();
  });

  it('builds an enum filter and sends it to the server', async () => {
    const router = renderAt('/entities/orders?page=2');
    await grid();

    await userEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const form = await screen.findByRole('form', { name: 'Filters' });
    await choose(within(form).getByRole('combobox', { name: 'Field' }), 'Status');
    await choose(within(form).getByRole('combobox', { name: 'Status value' }), 'shipped');
    await userEvent.click(within(form).getByRole('button', { name: 'Apply' }));

    const expected = { field: 'status', op: 'eq', value: 'shipped' };
    await waitFor(() => expect(search(router)).toEqual({ filter: JSON.stringify(expected) }));
    await waitFor(() => expect(JSON.parse(lastRequest().filter ?? '')).toEqual(expected));

    const chips = screen.getByRole('list', { name: 'Active filters' });
    expect(within(chips).getByText('Status is shipped')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Filter\s*1/ })).toBeInTheDocument();

    await userEvent.click(
      within(chips).getByRole('button', { name: 'Remove filter: Status is shipped' }),
    );
    await waitFor(() => expect(search(router)).toEqual({}));
    await waitFor(() => expect(lastRequest().filter).toBeUndefined());
  });

  it('builds a date range and a boolean condition together', async () => {
    const router = renderAt('/entities/orders');
    await grid();

    await userEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const form = await screen.findByRole('form', { name: 'Filters' });
    await choose(within(form).getByRole('combobox', { name: 'Field' }), 'Ship by');
    expect(within(form).getByRole('combobox', { name: 'Operator' })).toHaveTextContent('between');
    const from = within(form).getByLabelText('Ship by from');
    expect(from).toHaveAttribute('type', 'date');
    await userEvent.type(from, '2026-01-01');
    await userEvent.type(within(form).getByLabelText('Ship by to'), '2026-01-31');

    await userEvent.click(within(form).getByRole('button', { name: 'Add condition' }));
    const fields = within(form).getAllByRole('combobox', { name: 'Field' });
    await choose(fields[1]!, 'Gift');
    await choose(within(form).getByRole('combobox', { name: 'Gift value' }), 'true');
    await userEvent.click(within(form).getByRole('button', { name: 'Apply' }));

    const expected = {
      and: [
        { field: 'ship_by', op: 'between', value: ['2026-01-01', '2026-01-31'] },
        { field: 'is_gift', op: 'eq', value: true },
      ],
    };
    await waitFor(() => expect(JSON.parse(search(router).filter ?? '')).toEqual(expected));
    await waitFor(() => expect(JSON.parse(lastRequest().filter ?? '')).toEqual(expected));
  });

  it('multi-selects enum values for "is any of"', async () => {
    const router = renderAt('/entities/orders');
    await grid();
    await userEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const form = await screen.findByRole('form', { name: 'Filters' });
    await choose(within(form).getByRole('combobox', { name: 'Field' }), 'Status');
    await choose(within(form).getByRole('combobox', { name: 'Operator' }), 'is any of');
    const values = within(form).getByRole('group', { name: 'Status value' });
    await userEvent.click(within(values).getByRole('checkbox', { name: 'pending' }));
    await userEvent.click(within(values).getByRole('checkbox', { name: 'shipped' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(JSON.parse(search(router).filter ?? '')).toEqual({
        field: 'status',
        op: 'in',
        value: ['pending', 'shipped'],
      }),
    );
  });

  it('shows invalid values instead of applying them', async () => {
    const router = renderAt('/entities/orders');
    await grid();
    await userEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const form = await screen.findByRole('form', { name: 'Filters' });
    await choose(within(form).getByRole('combobox', { name: 'Field' }), 'Total');
    await userEvent.type(within(form).getByLabelText('Total value'), 'ten');
    await userEvent.click(within(form).getByRole('button', { name: 'Apply' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Total: expected a number');
    expect(search(router)).toEqual({});
  });

  it('restores filters from the URL into the request and the builder', async () => {
    const filter = {
      and: [
        { field: 'status', op: 'in', value: ['paid'] },
        { field: 'total', op: 'gt', value: '5' },
      ],
    };
    renderAt(`/entities/orders?filter=${encodeURIComponent(JSON.stringify(filter))}&sort=id`);
    await grid();
    expect(JSON.parse(lastRequest().filter ?? '')).toEqual(filter);
    expect(lastRequest().sort).toBe('id');

    const chips = screen.getByRole('list', { name: 'Active filters' });
    expect(
      within(chips)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Status is any of paid', 'Total greater than 5']);
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    const form = await screen.findByRole('form', { name: 'Filters' });
    expect(within(form).getAllByRole('combobox', { name: 'Field' })).toHaveLength(2);
    expect(within(form).getByLabelText('Total value')).toHaveValue('5');
  });

  it('searches after typing stops', async () => {
    const router = renderAt('/entities/orders');
    await grid();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), 'wrap');
    await waitFor(() => expect(search(router)).toEqual({ q: 'wrap' }));
    await waitFor(() => expect(lastRequest().q).toBe('wrap'));
    expect(requests.filter((r) => r.searchParams.has('q'))).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(search(router)).toEqual({}));
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('');
  });

  it('shows the server error for a filter it rejects', async () => {
    rowsHandler = () => ({ status: 400, body: { message: 'invalid filter' } });
    renderAt(
      `/entities/orders?filter=${encodeURIComponent('{"or":[{"field":"x","op":"isNull"}]}')}`,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid filter');
    expect(screen.getByText('Custom filter')).toBeInTheDocument();
  });
});
