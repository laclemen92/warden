import type { SchemaDrift } from '@wardenhq/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createApp } from '../src/App';
import { routes } from '../src/routes';

const noDrift: SchemaDrift = {
  addedTables: [],
  removedTables: [],
  addedColumns: [],
  removedColumns: [],
  warnings: [],
  snippet: '',
};

const drift: SchemaDrift = {
  addedTables: [
    { table: 'invoices', exposed: true },
    { table: 'secrets', exposed: false },
  ],
  removedTables: [{ table: 'old_reports' }],
  addedColumns: [
    { table: 'users', column: 'ssn', type: 'character(9)', treatment: 'hidden' },
    { table: 'orders', column: 'total_cents', type: 'integer', treatment: 'readOnly' },
  ],
  removedColumns: [{ table: 'users', column: 'legacy' }],
  warnings: [{ path: 'tables.old_reports', message: 'table "public.old_reports" does not exist' }],
  snippet: 'tables:\n  invoices: { hidden: false }\n',
};

const baseline = { id: '1', takenAt: '2026-10-01 12:00:00+00', takenBy: null };

type Responses = Record<string, { status: number; body?: unknown }>;

function stubFetch(responses: Responses) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = responses[`${init?.method ?? 'GET'} ${String(input)}`] ?? {
      status: 404,
      body: { message: 'Not Found' },
    };
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderAt(path: string) {
  const { router, queryClient } = createApp(() =>
    createMemoryRouter(routes, { initialEntries: [path] }),
  );
  render(<App router={router} queryClient={queryClient} />);
  return router;
}

const base = (admin: string[]): Responses => ({
  'GET /api/schema': { status: 200, body: { entities: [] } },
  'GET /api/me': { status: 200, body: { name: 'Ada', roles: ['admin'], admin } },
});

describe('schema drift page', () => {
  it('links to the page from the sidebar for schema admins only', async () => {
    stubFetch(base(['schema']));
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Admin' });
    expect(within(nav).getByRole('link', { name: 'Schema drift' })).toHaveAttribute(
      'href',
      '/admin/schema-drift',
    );
  });

  it('hides the link from everyone else and shows not found', async () => {
    stubFetch(base([]));
    renderAt('/admin/schema-drift');
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('lists new, removed, and mismatched config with treatments', async () => {
    stubFetch({
      ...base(['schema']),
      'GET /api/admin/schema-drift': { status: 200, body: { baseline, drift } },
    });
    renderAt('/admin/schema-drift');

    const tables = await screen.findByRole('region', { name: 'New tables' });
    const rows = within(tables).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(['invoicesExposed', 'secretsNot exposed']);

    const columns = screen.getByRole('region', { name: 'New columns' });
    expect(
      within(columns)
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.textContent),
    ).toEqual(['usersssncharacter(9)Hidden', 'orderstotal_centsintegerRead-only']);

    const removed = screen.getByRole('region', { name: 'Removed' });
    expect(within(removed).getByText('old_reports')).toBeInTheDocument();
    expect(within(removed).getByText('users → legacy')).toBeInTheDocument();

    const mismatches = screen.getByRole('region', { name: 'Config mismatches' });
    expect(within(mismatches).getByText('tables.old_reports')).toBeInTheDocument();
  });

  it('copies the YAML snippet', async () => {
    const user = userEvent.setup();
    stubFetch({
      ...base(['schema']),
      'GET /api/admin/schema-drift': { status: 200, body: { baseline, drift } },
    });
    renderAt('/admin/schema-drift');

    const section = await screen.findByRole('region', { name: 'Resolve in config' });
    expect(section.querySelector('pre')?.textContent).toBe(drift.snippet);
    await user.click(within(section).getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe(drift.snippet);
    expect(within(section).getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('acknowledges the drift into a new baseline', async () => {
    const fetchMock = stubFetch({
      ...base(['schema']),
      'GET /api/admin/schema-drift': { status: 200, body: { baseline, drift } },
      'POST /api/admin/schema-drift/acknowledge': {
        status: 200,
        body: { baseline: { ...baseline, id: '2', takenBy: 'admin' }, drift: noDrift },
      },
    });
    renderAt('/admin/schema-drift');

    await userEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByText(/No drift/)).toBeInTheDocument();
    expect(screen.getByText(/acknowledged by admin/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeDisabled();

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ baselineId: '1' });
  });

  it('explains a conflicting acknowledgement', async () => {
    stubFetch({
      ...base(['schema']),
      'GET /api/admin/schema-drift': { status: 200, body: { baseline, drift } },
      'POST /api/admin/schema-drift/acknowledge': { status: 409, body: { message: 'conflict' } },
    });
    renderAt('/admin/schema-drift');

    await userEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Someone acknowledged first'),
    );
  });
});
