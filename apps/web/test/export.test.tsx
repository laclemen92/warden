import type { Action, EffectiveSchema } from '@wardenhq/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createApp } from '../src/App';
import { exportUrl } from '../src/lib/export';
import { readGridState } from '../src/lib/grid-state';
import { routes } from '../src/routes';
import { orders } from './fixtures';

const schema: EffectiveSchema = { entities: [orders] };
const rows = {
  items: [{ id: '1', values: { id: '1', status: 'paid' } }],
  nextCursor: null,
  hasMore: false,
  total: 1,
};

let actions: Action[];
let exportResponse: () => Response;
let exportRequests: URL[];

beforeEach(() => {
  actions = ['read', 'export'];
  exportRequests = [];
  exportResponse = () =>
    new Response('﻿id\r\n1\r\n', {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="orders-2026-10-20T00-00-00.csv"',
      },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://warden.test');
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      if (url.pathname === '/api/schema') return json(schema);
      if (url.pathname === '/api/me') return json({ name: 'Ada' });
      if (url.pathname === '/api/capabilities') return json({ entities: { orders: { actions } } });
      if (url.pathname === '/api/views') return json({ views: [] });
      if (url.pathname.startsWith('/api/entities/')) return json(rows);
      if (url.pathname.startsWith('/api/export/')) {
        exportRequests.push(url);
        return exportResponse();
      }
      return json({ message: 'Not Found' }, 404);
    }),
  );
});

function renderAt(path: string) {
  const { router, queryClient } = createApp(() =>
    createMemoryRouter(routes, { initialEntries: [path] }),
  );
  render(<App router={router} queryClient={queryClient} />);
}

const loaded = async () => {
  const table = await screen.findByRole('table', { name: 'Orders' });
  await within(table).findByRole('link', { name: '1' });
};

describe('exportUrl', () => {
  it('sends the grid filter, search, sort, and columns, but not paging', () => {
    const params = new URLSearchParams(
      'filter=%7B%7D&q=%20gift%20&sort=-total&columns=total,id&page=3&pageSize=25',
    );
    const url = new URL(
      exportUrl(orders, readGridState(params, orders), params.get('sort')),
      'http://x',
    );
    expect(url.pathname).toBe('/api/export/orders');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      filter: '{}',
      q: 'gift',
      sort: '-total',
      columns: 'id,total',
    });
  });

  it('leaves the default sort to the server and encodes the entity key', () => {
    expect(
      exportUrl({ ...orders, key: 'a/b' }, readGridState(new URLSearchParams(), orders), null),
    ).toBe('/api/export/a%2Fb');
  });
});

describe('export button', () => {
  it('is only offered to users who may export', async () => {
    actions = ['read'];
    renderAt('/entities/orders');
    await loaded();
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
  });

  it('downloads the current grid as CSV', async () => {
    // jsdom has no object URLs.
    const { createObjectURL, revokeObjectURL } = URL;
    URL.createObjectURL = () => 'blob:export';
    URL.revokeObjectURL = () => {};
    const clicked: HTMLAnchorElement[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    try {
      renderAt('/entities/orders?q=gift&columns=id,status');
      await loaded();
      await userEvent.click(await screen.findByRole('button', { name: 'Export CSV' }));
      await waitFor(() => expect(clicked).toHaveLength(1));
      expect(Object.fromEntries(exportRequests[0]!.searchParams)).toEqual({
        q: 'gift',
        columns: 'id,status',
      });
      expect(clicked[0]!.download).toBe('orders-2026-10-20T00-00-00.csv');
      expect(clicked[0]!.href).toBe('blob:export');
    } finally {
      click.mockRestore();
      Object.assign(URL, { createObjectURL, revokeObjectURL });
    }
  });

  it("shows the server's reason when an export is refused", async () => {
    exportResponse = () =>
      new Response(JSON.stringify({ message: 'exports are limited to 100,000 rows' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    renderAt('/entities/orders');
    await loaded();
    await userEvent.click(await screen.findByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'exports are limited to 100,000 rows',
    );
  });
});
