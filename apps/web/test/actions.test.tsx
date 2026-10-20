import type { EffectiveSchema, Entity, Field } from '@wardenhq/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createApp } from '../src/App';
import {
  actionFields,
  actionInput,
  groupActionErrors,
  initialActionDrafts,
  PREVIEW_STALE_MESSAGE,
  type ActionDescriptor,
  type ActionDrafts,
} from '../src/lib/actions';
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
const entity = (key: string, label: string, displayField: string, fields: Field[]): Entity => ({
  key,
  schema: 'public',
  name: key,
  kind: 'table',
  label,
  primaryKey: ['id'],
  displayField,
  searchable: [],
  fields,
  relations: [],
});
const users = entity('users', 'Users', 'email', [
  field('id', 'ID', 'int8'),
  field('company_id', 'Company', 'int8'),
  field('email', 'Email'),
]);
const companies = entity('companies', 'Companies', 'name', [
  field('id', 'ID', 'int8'),
  field('name', 'Name'),
]);
const schema: EffectiveSchema = { entities: [users, companies] };

const moveUser: ActionDescriptor = {
  name: 'move-user',
  label: 'Move to company',
  description: 'Move the user to another company.',
  on: 'users',
  target: 'one',
  confirm: 'preview',
  destructive: false,
  requireReason: false,
  hasDefaults: false,
  permissions: { users: ['update'] },
  inputSchema: {
    properties: {
      company: { type: 'string', 'x-warden-ref': 'companies', label: 'New company' },
      notify: { type: 'boolean', default: false, label: 'Notify them' },
    },
    required: ['company'],
  },
};
const deactivate: ActionDescriptor = {
  ...moveUser,
  name: 'deactivate-users',
  label: 'Deactivate',
  description: 'Stop the selected users from being active.',
  target: 'many',
  confirm: 'confirm',
  destructive: true,
  requireReason: true,
  inputSchema: { properties: {} },
};

const ada = {
  id: '42',
  version: 'v1',
  values: { id: '42', company_id: '7', email: 'ada@example.com' },
};
const grace = {
  id: '43',
  version: 'v1',
  values: { id: '43', company_id: '7', email: 'grace@example.com' },
};

type Reply = { status: number; body?: unknown };
type Handler = (url: URL, init?: RequestInit) => Reply | undefined;

function stubFetch(handler: Handler, actions: ActionDescriptor[] = [moveUser, deactivate]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://warden.test');
    const res = handler(url, init) ??
      backend(url, actions) ?? { status: 404, body: { message: 'Not Found' } };
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const list = (items: unknown[]) => ({
  status: 200,
  body: { items, nextCursor: null, hasMore: false, total: items.length },
});

function backend(url: URL, actions: ActionDescriptor[]): Reply | undefined {
  switch (url.pathname) {
    case '/api/schema':
      return { status: 200, body: schema };
    case '/api/actions':
      return { status: 200, body: { actions } };
    case '/api/entities/users/42':
      return { status: 200, body: ada };
    case '/api/entities/users':
      return list([ada, grace]);
    case '/api/entities/companies':
      return list([
        { id: '7', values: { id: '7', name: 'Acme' } },
        { id: '9', values: { id: '9', name: 'Globex' } },
      ]);
  }
}

const posts = (fetchMock: ReturnType<typeof stubFetch>, path: string) =>
  fetchMock.mock.calls
    .filter(([input, init]) => init?.method === 'POST' && String(input) === path)
    .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>);

function renderAt(path: string) {
  const { router, queryClient } = createApp(() =>
    createMemoryRouter(routes, { initialEntries: [path] }),
  );
  render(<App router={router} queryClient={queryClient} />);
  return router;
}

const PREVIEW = {
  changes: [
    {
      operation: 'update',
      entity: 'users',
      recordId: '42',
      before: { company_id: '7' },
      after: { company_id: '9' },
      diff: { company_id: { from: '7', to: '9' } },
    },
  ],
  total: 1,
  truncated: false,
  result: { message: 'Moved ada@example.com to Globex' },
  previewToken: 'token-1',
};

