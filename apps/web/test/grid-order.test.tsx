import type { EffectiveSchema, Entity, Field } from '@wardenhq/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createApp } from '../src/App';
import type { ActionDescriptor } from '../src/lib/actions';
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

const people: Entity = {
  key: 'people',
  schema: 'public',
  name: 'people',
  kind: 'table',
  label: 'People',
  primaryKey: ['id'],
  displayField: 'email',
  searchable: [],
  relations: [],
  fields: [
    field('notes', 'Notes'),
    field('updated_at', 'Updated at', 'timestamptz'),
    field('email', 'Email'),
    field('id', 'Id', 'int8'),
    field('created_at', 'Created at', 'timestamptz'),
    field('nickname', 'Nickname'),
  ],
};

const memberships: Entity = {
  ...people,
  key: 'memberships',
  name: 'memberships',
  label: 'Memberships',
  primaryKey: ['team_id', 'user_id'],
  displayField: 'role',
  fields: [
    field('role', 'Role'),
    field('user_id', 'User', 'int8'),
    field('team_id', 'Team', 'int8'),
  ],
};

const logs: Entity = {
  ...people,
  key: 'logs',
  name: 'logs',
  label: 'Logs',
  primaryKey: [],
  displayField: 'message',
  fields: [field('message', 'Message'), field('created_at', 'Created at', 'timestamptz')],
};

const action = (name: string, target: 'one' | 'many'): ActionDescriptor => ({
  name,
  label: name,
  on: 'people',
  target,
  confirm: 'confirm',
  destructive: false,
  requireReason: false,
  hasDefaults: false,
  permissions: { people: ['update'] },
  inputSchema: { properties: {} },
});

let schema: EffectiveSchema;
let requests: URL[];

const person = (id: number) => ({
  id: String(id),
  values: {
    id: String(id),
    email: `p${id}@example.com`,
    notes: `note ${id}`,
    nickname: null,
    created_at: '2026-01-02 03:04:05+00',
    updated_at: '2026-01-03 03:04:05+00',
  },
});

