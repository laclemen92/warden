import type { EffectiveSchema, Entity, Field, Relation } from '@wardenhq/core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createApp } from '../src/App';
import { routes } from '../src/routes';

const field = (name: string, label: string, dataType: string, extra: Partial<Field> = {}) => ({
  name,
  label,
  dataType,
  formattedType: dataType,
  isArray: false,
  nullable: true,
  hasDefault: false,
  readOnly: false,
  ...extra,
});

const userCompany: Relation = {
  kind: 'belongsTo',
  name: 'users_company_id_fkey',
  entity: 'companies',
  columns: ['company_id'],
  targetColumns: ['id'],
};

const entity = (key: string, label: string, fields: Field[], extra: Partial<Entity> = {}) => ({
  key,
  schema: 'public',
  name: key,
  kind: 'table' as const,
  label,
  primaryKey: ['id'],
  displayField: 'name',
  searchable: ['name'],
  fields,
  relations: [],
  ...extra,
});

// The schema as the API serves it: a hidden `password_hash` column simply isn't there.
const schema: EffectiveSchema = {
  entities: [
    entity('companies', 'Companies', [
      field('id', 'ID', 'int8', { nullable: false, createOnly: true }),
      field('name', 'Name', 'text'),
    ]),
    entity(
      'users',
      'Users',
      [
        field('id', 'ID', 'int8', { nullable: false, hasDefault: true, readOnly: true }),
        field('email', 'Email', 'varchar', { nullable: false, maxLength: 20 }),
        field('role', 'Role', 'user_role', { nullable: false, enumValues: ['admin', 'member'] }),
        field('is_active', 'Active', 'bool', { nullable: false, hasDefault: true }),
        field('bio', 'Bio', 'text'),
        field('metadata', 'Metadata', 'jsonb'),
        field('company_id', 'Company', 'int8'),
        field('born_on', 'Born on', 'date'),
        field('created_at', 'Created at', 'timestamptz', {
          nullable: false,
          hasDefault: true,
          readOnly: true,
        }),
      ],
      { displayField: 'email', searchable: ['email'], relations: [userCompany] },
    ),
  ],
};

const ada = {
  id: '42',
  version: 'v1',
  values: {
    id: '42',
    email: 'ada@example.com',
    role: 'admin',
    is_active: true,
    bio: null,
    metadata: { tier: 'gold' },
    company_id: '7',
    born_on: '1815-12-10',
    created_at: '2026-01-02 03:04:05.123456+00',
  },
};
const companies = [
  { id: '7', values: { id: '7', name: 'Acme' } },
  { id: '8', values: { id: '8', name: 'Acorn' } },
  { id: '9', values: { id: '9', name: 'Globex' } },
];

type Reply = { status: number; body?: unknown };
type Handler = (url: URL, init?: RequestInit) => Reply | undefined;

const list = (items: unknown[]): Reply => ({
  status: 200,
  body: { items, nextCursor: null, hasMore: false },
});

function capabilities(users: string[], companiesActions = ['read']): Reply {
  return {
    status: 200,
    body: { entities: { users: { actions: users }, companies: { actions: companiesActions } } },
  };
}

/** Ada and three companies; `extra` handles writes and overrides. */
function stubFetch(extra: Handler = () => undefined, actions = ['read', 'create', 'update']) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://warden.test');
    const res = extra(url, init) ??
      fallback(url, actions) ?? { status: 404, body: { message: 'Not Found' } };
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function fallback(url: URL, actions: string[]): Reply | undefined {
  switch (url.pathname) {
    case '/api/schema':
      return { status: 200, body: schema };
    case '/api/capabilities':
      return capabilities(actions);
    case '/api/entities/users/42':
      return { status: 200, body: ada };
    case '/api/entities/users':
      return list([]);
    case '/api/entities/companies': {
      const filter = url.searchParams.get('filter');
      if (filter) {
        const { value } = JSON.parse(filter) as { value: string };
        return list(companies.filter((c) => c.id === value));
      }
      const q = url.searchParams.get('q')?.toLowerCase() ?? '';
      return list(companies.filter((c) => c.values.name.toLowerCase().includes(q)));
    }
  }
}