async function openMoveUser() {
  const user = userEvent.setup();
  renderAt('/entities/users/42');
  await user.click(await screen.findByRole('button', { name: 'Actions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Move to company' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Move to company' });
  return { user, dialog };
}

async function pickGlobex(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.click(within(dialog).getByRole('combobox', { name: /New company/ }));
  await user.click(await screen.findByRole('option', { name: /Globex/ }));
}

describe('action form fields', () => {
  const fields = actionFields({
    inputSchema: {
      properties: {
        company: { type: 'string', 'x-warden-ref': 'companies', label: 'New company' },
        count: { type: 'integer' },
        amount: { anyOf: [{ type: 'number' }, { type: 'null' }], label: 'Amount' },
        flag: { type: 'boolean', default: false },
        choice: { type: 'string', enum: ['a', 'b'] },
        day: { type: 'string', format: 'date' },
        at: { type: 'string', format: 'date-time' },
        notes: { type: 'string', widget: 'textarea', maxLength: 50, description: 'Why' },
        tags: { type: 'array', items: { type: 'string' } },
        people: { type: 'array', items: { type: 'string', 'x-warden-ref': 'users' } },
      },
      required: ['company', 'count', 'amount', 'flag', 'tags'],
    },
  });
  const byName = (name: string) => fields.find((f) => f.name === name)!;

  it('builds a control for each JSON Schema field type', () => {
    expect(fields.map((f) => [f.name, f.widget, f.many, f.required])).toEqual([
      ['company', 'ref', false, true],
      ['count', 'integer', false, true],
      ['amount', 'number', false, true],
      ['flag', 'boolean', false, false],
      ['choice', 'enum', false, false],
      ['day', 'date', false, false],
      ['at', 'datetime', false, false],
      ['notes', 'textarea', false, false],
      ['tags', 'text', true, true],
      ['people', 'ref', true, false],
    ]);
    expect(byName('company')).toMatchObject({ label: 'New company', ref: 'companies' });
    expect(byName('amount')).toMatchObject({ label: 'Amount', nullable: true });
    expect(byName('count').label).toBe('Count');
    expect(byName('notes')).toMatchObject({ description: 'Why', maxLength: 50 });
  });

  it('turns drafts into input, leaving blank optional fields out', () => {
    const drafts: ActionDrafts = {
      ...initialActionDrafts(fields, { company: '9' }),
      count: '3',
      amount: '',
      choice: '',
      day: '2026-01-02',
      at: '2026-01-02T03:04:05',
      tags: ['x', ''],
    };
    expect(drafts.flag).toBe('false');
    expect(actionInput(fields, drafts)).toEqual({
      company: '9',
      count: 3,
      amount: null,
      flag: false,
      day: '2026-01-02',
      at: new Date('2026-01-02T03:04:05').toISOString(),
      tags: ['x'],
    });
  });

  it('keeps errors for fields the form has under the field, and others with the message', () => {
    expect(
      groupActionErrors(fields, [
        { field: 'company', message: 'references a record that does not exist' },
        { message: 'invalid users values' },
        { field: 'elsewhere', message: 'bad' },
      ]),
    ).toEqual({
      company: ['references a record that does not exist'],
      '': ['invalid users values', 'elsewhere: bad'],
    });
  });
});

describe('actions on the record page', () => {
  it('previews the change set, then runs it with the preview token', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.pathname === '/api/actions/move-user/preview') return { status: 200, body: PREVIEW };
      if (url.pathname === '/api/actions/move-user/run') {
        return { status: 200, body: { auditId: '5', result: PREVIEW.result } };
      }
    });
    const { user, dialog } = await openMoveUser();
    expect(within(dialog).getByText('Can change: Users (update)')).toBeInTheDocument();
    // A boolean with a default is a checkbox, starting at the default.
    expect(within(dialog).getByRole('checkbox', { name: 'Notify them' })).not.toBeChecked();
    await pickGlobex(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Preview' }));

    const changes = await within(dialog).findByRole('region', { name: 'Changes' });
    expect(changes).toHaveTextContent('This would change 1 row.');
    expect(changes).toHaveTextContent('Users (1 update)');
    expect(posts(fetchMock, '/api/actions/move-user/preview')).toEqual([
      { records: ['42'], input: { company: '9', notify: false } },
    ]);

    await user.click(within(dialog).getByRole('button', { name: 'Run' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      'Moved ada@example.com to Globex',
    );
    expect(posts(fetchMock, '/api/actions/move-user/run')).toEqual([
      { records: ['42'], input: { company: '9', notify: false }, previewToken: 'token-1' },
    ]);
  });

  it('shows field errors in the form', async () => {
    stubFetch((url) => {
      if (url.pathname === '/api/actions/move-user/preview') {
        return {
          status: 400,
          body: {
            message: 'invalid input',
            details: [{ field: 'company', message: 'is required' }],
          },
        };
      }
    });
    const { user, dialog } = await openMoveUser();
    await user.click(within(dialog).getByRole('button', { name: 'Preview' }));
    expect(await within(dialog).findByText('is required')).toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('invalid input');
  });

  it('asks to preview again when the data changed since the preview', async () => {
    stubFetch((url) => {
      if (url.pathname === '/api/actions/move-user/preview') return { status: 200, body: PREVIEW };
      if (url.pathname === '/api/actions/move-user/run') {
        return {
          status: 409,
          body: { statusCode: 409, error: 'preview_stale', message: PREVIEW_STALE_MESSAGE },
        };
      }
    });
    const { user, dialog } = await openMoveUser();
    await pickGlobex(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Preview' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Run' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This changed since you previewed it',
    );
    expect(within(dialog).getByRole('button', { name: 'Preview again' })).toBeInTheDocument();
  });

  it('offers no actions menu to users who may run none', async () => {
    stubFetch(() => undefined, []);
    renderAt('/entities/users/42');
    expect(await screen.findByRole('heading', { name: 'ada@example.com' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Actions' })).toBeNull());
  });
});

describe('actions on the grid', () => {
  it('runs a bulk action on the selected rows', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.pathname === '/api/actions/deactivate-users/run') {
        return {
          status: 200,
          body: { auditId: '6', result: { message: 'Deactivated 2 user(s)' } },
        };
      }
    });
    const user = userEvent.setup();
    renderAt('/entities/users');
    // Row actions are in each row's menu.
    expect(
      await screen.findByRole('button', { name: 'Actions for ada@example.com' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select all rows on this page' }));
    const bar = screen.getByRole('toolbar', { name: 'Selected rows' });
    expect(bar).toHaveTextContent('2 selected');
    await user.click(within(bar).getByRole('button', { name: 'Deactivate' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Deactivate' });
    expect(dialog).toHaveTextContent('2 records selected.');
    const run = within(dialog).getByRole('button', { name: 'Run' });
    // A required reason must be given first.
    expect(run).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'left the company');
    await user.click(run);
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Deactivated 2 user(s)');
    expect(posts(fetchMock, '/api/actions/deactivate-users/run')).toEqual([
      { records: ['42', '43'], input: {}, reason: 'left the company' },
    ]);
  });
});