beforeEach(() => {
  schema = { entities: [people, memberships, logs] };
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://warden.test');
      let body: unknown = { message: 'Not Found' };
      let status = 200;
      if (url.pathname === '/api/schema') body = schema;
      else if (url.pathname === '/api/me') body = { name: 'Ada' };
      else if (url.pathname === '/api/actions') {
        body = { actions: [action('Archive', 'one'), action('Tag', 'many')] };
      } else if (url.pathname === '/api/entities/people') {
        requests.push(url);
        body = { items: [person(1), person(2)], nextCursor: null, hasMore: false, total: 2 };
      } else if (url.pathname === '/api/entities/memberships') {
        requests.push(url);
        body = { items: [], nextCursor: null, hasMore: false, total: 0 };
      } else if (url.pathname === '/api/entities/logs') {
        requests.push(url);
        const item = { id: null, values: { message: 'hello', created_at: '2026-01-02' } };
        body = { items: [item], nextCursor: null, hasMore: false, total: 1 };
      } else status = 404;
      return new Response(JSON.stringify(body), {
        status,
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

const headers = (table: HTMLElement) =>
  within(table)
    .getAllByRole('columnheader')
    .map((h) => h.textContent)
    .filter(Boolean);

async function peopleGrid() {
  const table = await screen.findByRole('table', { name: 'People' });
  await within(table).findByText('note 2');
  return table;
}

const rowOf = (cell: HTMLElement) => cell.closest('tr')!;

describe('grid column order', () => {
  it('shows the key, display field and timestamps first, and sorts newest first', async () => {
    renderAt('/entities/people');
    const table = await peopleGrid();
    expect(headers(table)).toEqual([
      'Actions',
      'Id',
      'Email',
      'Created at',
      'Updated at',
      'Notes',
      'Nickname',
    ]);
    expect(Object.fromEntries(requests.at(-1)!.searchParams)).toMatchObject({
      sort: '-created_at',
    });
    expect(within(table).getByRole('columnheader', { name: /Created at/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('shows composite keys in key order', async () => {
    renderAt('/entities/memberships');
    const table = await screen.findByRole('table', { name: 'Memberships' });
    await waitFor(() => expect(headers(table)).toEqual(['Team', 'User', 'Role']));
  });

  it('lets config override the order and the sort', async () => {
    schema = {
      entities: [
        {
          ...people,
          columnOrder: ['nickname', 'notes'],
          defaultSort: { column: 'email', direction: 'asc' },
        },
      ],
    };
    renderAt('/entities/people');
    const table = await peopleGrid();
    expect(headers(table)).toEqual([
      'Actions',
      'Nickname',
      'Notes',
      'Id',
      'Email',
      'Created at',
      'Updated at',
    ]);
    expect(requests.at(-1)!.searchParams.get('sort')).toBe('email');
  });

  it('keeps visibility from the URL but the order from the grid', async () => {
    renderAt('/entities/people?columns=notes,email,id');
    const table = await peopleGrid();
    expect(headers(table)).toEqual(['Actions', 'Id', 'Email', 'Notes']);
  });

  it('lists columns in the same order in the column picker', async () => {
    renderAt('/entities/people');
    await peopleGrid();
    await userEvent.click(screen.getByRole('button', { name: /Columns/ }));
    const items = await screen.findAllByRole('menuitemcheckbox');
    expect(items.map((i) => i.textContent)).toEqual([
      'Id',
      'Email',
      'Created at',
      'Updated at',
      'Notes',
      'Nickname',
    ]);
  });

  it('leaves tables without a primary key in table order and unsorted', async () => {
    renderAt('/entities/logs');
    const table = await screen.findByRole('table', { name: 'Logs' });
    await within(table).findByText('hello');
    expect(headers(table)).toEqual(['Message', 'Created at']);
    expect(requests.at(-1)!.searchParams.has('sort')).toBe(false);
  });
});

describe('opening a row by double-click', () => {
  it('opens the record from any data cell', async () => {
    const router = renderAt('/entities/people');
    const table = await peopleGrid();
    const row = rowOf(within(table).getByText('note 2'));
    expect(row).toHaveClass('cursor-pointer');
    await userEvent.dblClick(within(table).getByText('note 2'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/entities/people/2'));
  });

  it('keeps the display field link', async () => {
    renderAt('/entities/people');
    const table = await peopleGrid();
    expect(within(table).getByRole('link', { name: 'p1@example.com' })).toHaveAttribute(
      'href',
      '/entities/people/1',
    );
  });

  it('ignores double-clicks on the checkbox, the actions menu and links', async () => {
    const router = renderAt('/entities/people');
    const table = await peopleGrid();
    const row = rowOf(within(table).getByText('note 1'));
    // fireEvent, so the clicks a real double-click starts with don't toggle or follow anything.
    fireEvent.doubleClick(within(row).getByRole('checkbox'));
    fireEvent.doubleClick(within(row).getByRole('link'));
    const trigger = within(row).getByRole('button', { name: /Actions for/ });
    fireEvent.doubleClick(trigger);
    // The menu renders in a portal, but React bubbles its events through the row.
    await userEvent.click(trigger);
    fireEvent.doubleClick(await screen.findByRole('menuitem', { name: 'Archive' }));

    await new Promise((r) => setTimeout(r, 50));
    expect(router.state.location.pathname).toBe('/entities/people');
  });

  it('ignores double-clicks that start while text is selected', async () => {
    const router = renderAt('/entities/people');
    const table = await peopleGrid();
    const cell = within(table).getByText('note 2');
    const selection = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue({ toString: () => 'note' } as Selection);
    fireEvent.mouseDown(cell, { detail: 1 });
    selection.mockRestore();
    fireEvent.doubleClick(cell);
    await new Promise((r) => setTimeout(r, 50));
    expect(router.state.location.pathname).toBe('/entities/people');
  });

  it('does nothing on rows without a primary key', async () => {
    const router = renderAt('/entities/logs');
    const table = await screen.findByRole('table', { name: 'Logs' });
    const cell = await within(table).findByText('hello');
    expect(rowOf(cell)).not.toHaveClass('cursor-pointer');
    await userEvent.dblClick(cell);
    expect(router.state.location.pathname).toBe('/entities/logs');
  });
});
