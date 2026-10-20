import type { EffectiveSchema, Entity, Field, Relation } from '@wardenhq/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createApp } from '../src/App';
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

const fk = (
  name: string,
  from: string,
  columns: string[],
  to: string,
  targetColumns: string[],
): [Relation, Relation] => [
  { kind: 'belongsTo', name, entity: to, columns, targetColumns },
  { kind: 'hasMany', name, entity: from, columns: targetColumns, targetColumns: columns },
];

const [userCompany, companyUsers] = fk(
  'users_company_id_fkey',
  'users',
  ['company_id'],
  'companies',
  ['id'],
);
const [orderUser, userOrders] = fk('orders_user_id_fkey', 'orders', ['user_id'], 'users', ['id']);
const [orderApprover, userApprovals] = fk(
  'orders_approved_by_fkey',
  'orders',
  ['approved_by'],
  'users',
  ['id'],
);

const entity = (
  key: string,
  label: string,
  displayField: string,
  fields: Field[],
  relations: Relation[],
): Entity => ({
  key,
  schema: 'public',
  name: key,
  kind: 'table',
  label,
  primaryKey: ['id'],
  displayField,
  searchable: [],
  fields,
  relations,
});

const schema: EffectiveSchema = {
  entities: [
    entity(
      'companies',
      'Companies',
      'name',
      [field('id', 'ID', 'int8'), field('name', 'Name')],
      [companyUsers],
    ),
    entity(
      'users',
      'Users',
      'email',
      [
        field('id', 'ID', 'int8'),
        field('company_id', 'Company', 'int8'),
        field('email', 'Email'),
        field('is_active', 'Active', 'bool'),
        field('metadata', 'Metadata', 'jsonb'),
      ],
      [userCompany, userOrders, userApprovals],
    ),
    entity(
      'orders',
      'Orders',
      'id',
      [
        field('id', 'ID', 'int8'),
        field('user_id', 'User', 'int8'),
        field('approved_by', 'Approved by', 'int8'),
        field('status', 'Status'),
      ],
      [orderUser, orderApprover],
    ),
  ],
};

const ada = {
  id: '42',
  version: 'v1',
  values: {
    id: '42',
    company_id: '7',
    email: 'ada@example.com',
    is_active: true,
    metadata: { tier: 'gold' },
  },
};
const order = (id: number) => ({
  id: String(id),
  values: { id: String(id), user_id: '42', approved_by: null, status: 'paid' },
});

type Handler = (url: URL, init?: RequestInit) => { status: number; body?: unknown } | undefined;

