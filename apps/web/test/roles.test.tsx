import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createApp } from '../src/App';
import type { RolesReport } from '../src/lib/roles';
import { routes } from '../src/routes';

const report: RolesReport = {
  roles: [
    { name: 'viewer', grants: { '*': ['read'] }, admin: [] },
    { name: 'admin', grants: { '*': ['read', 'update'] }, admin: ['schema', 'roles'] },
    { name: 'ops', grants: {}, admin: [] },
  ],
  access: {
    groups: { 'warden-admins': ['admin'] },
    emailDomains: { 'example.com': ['viewer'] },
    allowAll: false,
  },
  assignments: [
    {
      email: 'eve@example.org',
      role: 'ops',
      assignedBy: 'admin',
      assignedAt: '2026-10-01 12:00:00+00',
      defined: true,
    },
    {
      email: 'old@example.org',
      role: 'ghost',
      assignedBy: 'admin',
      assignedAt: '2026-09-01 12:00:00+00',
      defined: false,
    },
  ],
  signedIn: [
    {
      subject: 'sub-sam',
      email: 'sam@example.org',
      name: 'Sam',
      sessions: 2,
      lastSeenAt: '2026-10-20 08:00:00+00',
    },
    {
      subject: 'sub-x',
      email: null,
      name: null,
      sessions: 1,
      lastSeenAt: '2026-10-20 07:00:00+00',
    },
  ],
};

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

const rowsOf = (region: HTMLElement) =>
  within(region)
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent);