const writes = (fetchMock: ReturnType<typeof stubFetch>, method: string) =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === method)
    .map(([input, init]) => ({
      url: String(input),
      body: JSON.parse(String(init!.body)) as unknown,
    }));

function renderAt(path: string) {
  const { router, queryClient } = createApp(() =>
    createMemoryRouter(routes, { initialEntries: [path] }),
  );
  render(<App router={router} queryClient={queryClient} />);
  return router;
}

/** Pick an option from a Radix select. */
async function choose(trigger: HTMLElement, option: string) {
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

async function pickCompany(search: string, option: string) {
  await userEvent.click(screen.getByRole('combobox', { name: 'Company' }));
  await userEvent.type(await screen.findByRole('searchbox', { name: 'Search companies' }), search);
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

const form = () => screen.findByRole('button', { name: /^(Create|Save)$/ });

// The pages are lazy routes. Importing them cold took over the 5s `asyncUtilTimeout` on a busy
// CI runner, failing whichever test rendered first; load them here, outside any assertion.
beforeAll(async () => {
  await Promise.all([
    import('../src/components/app-layout'),
    import('../src/pages/entity-page'),
    import('../src/pages/record-form-page'),
    import('../src/pages/record-page'),
  ]);
}, 60_000);

describe('creating a record', () => {
  beforeEach(() => stubFetch());

  it('links to the form from the list for users who may create', async () => {
    const router = renderAt('/entities/users');
    await userEvent.click(await screen.findByRole('link', { name: 'New' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/entities/users/-/new'));
    expect(await screen.findByRole('heading', { name: 'New users record' })).toBeInTheDocument();
  });

  it('hides the New button from users who may not create', async () => {
    const fetchMock = stubFetch(undefined, ['read', 'update']);
    renderAt('/entities/users');
    await screen.findByRole('heading', { name: 'Users' });
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => input === '/api/capabilities')).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('link', { name: 'New' })).not.toBeInTheDocument();
  });

  it('explains instead of showing a form the user may not submit', async () => {
    stubFetch(undefined, ['read']);
    renderAt('/entities/users/-/new');
    expect(
      await screen.findByText("You don't have permission to create records in Users."),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
  });

  it('shows an input for each writable field, chosen by its type', async () => {
    renderAt('/entities/users/-/new');
    await form();
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveAttribute('aria-required', 'true');
    expect(screen.getByRole('combobox', { name: 'Role' })).toBeInTheDocument();
    // Has a default, so it may be left to it.
    expect(screen.getByRole('combobox', { name: 'Active' })).toHaveTextContent('Default');
    expect(screen.getByRole('textbox', { name: 'Bio' }).tagName).toBe('TEXTAREA');
    expect(screen.getByRole('textbox', { name: 'Metadata' }).tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Born on')).toHaveAttribute('type', 'date');
    expect(screen.getByRole('combobox', { name: 'Company' })).toHaveTextContent(
      'Choose companies…',
    );
    // Read-only fields are filled in by the database; hidden ones don't exist.
    expect(screen.queryByLabelText('ID')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Created at')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it('checks values before sending them', async () => {
    const fetchMock = stubFetch();
    renderAt('/entities/users/-/new');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Email' }), 'x'.repeat(21));
    await userEvent.type(screen.getByRole('textbox', { name: 'Metadata' }), '{{nope');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Email must be at most 20 characters')).toBeInTheDocument();
    expect(screen.getByText('Role is required')).toBeInTheDocument();
    expect(screen.getByText('Metadata is not valid JSON')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveAttribute('aria-invalid', 'true');
    expect(writes(fetchMock, 'POST')).toHaveLength(0);

    // Editing a field clears its error.
    await userEvent.clear(screen.getByRole('textbox', { name: 'Email' }));
    expect(screen.queryByText('Email must be at most 20 characters')).not.toBeInTheDocument();
  });

  it('creates the record with a picked parent, then opens it', async () => {
    const fetchMock = stubFetch((url, init) =>
      url.pathname === '/api/entities/users' && init?.method === 'POST'
        ? { status: 201, body: { id: '43', version: 'v1', values: { ...ada.values, id: '43' } } }
        : url.pathname === '/api/entities/users/43'
          ? { status: 200, body: { ...ada, id: '43' } }
          : undefined,
    );
    const router = renderAt('/entities/users/-/new');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Email' }), 'grace@x.io');
    await choose(screen.getByRole('combobox', { name: 'Role' }), 'member');
    await choose(screen.getByRole('combobox', { name: 'Active' }), 'No');
    await userEvent.type(screen.getByRole('textbox', { name: 'Metadata' }), '{{"a": 1}');
    await pickCompany('acm', 'Acme (7)');
    expect(screen.getByRole('combobox', { name: 'Company' })).toHaveTextContent('Acme');
    await userEvent.type(screen.getByRole('textbox', { name: 'Internal note' }), ' onboarding ');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/entities/users/43'));
    expect(writes(fetchMock, 'POST')).toEqual([
      {
        url: '/api/entities/users',
        body: {
          values: {
            email: 'grace@x.io',
            role: 'member',
            is_active: false,
            bio: null,
            metadata: { a: 1 },
            company_id: '7',
            born_on: null,
          },
          reason: 'onboarding',
        },
      },
    ]);
  });

  it('searches the parent entity as the user types', async () => {
    const fetchMock = stubFetch();
    renderAt('/entities/users/-/new');
    await form();
    await userEvent.click(screen.getByRole('combobox', { name: 'Company' }));
    const listbox = await screen.findByRole('listbox', { name: 'Companies' });
    await waitFor(() => expect(within(listbox).getAllByRole('option')).toHaveLength(3));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search companies' }), 'ac');
    await waitFor(() => expect(within(listbox).getAllByRole('option')).toHaveLength(2));

    const search = fetchMock.mock.calls
      .map(([input]) => new URL(String(input), 'http://warden.test'))
      .filter((u) => u.pathname === '/api/entities/companies')
      .at(-1)!;
    expect(search.searchParams.get('q')).toBe('ac');
    expect(search.searchParams.get('limit')).toBe('20');

    // Keyboard: arrow down to the second match and pick it.
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByRole('combobox', { name: 'Company' })).toHaveTextContent('Acorn');
  });

  it('shows server field errors on their fields', async () => {
    stubFetch((url, init) =>
      url.pathname === '/api/entities/users' && init?.method === 'POST'
        ? {
            status: 409,
            body: {
              message: 'conflicts with existing records',
              details: [{ field: 'email', message: 'conflicts with an existing record' }],
            },
          }
        : undefined,
    );
    const router = renderAt('/entities/users/-/new');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Email' }), 'ada@x.io');
    await choose(screen.getByRole('combobox', { name: 'Role' }), 'admin');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Email conflicts with an existing record')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/entities/users/-/new');
  });

  it('reports errors about fields it doesn’t show for the record as a whole', async () => {
    stubFetch((url, init) =>
      url.pathname === '/api/entities/users' && init?.method === 'POST'
        ? {
            status: 400,
            body: {
              message: 'invalid record',
              details: [{ message: 'a value is too long for its field' }],
            },
          }
        : undefined,
    );
    renderAt('/entities/users/-/new');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Email' }), 'ada@x.io');
    await choose(screen.getByRole('combobox', { name: 'Role' }), 'admin');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A value is too long for its field');
  });

  it('falls back to a plain input when the parent entity can’t be read', async () => {
    stubFetch((url) =>
      url.pathname === '/api/capabilities' ? capabilities(['read', 'create'], []) : undefined,
    );
    renderAt('/entities/users/-/new');
    expect(await screen.findByRole('textbox', { name: 'Company' })).toBeInTheDocument();
  });
});

describe('when config requires a reason', () => {
  const requiring = (actions: string[]): Reply => ({
    status: 200,
    body: {
      entities: schema.entities.map((e) =>
        e.key === 'users' ? { ...e, requireReason: actions, reasonMinLength: 10 } : e,
      ),
    },
  });

  it('marks the reason required and won’t create without one', async () => {
    const fetchMock = stubFetch((url, init) =>
      url.pathname === '/api/schema'
        ? requiring(['create'])
        : url.pathname === '/api/entities/users' && init?.method === 'POST'
          ? { status: 201, body: { id: '43' } }
          : undefined,
    );
    const router = renderAt('/entities/users/-/new');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Email' }), 'g@x.io');
    await choose(screen.getByRole('combobox', { name: 'Role' }), 'member');
    const reason = screen.getByRole('textbox', { name: 'Internal note' });
    expect(reason).toHaveAttribute('aria-required', 'true');
    await userEvent.type(reason, '  ');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText("Say why you're making this change.")).toBeInTheDocument();
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    expect(writes(fetchMock, 'POST')).toHaveLength(0);

    // Too short once trimmed; the note is kept so it can be finished.
    await userEvent.type(reason, 'new hire');
    expect(screen.queryByText("Say why you're making this change.")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Write at least 10 characters.')).toBeInTheDocument();
    expect(writes(fetchMock, 'POST')).toHaveLength(0);
    expect(reason).toHaveValue('  new hire');

    await userEvent.type(reason, ' for Q3');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(writes(fetchMock, 'POST')).toHaveLength(1));
    expect(writes(fetchMock, 'POST')[0]!.body).toMatchObject({ reason: 'new hire for Q3' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/entities/users/43'));
  });

  it('only requires it for the configured action', async () => {
    stubFetch((url) => (url.pathname === '/api/schema' ? requiring(['create']) : undefined));
    renderAt('/entities/users/42/edit');
    const reason = await screen.findByRole('textbox', { name: 'Internal note' });
    expect(reason).not.toHaveAttribute('aria-required');
    expect(screen.getByText(/^Optional\. Say why\./)).toBeVisible();
  });

  it('shows a server rejection for a missing reason on the reason field', async () => {
    stubFetch((url, init) =>
      url.pathname === '/api/entities/users/42' && init?.method === 'PATCH'
        ? { status: 400, body: { message: 'a reason is required for this change' } }
        : undefined,
    );
    renderAt('/entities/users/42/edit');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Bio' }), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText("Say why you're making this change.")).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('editing a record', () => {
  beforeEach(() => stubFetch());

  it('links to the form from the record for users who may update', async () => {
    const router = renderAt('/entities/users/42');
    await userEvent.click(await screen.findByRole('link', { name: 'Edit' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/entities/users/42/edit'));
    expect(
      await screen.findByRole('heading', { name: 'Edit ada@example.com' }),
    ).toBeInTheDocument();
  });

  it('hides the Edit button from users who may not update', async () => {
    const fetchMock = stubFetch(undefined, ['read', 'create']);
    renderAt('/entities/users/42');
    await screen.findByRole('heading', { name: 'ada@example.com' });
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => input === '/api/capabilities')).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('fills the form with the current values, showing read-only fields as text', async () => {
    renderAt('/entities/users/42/edit');
    await form();
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveValue('ada@example.com');
    expect(screen.getByRole('combobox', { name: 'Role' })).toHaveTextContent('admin');
    expect(screen.getByRole('checkbox', { name: 'Active' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: 'Metadata' })).toHaveValue('{\n  "tier": "gold"\n}');
    expect(screen.getByLabelText('Born on')).toHaveValue('1815-12-10');
    expect(await screen.findByRole('combobox', { name: 'Company' })).toHaveTextContent('Acme');
    expect(screen.getByLabelText('Created at')).toHaveTextContent('2026-01-02 03:04:05.123456+00');
    expect(screen.queryByRole('textbox', { name: 'Created at' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('sends only the changed fields with the version it started from', async () => {
    const fetchMock = stubFetch((url, init) =>
      url.pathname === '/api/entities/users/42' && init?.method === 'PATCH'
        ? { status: 200, body: { ...ada, version: 'v2' } }
        : undefined,
    );
    const router = renderAt('/entities/users/42/edit');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Bio' }), 'Countess');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Active' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Clear' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/entities/users/42'));
    expect(writes(fetchMock, 'PATCH')).toEqual([
      {
        url: '/api/entities/users/42',
        body: { version: 'v1', values: { bio: 'Countess', is_active: false, company_id: null } },
      },
    ]);
  });

  it('follows the record to its new id when the key changes', async () => {
    stubFetch((url, init) =>
      url.pathname === '/api/entities/users/42' && init?.method === 'PATCH'
        ? { status: 200, body: { ...ada, id: '99', values: { ...ada.values, id: '99' } } }
        : url.pathname === '/api/entities/users/99'
          ? { status: 200, body: { ...ada, id: '99' } }
          : undefined,
    );
    const router = renderAt('/entities/users/42/edit');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Bio' }), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/entities/users/99'));
  });

  it('sets a create-only key when creating and shows it read-only when editing', async () => {
    const writable = ['read', 'create', 'update'];
    stubFetch((url) =>
      url.pathname === '/api/capabilities'
        ? capabilities(writable, writable)
        : url.pathname === '/api/entities/companies/7'
          ? { status: 200, body: { ...companies[0], version: 'v1' } }
          : undefined,
    );
    renderAt('/entities/companies/-/new');
    await form();
    expect(screen.getByRole('textbox', { name: 'ID' })).toHaveAttribute('aria-required', 'true');
    cleanup();

    renderAt('/entities/companies/7/edit');
    await form();
    expect(screen.queryByRole('textbox', { name: 'ID' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('ID')).toHaveTextContent('7');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Acme');
  });

  it('never sends fields the record has but the schema doesn’t', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url.pathname !== '/api/entities/users/42') return undefined;
      if (init?.method === 'PATCH') return { status: 200, body: ada };
      return { status: 200, body: { ...ada, values: { ...ada.values, password_hash: 'x' } } };
    });
    renderAt('/entities/users/42/edit');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Bio' }), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes(fetchMock, 'PATCH')).toHaveLength(1));
    expect(writes(fetchMock, 'PATCH')[0]!.body).toEqual({ version: 'v1', values: { bio: 'x' } });
    expect(screen.queryByText('password_hash')).not.toBeInTheDocument();
  });

  it('offers to reload when the record changed since it was opened', async () => {
    let version = 'v1';
    stubFetch((url, init) => {
      if (url.pathname !== '/api/entities/users/42') return undefined;
      if (init?.method === 'PATCH') {
        version = 'v2';
        return { status: 409, body: { message: 'the record has changed since it was read' } };
      }
      return version === 'v1'
        ? { status: 200, body: ada }
        : { status: 200, body: { ...ada, version, values: { ...ada.values, bio: 'Theirs' } } };
    });
    renderAt('/entities/users/42/edit');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Bio' }), 'Mine');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This record changed since you opened it.');
    // The edits stay until the user chooses to discard them.
    expect(screen.getByRole('textbox', { name: 'Bio' })).toHaveValue('Mine');

    await userEvent.click(
      within(alert).getByRole('button', { name: 'Discard my changes and reload' }),
    );
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Bio' })).toHaveValue('Theirs'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows not found for a missing record', async () => {
    renderAt('/entities/users/999/edit');
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
  });

  it('still opens a record whose key is "new"', async () => {
    stubFetch((url) =>
      url.pathname === '/api/entities/users/new'
        ? { status: 200, body: { ...ada, id: 'new' } }
        : undefined,
    );
    renderAt('/entities/users/new');
    expect(await screen.findByRole('heading', { name: 'ada@example.com' })).toBeInTheDocument();
  });
});
