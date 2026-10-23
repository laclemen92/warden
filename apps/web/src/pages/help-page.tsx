import { MAX_SORT_TERMS } from '@wardenhq/core';
import type { ReactNode } from 'react';
import { Kbd, ShortcutList, useOpenShortcuts } from '@/components/shortcuts';
import { Button } from '@/components/ui/button';
import { showsSection, useHelpFeatures, type HelpFeature } from '@/lib/help';
import { chordText, detectPlatform, shortcut } from '@/lib/shortcuts';

// Keep in step with docs/using-warden.md.

interface Section {
  id: string;
  title: string;
  /** Shown only when the user has one of these. */
  requires?: HelpFeature[];
  body: (features: ReadonlySet<HelpFeature>) => ReactNode;
}

const sidebarKeys = () => chordText(shortcut('sidebar').keys[0]!, detectPlatform());

const SECTIONS: Section[] = [
  {
    id: 'getting-around',
    title: 'Getting around',
    body: () => (
      <>
        <p>
          The sidebar lists every table you can read. Type in <em>Filter entities</em> to narrow it
          down. <em>Queues</em> at the top are views your team pinned there; each opens its table
          with filters already applied. Press <Kbd>{sidebarKeys()}</Kbd> to hide or show the
          sidebar.
        </p>
        <p>
          Grid state lives in the URL, so a link to a filtered, sorted page opens the same way for
          anyone who can see that table.
        </p>
      </>
    ),
  },
  {
    id: 'search-filter',
    title: 'Search and filter',
    body: () => (
      <>
        <p>
          <strong>Search</strong> looks for your text in the table's searchable columns (the box
          only appears on tables that have some). <strong>Filter</strong> matches exact conditions
          on any column, like <em>Status is paid</em> or <em>Placed at after 1 March</em>. They
          combine: rows must match the search and every filter.
        </p>
        <p>
          Active filters show as chips next to the toolbar; remove one with its ×, or all of them
          with <em>Clear filters</em>. Tables that soft-delete rows hide deleted ones until you tick{' '}
          <em>Show deleted</em>.
        </p>
      </>
    ),
  },
  {
    id: 'sorting',
    title: 'Sorting',
    body: () => (
      <>
        <p>
          Click a column header to sort by it; click again to switch between ascending and
          descending. <Kbd>Shift</Kbd>+click another header to add it as a further sort, up to{' '}
          {MAX_SORT_TERMS} columns. Numbers on the headers show the order.
        </p>
        <p>
          The <em>Sort</em> menu in the toolbar does the same without the mouse, and can sort by
          columns you've hidden. Reorder or remove sorts there, or reset to the table's default.
        </p>
      </>
    ),
  },
  {
    id: 'columns',
    title: 'Columns',
    body: () => (
      <p>
        <em>Columns</em> in the toolbar chooses which columns the grid shows. Hidden columns can
        still be filtered and sorted on.
      </p>
    ),
  },
  {
    id: 'saved-views',
    title: 'Saved views',
    body: (features) => (
      <>
        <p>
          <em>Views</em> saves the current search, filters, sort and columns under a name, so you
          can come back to them. <em>From config</em> lists views your administrators set up, and{' '}
          <em>Shared views</em> those someone shared with everyone. If you change a config view, the
          menu says it's modified; <em>Reset</em> puts it back.
        </p>
        {features.has('share-views') && (
          <p>
            You can share your views with everyone, stop sharing them, and export views as config.
          </p>
        )}
      </>
    ),
  },
  {
    id: 'records',
    title: 'Opening records',
    body: () => (
      <p>
        Click the underlined value in a row, or double-click anywhere else in the row, to open the
        record. Its page shows every field you can see, links to the records it points at, related
        records under <em>Related</em>, and its change history under <em>History</em>.
      </p>
    ),
  },
  {
    id: 'editing',
    title: 'Creating and editing records',
    requires: ['create', 'update'],
    body: (features) => (
      <>
        {features.has('create') && (
          <p>
            <em>New</em> on a table's page opens a blank form. Fields the database fills in can be
            left empty.
          </p>
        )}
        {features.has('update') && (
          <p>
            <em>Edit</em> on a record's page changes it. If someone else saved it after you opened
            it, Warden says so instead of overwriting their change; review the current values and
            try again.
          </p>
        )}
        <p>
          A field that points at another record has a picker: type to search, then use <Kbd>↑</Kbd>{' '}
          <Kbd>↓</Kbd> and <Kbd>Enter</Kbd>, or click.
        </p>
      </>
    ),
  },
  {
    id: 'deleting',
    title: 'Deleting and restoring',
    requires: ['delete', 'update'],
    body: (features) => (
      <>
        {features.has('delete') && (
          <p>
            <em>Delete</em> on a record's page asks you to confirm. A record other records still
            point at can't be deleted.
          </p>
        )}
        {features.has('update') && (
          <p>
            Some tables only mark rows as deleted: those rows drop out of the grid until you tick{' '}
            <em>Show deleted</em>, and <em>Restore</em> on the record brings one back. Restoring
            counts as an edit, so it needs edit access rather than delete.
          </p>
        )}
      </>
    ),
  },
  {
    id: 'internal-notes',
    title: 'Internal notes',
    requires: ['create', 'update', 'delete', 'actions'],
    body: () => (
      <p>
        Changes and actions have an <em>Internal note</em> field for saying why. Some tables and
        actions require one. The note is stored in the audit log with the change: people who can
        read the audit log see it, your customers don't.
      </p>
    ),
  },
  {
    id: 'audit-trail',
    title: 'The audit trail',
    body: () => (
      <p>
        Every change made through Warden is recorded with who made it, when, what changed and the
        internal note. A record's <em>History</em> tab lists its changes, newest first.
      </p>
    ),
  },
  {
    id: 'audit-log',
    title: 'The audit log',
    requires: ['audit-log'],
    body: () => (
      <p>
        <em>Audit log</em> under Admin searches every change by person, table, kind of change and
        date. A custom action's entry links to the rows it changed.
      </p>
    ),
  },
  {
    id: 'export',
    title: 'Exporting to CSV',
    requires: ['export'],
    body: () => (
      <p>
        <em>Export CSV</em> downloads every row that matches the grid's search and filters (not just
        the current page), in its sort order, with the columns it shows.
      </p>
    ),
  },
  {
    id: 'actions',
    title: 'Custom actions',
    requires: ['actions'],
    body: () => (
      <>
        <p>
          <em>Actions</em> runs operations your team built for a table: on one record from its page
          or a row's ⋯ menu, on several by ticking rows first, or on the table as a whole from the
          toolbar.
        </p>
        <p>
          An action shows its form, then either a preview of exactly what it will change or a
          confirmation step, before it runs. Actions that call another service report how each
          record went. Everything an action changes is audited as one entry.
        </p>
      </>
    ),
  },
  {
    id: 'permissions',
    title: '“You don’t have permission”',
    body: () => (
      <p>
        Your roles decide which tables you see and what you can do with them, and Warden only shows
        buttons you can use. If you still see this message, your access changed after the page
        loaded (reload it), or the action needs a role you don't have; ask your Warden
        administrator.
      </p>
    ),
  },
];

