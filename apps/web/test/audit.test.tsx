import type { AuditEntry, EffectiveSchema, Entity, Field } from '@wardenhq/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createApp } from '../src/App';
import { auditSearchParams, filtersFromParams, filtersToParams } from '../src/lib/audit';
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

const users: Entity = {
  key: 'users',
  schema: 'public',
  name: 'users',
  kind: 'table',
  label: 'Users',
  primaryKey: ['id'],
  displayField: 'email',
  searchable: [],
  fields: [
    field('id', 'ID', 'int8'),
    field('email', 'Email'),
    field('is_active', 'Active', 'bool'),
  ],
  relations: [],
};
const companies: Entity = { ...users, key: 'companies', name: 'companies', label: 'Companies' };
const schema: EffectiveSchema = { entities: [users, companies] };

const entry = (id: string, extra: Partial<AuditEntry> = {}): AuditEntry => ({
  id,
  occurredAt: '2026-10-20T12:00:00.000000+00:00',
  requestId: 'req-1',
  actor: { subject: 'sub-ada', email: 'ada@example.com', roles: ['admin'] },
  action: 'update',
  entity: 'users',
  recordId: '42',
  reason: null,
  before: { id: '42', email: 'old@example.com', is_active: true },
  after: { id: '42', email: 'new@example.com', is_active: false },
  diff: {
    is_active: { from: true, to: false },
    email: { from: 'old@example.com', to: 'new@example.com' },
  },
  ...extra,
});

const created = entry('1', {
  action: 'create',
  reason: 'onboarding',
  before: null,
  after: { id: '42', email: 'old@example.com', is_active: true },
  diff: {
    id: { from: null, to: '42' },
    email: { from: null, to: 'old@example.com' },
    is_active: { from: null, to: true },
  },
});

type Handler = (url: URL) => { status: number; body?: unknown } | undefined;

function stubFetch(handler: Handler, admin: string[] = []) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://warden.test');
    const res = (url.pathname === '/api/schema'
      ? { status: 200, body: schema }
      : url.pathname === '/api/me'
        ? { status: 200, body: { name: 'Ada', admin } }
        : undefined) ??
      handler(url) ?? { status: 404, body: { message: 'Not Found' } };
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const calls = (fetchMock: ReturnType<typeof stubFetch>, path: string) =>
  fetchMock.mock.calls
    .map(([input]) => new URL(String(input), 'http://warden.test'))
    .filter((url) => url.pathname === path);

function renderAt(path: string) {
  const { router, queryClient } = createApp(() =>
    createMemoryRouter(routes, { initialEntries: [path] }),
  );
  render(<App router={router} queryClient={queryClient} />);
  return router;
}

const diffRows = (article: HTMLElement) =>
  within(article)
    .getAllByRole('row')
    .slice(1)
    .map((row) => [...row.querySelectorAll('th, td')].map((c) => c.textContent));

describe('audit filters', () => {
  it('round-trips through the URL and drops malformed dates', () => {
    const params = filtersToParams({
      actor: ' ada ',
      entity: 'users',
      action: '',
      from: '2026-10-01',
    });
    expect(params.toString()).toBe('actor=ada&entity=users&from=2026-10-01');
    expect(filtersFromParams(params)).toEqual({
      actor: 'ada',
      entity: 'users',
      from: '2026-10-01',
    });
    expect(filtersFromParams(new URLSearchParams('from=yesterday&to=2026-10-02'))).toEqual({
      to: '2026-10-02',
    });
  });

  it('sends local day bounds, with the end day included', () => {
    const params = auditSearchParams({ from: '2026-10-01', to: '2026-10-02' });
    expect(params.get('from')).toBe(new Date(2026, 9, 1).toISOString());
    expect(params.get('to')).toBe(new Date(2026, 9, 3).toISOString());
  });
});

describe('record history tab', () => {
  const record = {
    id: '42',
    version: 'v1',
    values: { id: '42', email: 'new@example.com', is_active: false },
  };

  it('lists the record’s changes with before and after values', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.pathname === '/api/entities/users/42') return { status: 200, body: record };
      if (url.pathname === '/api/entities/users/42/history') {
        return {
          status: 200,
          body: { items: [entry('2', { reason: 'fix typo' }), created], nextCursor: null },
        };
      }
    });
    renderAt('/entities/users/42');

    await userEvent.click(await screen.findByRole('tab', { name: 'History' }));
    const update = await screen.findByRole('article', { name: 'update 2' });
    expect(within(update).getByText('ada@example.com')).toHaveAttribute('title', 'sub-ada');
    expect(within(update).getByText('fix typo')).toBeInTheDocument();
    // In entity field order, not the diff's.
    expect(diffRows(update)).toEqual([
      ['Email', 'old@example.com', 'new@example.com'],
      ['Active', 'Yes', 'No'],
    ]);

    const create = screen.getByRole('article', { name: 'create 1' });
    expect(diffRows(create)).toEqual([
      ['ID', '', '42'],
      ['Email', '', 'old@example.com'],
      ['Active', '', 'Yes'],
    ]);
    expect(within(create).getByText('onboarding')).toBeInTheDocument();
    expect(calls(fetchMock, '/api/entities/users/42/history')).toHaveLength(1);
  });

  it('loads older entries on demand', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.pathname === '/api/entities/users/42') return { status: 200, body: record };
      if (url.pathname === '/api/entities/users/42/history') {
        return url.searchParams.get('cursor') === '2'
          ? { status: 200, body: { items: [created], nextCursor: null } }
          : { status: 200, body: { items: [entry('2')], nextCursor: '2' } };
      }
    });
    renderAt('/entities/users/42');

    await userEvent.click(await screen.findByRole('tab', { name: 'History' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('article', { name: 'create 1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(
      calls(fetchMock, '/api/entities/users/42/history').map((u) => u.searchParams.get('cursor')),
    ).toEqual([null, '2']);
  });

  it('says when nothing has been recorded', async () => {
    stubFetch((url) => {
      if (url.pathname === '/api/entities/users/42') return { status: 200, body: record };
      if (url.pathname === '/api/entities/users/42/history') {
        return { status: 200, body: { items: [], nextCursor: null } };
      }
    });
    renderAt('/entities/users/42');
    await userEvent.click(await screen.findByRole('tab', { name: 'History' }));
    expect(await screen.findByText('No changes recorded.')).toBeInTheDocument();
  });
});