/** Pick an option from a Radix select. */
async function choose(trigger: HTMLElement, option: string) {
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

const bodyOf = (fetchMock: ReturnType<typeof stubFetch>, method: string) => {
  const call = fetchMock.mock.calls.find(([, init]) => init?.method === method);
  return JSON.parse(String(call?.[1]?.body)) as unknown;
};

describe('roles page', () => {
  it('links to the page from the sidebar for role admins only', async () => {
    stubFetch(base(['roles']));
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Admin' });
    expect(within(nav).getByRole('link', { name: 'Roles' })).toHaveAttribute(
      'href',
      '/admin/roles',
    );
    expect(within(nav).queryByRole('link', { name: 'Schema drift' })).not.toBeInTheDocument();
  });

  it('hides the link from everyone else and shows not found', async () => {
    stubFetch(base(['schema']));
    renderAt('/admin/roles');
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Admin' });
    expect(within(nav).queryByRole('link', { name: 'Roles' })).not.toBeInTheDocument();
  });

  it('shows assignments, and config roles and access rules read-only', async () => {
    stubFetch({ ...base(['roles']), 'GET /api/admin/roles': { status: 200, body: report } });
    renderAt('/admin/roles');

    const assignments = await screen.findByRole('region', { name: 'Assignments' });
    expect(rowsOf(assignments)).toEqual([
      'eve@example.orgopsadmin2026-10-01 12:00:00+00Remove',
      'old@example.orgghostNot in configadmin2026-09-01 12:00:00+00Remove',
    ]);

    const roles = screen.getByRole('region', { name: 'Defined roles' });
    expect(rowsOf(roles)).toEqual(['viewer*: read', 'admin*: read, updateschemaroles', 'opsNone']);
    expect(within(roles).queryByRole('button')).not.toBeInTheDocument();

    const access = screen.getByRole('region', { name: 'Access rules' });
    expect(rowsOf(access)).toEqual(['Groupwarden-adminsadmin', 'Email domainexample.comviewer']);
  });

  it('assigns a role and refreshes the list', async () => {
    const assigned = {
      email: 'new@example.org',
      role: 'viewer',
      assignedBy: 'admin',
      assignedAt: '2026-10-20 12:00:00+00',
      defined: true,
    };
    const responses: Responses = {
      ...base(['roles']),
      'GET /api/admin/roles': { status: 200, body: report },
      'POST /api/admin/roles/assignments': { status: 201, body: assigned },
    };
    const fetchMock = stubFetch(responses);
    renderAt('/admin/roles');

    const form = await screen.findByRole('form', { name: 'Assign a role' });
    const submit = within(form).getByRole('button', { name: 'Assign' });
    expect(submit).toBeDisabled();
    await userEvent.type(within(form).getByRole('textbox', { name: 'Email' }), 'new@example.org');
    await choose(within(form).getByRole('combobox', { name: 'Role' }), 'viewer');

    responses['GET /api/admin/roles'] = {
      status: 200,
      body: { ...report, assignments: [...report.assignments, assigned] },
    };
    await userEvent.click(submit);

    expect(await screen.findByText('new@example.org')).toBeInTheDocument();
    expect(bodyOf(fetchMock, 'POST')).toEqual({ email: 'new@example.org', role: 'viewer' });
    expect(within(form).getByRole('textbox', { name: 'Email' })).toHaveValue('');
  });

  it("shows the server's reason when an assignment is rejected", async () => {
    stubFetch({
      ...base(['roles']),
      'GET /api/admin/roles': { status: 200, body: report },
      'POST /api/admin/roles/assignments': {
        status: 409,
        body: { message: 'eve@example.org already has role "ops"' },
      },
    });
    renderAt('/admin/roles');

    const form = await screen.findByRole('form', { name: 'Assign a role' });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Email' }), 'eve@example.org');
    await choose(within(form).getByRole('combobox', { name: 'Role' }), 'ops');
    await userEvent.click(within(form).getByRole('button', { name: 'Assign' }));

    await waitFor(() =>
      expect(within(form).getByRole('alert')).toHaveTextContent('already has role "ops"'),
    );
  });

  it('removes an assignment', async () => {
    const responses: Responses = {
      ...base(['roles']),
      'GET /api/admin/roles': { status: 200, body: report },
      'DELETE /api/admin/roles/assignments': { status: 204 },
    };
    const fetchMock = stubFetch(responses);
    renderAt('/admin/roles');

    const remove = await screen.findByRole('button', { name: 'Remove ops from eve@example.org' });
    responses['GET /api/admin/roles'] = {
      status: 200,
      body: { ...report, assignments: report.assignments.slice(1) },
    };
    await userEvent.click(remove);

    await waitFor(() => expect(screen.queryByText('eve@example.org')).not.toBeInTheDocument());
    expect(bodyOf(fetchMock, 'DELETE')).toEqual({ email: 'eve@example.org', role: 'ops' });
  });

  it('lists who is signed in and signs a user out everywhere', async () => {
    const responses: Responses = {
      ...base(['roles']),
      'GET /api/admin/roles': { status: 200, body: report },
      'DELETE /api/admin/roles/sessions': { status: 200, body: { revoked: 2 } },
    };
    const fetchMock = stubFetch(responses);
    renderAt('/admin/roles');

    const signedIn = await screen.findByRole('region', { name: 'Signed in' });
    expect(rowsOf(signedIn)).toEqual([
      'sam@example.orgsub-sam22026-10-20 08:00:00+00Sign out everywhere',
      'sub-x12026-10-20 07:00:00+00Sign out everywhere',
    ]);

    responses['GET /api/admin/roles'] = {
      status: 200,
      body: { ...report, signedIn: report.signedIn.slice(1) },
    };
    await userEvent.click(
      within(signedIn).getByRole('button', { name: 'Sign out sam@example.org everywhere' }),
    );
    await waitFor(() => expect(within(signedIn).queryByText('sub-sam')).not.toBeInTheDocument());
    expect(bodyOf(fetchMock, 'DELETE')).toEqual({ subject: 'sub-sam' });
  });

  it('explains when nobody is signed in', async () => {
    stubFetch({
      ...base(['roles']),
      'GET /api/admin/roles': { status: 200, body: { ...report, signedIn: [] } },
    });
    renderAt('/admin/roles');
    const signedIn = await screen.findByRole('region', { name: 'Signed in' });
    expect(signedIn).toHaveTextContent('Nobody is signed in.');
  });

  it('explains when access lets everyone in', async () => {
    stubFetch({
      ...base(['roles']),
      'GET /api/admin/roles': {
        status: 200,
        body: { ...report, access: { groups: {}, emailDomains: {}, allowAll: true } },
      },
    });
    renderAt('/admin/roles');
    const access = await screen.findByRole('region', { name: 'Access rules' });
    expect(access).toHaveTextContent('everyone the identity provider authenticates can sign in');
    expect(access).not.toHaveTextContent('only people with an assignment');
  });

  it('explains when access has no rules', async () => {
    stubFetch({
      ...base(['roles']),
      'GET /api/admin/roles': {
        status: 200,
        body: { ...report, access: { groups: {}, emailDomains: {}, allowAll: false } },
      },
    });
    renderAt('/admin/roles');
    const access = await screen.findByRole('region', { name: 'Access rules' });
    expect(access).toHaveTextContent('only people with an assignment can sign in');
  });
});