export function HelpPage() {
  const features = useHelpFeatures();
  const openShortcuts = useOpenShortcuts();
  const sections = SECTIONS.filter((s) => showsSection(features, s.requires));

  return (
    <div className="max-w-3xl space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Using Warden</h1>
        <p className="text-muted-foreground">
          Only what you can do is covered here; your roles decide the rest.
        </p>
      </div>
      <nav aria-label="On this page">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="underline underline-offset-4">
                {s.title}
              </a>
            </li>
          ))}
          <li>
            <a href="#shortcuts" className="underline underline-offset-4">
              Keyboard shortcuts
            </a>
          </li>
        </ul>
      </nav>
      {sections.map((s) => (
        <section key={s.id} id={s.id} aria-labelledby={`${s.id}-title`} className="space-y-2">
          <h2 id={`${s.id}-title`} className="text-lg font-semibold">
            {s.title}
          </h2>
          <div className="space-y-2 text-sm leading-relaxed">{s.body(features)}</div>
        </section>
      ))}
      <section id="shortcuts" aria-labelledby="shortcuts-title" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="shortcuts-title" className="text-lg font-semibold">
            Keyboard shortcuts
          </h2>
          <Button variant="outline" size="sm" onClick={openShortcuts}>
            Press <Kbd>?</Kbd> anywhere
          </Button>
        </div>
        <ShortcutList />
      </section>
    </div>
  );
}
