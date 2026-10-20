import { render, screen, within } from '@testing-library/react';
import { lazy } from 'react';
import { createMemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { App, createApp } from '../src/App';
import { AppLayout } from '../src/components/app-layout';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const body = String(input) === '/api/schema' ? { entities: [] } : { name: 'Ada' };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

it('renders a lazy page loading state inside the layout', async () => {
  const Pending = lazy(() => new Promise<never>(() => {}));
  const { router, queryClient } = createApp(() =>
    createMemoryRouter([
      { element: <AppLayout />, children: [{ index: true, element: <Pending /> }] },
    ]),
  );
  render(<App router={router} queryClient={queryClient} />);

  expect(await screen.findByRole('navigation', { name: 'Entities' })).toBeInTheDocument();
  const main = screen.getByRole('main');
  expect(within(main).getByLabelText('Loading')).toBeInTheDocument();
});
