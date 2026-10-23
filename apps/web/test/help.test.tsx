import type { EffectiveSchema } from '@wardenhq/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, createApp } from '../src/App';
import type { CurrentUser } from '../src/lib/auth';
import type { Capabilities } from '../src/lib/capabilities';
import { helpFeatures } from '../src/lib/help';
import type { RecordList } from '../src/lib/records';
import { routes } from '../src/routes';
import {
  SHORTCUTS,
  ariaKeys,
  chordText,
  isMultiSortEvent,
  isShortcutsKey,
  isSidebarToggle,
  isTypingTarget,
  keyLabels,
  listKey,
} from '../src/lib/shortcuts';
import { orders } from './fixtures';

const schema: EffectiveSchema = { entities: [orders] };

const rows: RecordList = {
  items: [{ id: '1', values: { id: '1', status: 'paid', notes: 'note 1' } }],
  nextCursor: null,
  hasMore: false,
  total: 1,
};

const viewer: Capabilities = { entities: { orders: { actions: ['read'], customActions: [] } } };
const editor: Capabilities = {
  entities: {
    orders: {
      actions: ['read', 'create', 'update', 'delete', 'export'],
      customActions: ['refund'],
    },
  },
};

let capabilities: { status: number; body: unknown };
let me: CurrentUser;

