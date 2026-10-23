import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionDialog } from '../src/components/action-dialog';
import type { ActionDescriptor } from '../src/lib/actions';

const action: ActionDescriptor = {
  name: 'resolve-review',
  label: 'Resolve review',
  on: 'users',
  target: 'none',
  confirm: 'confirm',
  destructive: false,
  requireReason: false,
  hasDefaults: false,
  inputSchema: { properties: {} },
  permissions: {},
};

type Reply = { status: number; body: unknown };
let requests: { path: string; body: unknown }[];
let replies: Record<string, Reply[]>;

beforeEach(() => {
  requests = [];
  replies = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://warden.test').pathname;
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const reply =
        path === '/api/schema' ? { status: 200, body: { entities: [] } } : replies[path]?.shift();
      const { status, body } = reply ?? { status: 404, body: { message: 'Not Found' } };
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

const renderDialog = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: '/', element: <ActionDialog action={action} records={[]} onClose={() => {}} /> },
  ]);
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
};

describe('multi-step action dialog', () => {
  it('shows which steps completed and retries the remaining ones', async () => {
    replies['/api/actions/resolve-review/run'] = [
      {
        status: 502,
        body: {
          statusCode: 502,
          message: 'the API this action calls failed; try again later',
          auditId: '41',
          retryable: true,
          steps: [
            { name: 'payout', result: 'ok', message: 'Payout held' },
            { name: 'claim', result: 'failed', message: 'the API this action calls failed' },
            { name: 'notify', result: 'not_attempted' },
          ],
        },
      },
    ];
    replies['/api/actions/resolve-review/retry'] = [
      {
        status: 200,
        body: {
          auditId: '41',
          result: {
            message: 'Claim resolved',
            steps: [
              { name: 'payout', result: 'ok' },
              { name: 'claim', result: 'ok', message: 'Claim resolved' },
              { name: 'notify', result: 'ok' },
            ],
          },
        },
      },
    ];
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));

    const steps = await screen.findByRole('list', { name: 'Steps' });
    const items = within(steps)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(items).toEqual([
      'Done payout: Payout held',
      'Failed claim: the API this action calls failed',
      'Not attempted notify',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Retry remaining steps' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Claim resolved');
    expect(requests.at(-1)).toEqual({
      path: '/api/actions/resolve-review/retry',
      body: { auditId: '41' },
    });
  });

  it('offers no retry once steps were undone', async () => {
    replies['/api/actions/resolve-review/run'] = [
      {
        status: 400,
        body: {
          statusCode: 400,
          message: 'Claim is closed',
          auditId: '42',
          retryable: false,
          steps: [
            {
              name: 'payout',
              result: 'ok',
              compensation: { result: 'failed', message: 'undoing this step failed' },
            },
            { name: 'claim', result: 'rejected', message: 'Claim is closed' },
          ],
        },
      },
    ];
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
    expect(await screen.findByText(/undo failed: undoing this step failed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry remaining steps' })).toBeNull();
  });
});