function stubFetch(handler: Handler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://warden.test');
    const res = (url.pathname === '/api/schema' ? { status: 200, body: schema } : undefined) ??
      handler(url, init) ?? { status: 404, body: { message: 'Not Found' } };
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const filterOf = (url: URL) => JSON.parse(url.searchParams.get('filter') ?? 'null') as unknown;

const list = (items: unknown[], extra: object = {}) => ({
  status: 200,
  body: { items, nextCursor: null, hasMore: false, ...extra },
});

/** A backend with Ada (user 42) at Acme (company 7) and 25 orders placed by Ada. */
const backend: Handler = (url) => {
  switch (url.pathname) {
    case '/api/entities/users/42':
      return { status: 200, body: ada };
    case '/api/entities/companies':
      return list([{ id: '7', values: { id: '7', name: 'Acme' } }]);
    case '/api/entities/orders': {
      const filter = filterOf(url) as { field: string };
      if (filter.field === 'approved_by') return list([], { total: 0 });
      const all = Array.from({ length: 25 }, (_, i) => order(i + 1));
      const cursor = url.searchParams.get('cursor');
      const page = cursor ? all.slice(20) : all.slice(0, 20);
      return list(page, {
        hasMore: !cursor,
        nextCursor: cursor ? null : 'page2',
        ...(cursor ? {} : { total: 25 }),
      });
    }
  }
};

function renderAt(path: string) {
  const { router, queryClient } = createApp(() =>
    createMemoryRouter(routes, { initialEntries: [path] }),
  );
  render(<App router={router} queryClient={queryClient} />);
  return router;
}

const fieldValue = (label: string) => {
  const term = screen.getAllByRole('term').find((t) => t.textContent === label);
  return term?.nextElementSibling as HTMLElement;
};

describe('record page', () => {
  beforeEach(() => stubFetch(backend));

  it('shows the record titled by its display field, with each field', async () => {
    renderAt('/entities/users/42');
    expect(await screen.findByRole('heading', { name: 'ada@example.com' })).toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Users' })).toHaveAttribute(
      'href',
      '/entities/users',
    );
    expect(fieldValue('Active')).toHaveTextContent('Yes');
    expect(fieldValue('Metadata')).toHaveTextContent('"tier": "gold"');
  });

  it('links a foreign key to its parent using the parent display field', async () => {
    const fetchMock = stubFetch(backend);
    renderAt('/entities/users/42');
    const link = await within(await waitFor(() => fieldValue('Company'))).findByRole('link', {
      name: 'Acme',
    });
    expect(link).toHaveAttribute('href', '/entities/companies/7');

    const parentCall = fetchMock.mock.calls
      .map(([input]) => new URL(String(input), 'http://warden.test'))
      .find((u) => u.pathname === '/api/entities/companies');
    expect(filterOf(parentCall!)).toEqual({ field: 'id', op: 'eq', value: '7' });
    expect(parentCall!.searchParams.get('limit')).toBe('1');
  });

  it('follows a parent link to the parent record', async () => {
    const router = renderAt('/entities/users/42');
    stubFetch((url) =>
      url.pathname === '/api/entities/companies/7'
        ? { status: 200, body: { id: '7', values: { id: '7', name: 'Acme' } } }
        : backend(url),
    );
    await userEvent.click(await screen.findByRole('link', { name: 'Acme' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/entities/companies/7'));
    expect(await screen.findByRole('heading', { name: 'Acme' })).toBeInTheDocument();
  });

  it('renders a null foreign key as empty without querying the parent', async () => {
    const fetchMock = stubFetch((url) =>
      url.pathname === '/api/entities/users/42'
        ? { status: 200, body: { id: '42', values: { ...ada.values, company_id: null } } }
        : backend(url),
    );
    renderAt('/entities/users/42');
    await screen.findByRole('heading', { name: 'ada@example.com' });
    expect(fieldValue('Company')).toHaveTextContent('—');
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/entities/companies')),
    ).toBe(false);
  });

  it('lists reverse relations as tabs, naming the FK when an entity references this one twice', async () => {
    renderAt('/entities/users/42');
    const related = await screen.findByRole('region', { name: 'Related records' });
    expect(
      within(related)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Orders (User)', 'Orders (Approved by)']);
  });

  it('lists child records filtered by the foreign key, linking each one, and pages', async () => {
    const fetchMock = stubFetch(backend);
    renderAt('/entities/users/42');
    const related = await screen.findByRole('region', { name: 'Related records' });
    const table = await within(related).findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['ID', 'Approved by', 'Status']);
    expect(within(table).getByRole('link', { name: '1' })).toHaveAttribute(
      'href',
      '/entities/orders/1',
    );
    expect(within(table).getAllByRole('row')).toHaveLength(21);
    expect(within(related).getByText('20 of 25 shown')).toBeInTheDocument();

    const childCall = fetchMock.mock.calls
      .map(([input]) => new URL(String(input), 'http://warden.test'))
      .find((u) => u.pathname === '/api/entities/orders');
    expect(filterOf(childCall!)).toEqual({ field: 'user_id', op: 'eq', value: '42' });

    await userEvent.click(within(related).getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(26));
    expect(within(related).queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows an empty state for a relation with no children', async () => {
    renderAt('/entities/users/42');
    const related = await screen.findByRole('region', { name: 'Related records' });
    await userEvent.click(within(related).getByRole('tab', { name: 'Orders (Approved by)' }));
    expect(await within(related).findByText('No orders.')).toBeInTheDocument();
  });

  it('shows not found for a missing record', async () => {
    renderAt('/entities/users/999');
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
  });

  it('shows not found for a record of an entity that is not exposed', async () => {
    const fetchMock = stubFetch(backend);
    renderAt('/entities/secrets/1');
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/entities/'))).toBe(
      false,
    );
  });

  it('encodes record ids in API paths', async () => {
    const fetchMock = stubFetch(backend);
    renderAt(`/entities/users/${encodeURIComponent('a/b?c')}`);
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/entities/users/a%2Fb%3Fc', expect.anything());
  });
});

describe('deleting a record', () => {
  const capabilities = (actions: string[]) => ({
    status: 200,
    body: { entities: { users: { actions }, companies: { actions: ['read'] } } },
  });
  /** The backend, with the given capabilities and a DELETE handler for Ada. */
  const withDelete =
    (actions: string[], onDelete: (init: RequestInit) => { status: number; body?: unknown }) =>
    (url: URL, init?: RequestInit) => {
      if (url.pathname === '/api/capabilities') return capabilities(actions);
      if (url.pathname === '/api/entities/users/42' && init?.method === 'DELETE') {
        return onDelete(init);
      }
      if (url.pathname === '/api/entities/users') return list([]);
      return backend(url);
    };
  const deleteButton = () => screen.queryByRole('button', { name: 'Delete' });
  const openDialog = async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    return screen.findByRole('alertdialog', { name: 'Delete ada@example.com?' });
  };

  /** Wait until capabilities have been fetched and the page has had a chance to use them. */
  const capabilitiesSettled = async (fetchMock: ReturnType<typeof stubFetch>) => {
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => input === '/api/capabilities')).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  };

  it('hides the button from users who may not delete', async () => {
    const fetchMock = stubFetch(withDelete(['read', 'update'], () => ({ status: 500 })));
    renderAt('/entities/users/42');
    await screen.findByRole('heading', { name: 'ada@example.com' });
    await capabilitiesSettled(fetchMock);
    expect(deleteButton()).not.toBeInTheDocument();
  });

  it('hides the button when capabilities fail to load', async () => {
    const fetchMock = stubFetch((url) =>
      url.pathname === '/api/capabilities' ? { status: 500 } : backend(url),
    );
    renderAt('/entities/users/42');
    await screen.findByRole('heading', { name: 'ada@example.com' });
    await capabilitiesSettled(fetchMock);
    expect(deleteButton()).not.toBeInTheDocument();
  });

  it('deletes after confirming, sending the version shown, then returns to the list', async () => {
    const deletes: RequestInit[] = [];
    stubFetch(
      withDelete(['read', 'delete'], (init) => {
        deletes.push(init);
        return { status: 204 };
      }),
    );
    const router = renderAt('/entities/users/42');
    const dialog = await openDialog();
    expect(deletes).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/entities/users'));
    expect(deletes).toHaveLength(1);
    expect(JSON.parse(String(deletes[0]!.body))).toEqual({ version: 'v1' });
  });

  it('does nothing when cancelled', async () => {
    const fetchMock = stubFetch(withDelete(['delete'], () => ({ status: 204 })));
    renderAt('/entities/users/42');
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it.each([
    [
      409,
      'the record has changed since it was read',
      'This record changed since you opened it. Review the current values and try again.',
    ],
    [
      409,
      'conflicts with existing records',
      "This record can't be deleted while other records refer to it.",
    ],
    [403, 'Forbidden', "You don't have permission to delete this record."],
    [500, 'Internal Server Error', "Couldn't delete this record."],
  ])('explains a %i (%s) in the dialog', async (status, message, shown) => {
    stubFetch(withDelete(['delete'], () => ({ status, body: { message } })));
    const router = renderAt('/entities/users/42');
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(shown);
    expect(router.state.location.pathname).toBe('/entities/users/42');
  });

  it('returns to the list when the record was already deleted', async () => {
    stubFetch(withDelete(['delete'], () => ({ status: 404, body: { message: 'Not Found' } })));
    const router = renderAt('/entities/users/42');
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/entities/users'));
  });
});