describe('audit log page', () => {
  const page = (items: AuditEntry[]) => ({ status: 200, body: { items, nextCursor: null } });

  it('links to the page from the sidebar for audit admins only', async () => {
    stubFetch(() => undefined, ['audit']);
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Admin' });
    expect(within(nav).getByRole('link', { name: 'Audit log' })).toHaveAttribute(
      'href',
      '/admin/audit',
    );
    expect(within(nav).queryByRole('link', { name: 'Schema drift' })).not.toBeInTheDocument();
  });

  it('shows not found to everyone else', async () => {
    stubFetch(() => undefined);
    renderAt('/admin/audit');
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('lists entries with their entity and a link to the record', async () => {
    stubFetch(
      (url) =>
        url.pathname === '/api/audit'
          ? page([
              entry('3', { action: 'delete', after: null, entity: 'companies', recordId: '9' }),
              entry('2'),
            ])
          : undefined,
      ['audit'],
    );
    renderAt('/admin/audit');

    const update = await screen.findByRole('article', { name: 'update 2' });
    expect(within(update).getByText(/Users/)).toBeInTheDocument();
    expect(within(update).getByRole('link', { name: '42' })).toHaveAttribute(
      'href',
      '/entities/users/42',
    );
    // A deleted record has no page to link to.
    const deleted = screen.getByRole('article', { name: 'delete 3' });
    expect(within(deleted).getByText(/Companies/)).toBeInTheDocument();
    expect(within(deleted).queryByRole('link')).not.toBeInTheDocument();
  });

  it('applies filters from the form to the request and the URL', async () => {
    const user = userEvent.setup({ delay: null });
    const fetchMock = stubFetch(
      (url) => (url.pathname === '/api/audit' ? page([]) : undefined),
      ['audit'],
    );
    const router = renderAt('/admin/audit');
    expect(await screen.findByText('No matching entries.')).toBeInTheDocument();

    const form = screen.getByRole('form', { name: 'Filter audit log' });
    await user.type(within(form).getByLabelText('Actor'), 'ada@');
    await user.click(within(form).getByRole('combobox', { name: 'Entity' }));
    await user.click(await screen.findByRole('option', { name: 'Users' }));
    await user.click(within(form).getByRole('combobox', { name: 'Action' }));
    await user.click(await screen.findByRole('option', { name: 'update' }));
    await user.type(within(form).getByLabelText('From'), '2026-10-01');
    await user.type(within(form).getByLabelText('To'), '2026-10-02');
    await user.click(within(form).getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(calls(fetchMock, '/api/audit')).toHaveLength(2));
    const sent = calls(fetchMock, '/api/audit')[1]!.searchParams;
    expect(Object.fromEntries(sent)).toEqual({
      actor: 'ada@',
      entity: 'users',
      action: 'update',
      from: new Date(2026, 9, 1).toISOString(),
      to: new Date(2026, 9, 3).toISOString(),
      limit: '25',
    });
    expect(router.state.location.search).toBe(
      '?actor=ada%40&entity=users&action=update&from=2026-10-01&to=2026-10-02',
    );

    // Applying remounts the form with the applied filters.
    const applied = screen.getByRole('form', { name: 'Filter audit log' });
    expect(within(applied).getByLabelText('Actor')).toHaveValue('ada@');
    await user.click(within(applied).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('restores filters from the URL', async () => {
    const fetchMock = stubFetch(
      (url) => (url.pathname === '/api/audit' ? page([]) : undefined),
      ['audit'],
    );
    renderAt('/admin/audit?actor=ada&entity=users');
    expect(await screen.findByLabelText('Actor')).toHaveValue('ada');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Entity' })).toHaveTextContent('Users'),
    );
    await waitFor(() => expect(calls(fetchMock, '/api/audit')).toHaveLength(1));
    expect(calls(fetchMock, '/api/audit')[0]!.searchParams.get('actor')).toBe('ada');
  });

  it('shows the server’s reason when it rejects a search', async () => {
    stubFetch(
      (url) =>
        url.pathname === '/api/audit'
          ? { status: 400, body: { message: 'unknown entity' } }
          : undefined,
      ['audit'],
    );
    renderAt('/admin/audit?entity=gone');
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't search: unknown entity.");
  });
});