beforeEach(() => {
  capabilities = { status: 200, body: viewer };
  me = { name: 'Ada' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://warden.test');
      let res: { status: number; body: unknown };
      if (url.pathname === '/api/schema') res = { status: 200, body: schema };
      else if (url.pathname === '/api/me') res = { status: 200, body: me };
      else if (url.pathname === '/api/capabilities') res = capabilities;
      else if (url.pathname.startsWith('/api/entities/')) res = { status: 200, body: rows };
      else res = { status: 404, body: { message: 'Not Found' } };
      return new Response(JSON.stringify(res.body), {
        status: res.status,
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

const key = (key: string, extra: Partial<KeyboardEventInit> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...extra,
});

describe('shortcuts module', () => {
  it('shows ⌘ on a Mac and Ctrl elsewhere', () => {
    expect(chordText(['Mod', 'B'], 'mac')).toBe('⌘B');
    expect(chordText(['Mod', 'B'], 'other')).toBe('Ctrl+B');
    expect(keyLabels(['Mod', 'B'], 'mac')).toEqual(['⌘', 'B']);
    expect(ariaKeys(['Mod', 'B'], 'mac')).toBe('Meta+B');
    expect(ariaKeys(['Mod', 'B'], 'other')).toBe('Control+B');
  });

  it('matches the keys the handlers act on', () => {
    expect(isShortcutsKey(key('?'))).toBe(true);
    expect(isShortcutsKey(key('?', { ctrlKey: true }))).toBe(false);
    expect(isShortcutsKey(key('/'))).toBe(false);
    expect(isSidebarToggle(key('b', { metaKey: true }))).toBe(true);
    expect(isSidebarToggle(key('b', { ctrlKey: true }))).toBe(true);
    expect(isSidebarToggle(key('b'))).toBe(false);
    expect(isMultiSortEvent({ shiftKey: true })).toBe(true);
    expect(isMultiSortEvent({ shiftKey: false })).toBe(false);
    expect(isMultiSortEvent(null)).toBe(false);
    expect([listKey('ArrowDown'), listKey('ArrowUp'), listKey('Enter'), listKey('a')]).toEqual([
      1,
      -1,
      'choose',
      null,
    ]);
  });

  it('treats text fields and contenteditable as typing', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inside = document.createElement('span');
    editable.append(inside);
    for (const el of [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
      editable,
      inside,
    ]) {
      expect(isTypingTarget(el)).toBe(true);
    }
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('has unique ids', () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
  });
});

describe('keyboard shortcuts dialog', () => {
  it('opens on ? and lists every entry in the shortcuts module', async () => {
    renderAt('/');
    await screen.findByRole('button', { name: 'Account' });
    await userEvent.keyboard('?');

    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const s of SHORTCUTS) {
      const entry = dialog.querySelector(`[data-shortcut="${s.id}"]`);
      expect(entry, s.id).not.toBeNull();
      expect(entry).toHaveTextContent(s.description);
      if (s.gesture) expect(entry).toHaveTextContent(s.gesture);
      for (const chord of s.keys) {
        for (const k of keyLabels(chord, 'other')) expect(entry).toHaveTextContent(k);
      }
    }

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('ignores ? typed in an input, textarea or contenteditable', async () => {
    renderAt('/');
    const filter = await screen.findByRole('textbox', { name: 'Filter entities' });
    await userEvent.type(filter, '?');
    expect(filter).toHaveValue('?');

    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.append(textarea, editable);
    try {
      fireEvent.keyDown(textarea, { key: '?' });
      fireEvent.keyDown(editable, { key: '?' });
    } finally {
      textarea.remove();
      editable.remove();
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens from the user menu', async () => {
    renderAt('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Account' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Keyboard shortcuts' }));
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });
});

describe('hints', () => {
  it('shows the sidebar shortcut when the toggle has keyboard focus', async () => {
    renderAt('/');
    const toggle = await screen.findByRole('button', { name: 'Toggle Sidebar' });
    expect(toggle).toHaveAttribute('aria-keyshortcuts', 'Control+B');
    fireEvent.focus(toggle);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Toggle sidebar');
    expect(tip).toHaveTextContent('Ctrl');
    expect(tip).toHaveTextContent('B');
  });

  it('shows the multi-sort hint when a sortable header has keyboard focus', async () => {
    renderAt('/entities/orders');
    const table = await screen.findByRole('table', { name: 'Orders' });
    const header = await within(table).findByRole('button', { name: /Status/ });
    fireEvent.focus(header);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/Shift\+click to add to the sort/);
  });
});

describe('help page', () => {
  const sectionTitles = async () => {
    await screen.findByRole('heading', { name: 'Using Warden' });
    return screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
  };

  it('is linked from the user menu', async () => {
    const router = renderAt('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Account' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Help' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/help'));
    expect(await screen.findByRole('heading', { name: 'Using Warden' })).toBeInTheDocument();
  });

  it('shows a read-only user no edit, export or action sections', async () => {
    renderAt('/help');
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/capabilities', expect.anything()));
    const titles = await sectionTitles();
    expect(titles).toContain('Search and filter');
    expect(titles).toContain('Sorting');
    expect(titles).toContain('Keyboard shortcuts');
    for (const hidden of [
      'Creating and editing records',
      'Deleting and restoring',
      'Internal notes',
      'Exporting to CSV',
      'Custom actions',
      'The audit log',
    ]) {
      expect(titles).not.toContain(hidden);
    }
    expect(screen.queryByText(/share your views/)).not.toBeInTheDocument();
  });

  it('shows the sections for what the user can do', async () => {
    capabilities = { status: 200, body: editor };
    me = { name: 'Ada', admin: ['audit', 'views'] };
    renderAt('/help');
    await screen.findByRole('heading', { name: 'Custom actions' });
    const titles = await sectionTitles();
    for (const shown of [
      'Creating and editing records',
      'Deleting and restoring',
      'Internal notes',
      'Exporting to CSV',
      'Custom actions',
      'The audit log',
    ]) {
      expect(titles).toContain(shown);
    }
    expect(screen.getByText(/share your views/)).toBeInTheDocument();
  });

  it('hides write sections when capabilities fail to load', async () => {
    capabilities = { status: 500, body: { message: 'Internal Server Error' } };
    renderAt('/help');
    const titles = await sectionTitles();
    expect(titles).not.toContain('Creating and editing records');
    expect(titles).not.toContain('Exporting to CSV');
  });
});

describe('helpFeatures', () => {
  it('collects what the user can do on any table', () => {
    const caps: Capabilities = {
      entities: {
        a: { actions: ['read', 'update'] },
        b: { actions: ['read', 'export'], customActions: [] },
      },
    };
    expect([...helpFeatures(caps, { admin: ['audit'] })].sort()).toEqual([
      'audit-log',
      'export',
      'update',
    ]);
  });

  it('is empty until capabilities and the user are known', () => {
    expect(helpFeatures(undefined, { admin: ['audit'] }).size).toBe(0);
    expect(helpFeatures(editor, undefined).size).toBe(0);
  });
});
