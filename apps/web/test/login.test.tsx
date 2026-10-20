import { render, screen } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App, createApp } from '../src/App';
import { routes } from '../src/routes';

async function renderLogin(search: string) {
  const { router, queryClient } = createApp(() =>
    createMemoryRouter(routes, { initialEntries: [`/login${search}`] }),
  );
  const { container } = render(<App router={router} queryClient={queryClient} />);
  await screen.findByRole('link', { name: 'Continue with SSO' });
  return container;
}

describe('login page errors', () => {
  it('shows no alert without an error', async () => {
    await renderLogin('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a generic retry message for login_failed', async () => {
    await renderLogin('?error=login_failed');
    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in failed. Please try again.');
  });

  it('tells a denied user to ask an administrator', async () => {
    await renderLogin('?error=access_denied&returnTo=%2Fentities%2Forders');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Your account doesn't have access to Warden.");
    expect(alert).toHaveTextContent(/administrator/);
    expect(alert).not.toHaveTextContent(/try again/i);
    expect(screen.getByRole('link', { name: 'Continue with SSO' })).toHaveAttribute(
      'href',
      '/auth/login?returnTo=%2Fentities%2Forders',
    );
  });

  it('never renders an unknown code', async () => {
    const payload = '<img src=x onerror="alert(1)">pwned';
    const container = await renderLogin(`?error=${encodeURIComponent(payload)}`);
    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in failed. Please try again.');
    expect(container).not.toHaveTextContent('pwned');
    expect(container.querySelector('img')).toBeNull();
  });
});
