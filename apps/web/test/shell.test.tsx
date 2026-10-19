import type { EffectiveSchema, Entity } from '@wardenhq/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createApp } from '../src/App';
import { routes } from '../src/routes';

function entity(key: string, label: string): Entity {
  return {
    key,
    schema: 'public',
    name: key,
    kind: 'table',
    label,
    primaryKey: ['id'],
    displayField: 'id',
    searchable: [],
    fields: [],
    relations: [],
  };
}

const schema: EffectiveSchema = {
  entities: [
    entity('users', 'People'),
    entity('orders', 'Orders'),
    entity('audit.log', 'Audit log'),
  ],
};

type Responses = Record<string, { status: number; body?: unknown }>;

function stubFetch(responses: Responses) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const res = responses[`${init?.method ?? 'GET'} ${url}`] ?? {
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

const signedIn: Responses = {
  'GET /api/schema': { status: 200, body: schema },
  'GET /api/me': { status: 200, body: { name: 'Ada Lovelace', email: 'ada@example.com' } },
  'POST /auth/logout': { status: 204 },
};

describe('web shell', () => {
  beforeEach(() => stubFetch(signedIn));

  it('lists exposed entities by label in the sidebar, sorted', async () => {
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Entities' });
    await waitFor(() => expect(within(nav).getAllByRole('link')).toHaveLength(3));
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Audit log', 'Orders', 'People']);
    expect(within(nav).getByRole('link', { name: 'People' })).toHaveAttribute(
      'href',
      '/entities/users',
    );
    expect(within(nav).getByRole('link', { name: 'Audit log' })).toHaveAttribute(
      'href',
      '/entities/audit.log',
    );
  });

  it('filters the entity list', async () => {
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Entities' });
    await within(nav).findByRole('link', { name: 'People' });
    await userEvent.type(screen.getByRole('textbox', { name: 'Filter entities' }), 'ord');
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Orders']);
  });

  it('navigates to an entity and marks it active', async () => {
    const router = renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Entities' });
    await userEvent.click(await within(nav).findByRole('link', { name: 'Orders' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/entities/orders'));
    expect(await screen.findByRole('heading', { name: 'Orders' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Orders' })).toHaveAttribute(
      'data-active',
      'true',
    );
  });

  it('shows not found for an entity that is not exposed', async () => {
    renderAt('/entities/secrets');
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
  });

  it('shows the current user and logs out', async () => {
    const fetchMock = stubFetch(signedIn);
    const router = renderAt('/entities/users');
    const account = await screen.findByRole('button', { name: 'Account' });
    await waitFor(() => expect(account).toHaveTextContent('Ada Lovelace'));
    expect(account).toHaveTextContent('ada@example.com');

    await userEvent.click(account);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Log out' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(await screen.findByRole('link', { name: 'Continue with SSO' })).toBeInTheDocument();
  });

  it('shows an anonymous user until the session endpoint exists', async () => {
    stubFetch({ 'GET /api/schema': { status: 200, body: schema } });
    renderAt('/');
    const account = await screen.findByRole('button', { name: 'Account' });
    expect(account).toHaveTextContent('Anonymous');
  });

  it('redirects to login with a return path when the API returns 401', async () => {
    stubFetch({
      'GET /api/schema': { status: 401, body: { message: 'Unauthorized' } },
      'GET /api/me': { status: 401, body: { message: 'Unauthorized' } },
    });
    const router = renderAt('/entities/orders?sort=id');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toBe('?returnTo=%2Fentities%2Forders%3Fsort%3Did');
    expect(await screen.findByRole('link', { name: 'Continue with SSO' })).toHaveAttribute(
      'href',
      '/auth/login?returnTo=%2Fentities%2Forders%3Fsort%3Did',
    );
  });
});
