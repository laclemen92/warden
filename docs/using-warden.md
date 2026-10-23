# Using Warden

A guide for the people who use Warden day to day. The same content is in the app under **Help** in the user menu (bottom of the sidebar), where it only shows the sections your roles allow: someone who can only read won't see editing, export or action instructions.

- [Getting around](#getting-around)
- [Search and filter](#search-and-filter)
- [Sorting](#sorting)
- [Columns](#columns)
- [Saved views](#saved-views)
- [Opening records](#opening-records)
- [Creating and editing records](#creating-and-editing-records)
- [Deleting and restoring](#deleting-and-restoring)
- [Internal notes](#internal-notes)
- [The audit trail](#the-audit-trail)
- [The audit log](#the-audit-log)
- [Exporting to CSV](#exporting-to-csv)
- [Custom actions](#custom-actions)
- ["You don't have permission"](#you-dont-have-permission)
- [Keyboard shortcuts](#keyboard-shortcuts)

## Getting around

The sidebar lists every table you can read. Type in **Filter entities** to narrow it down. **Queues** at the top are views your team pinned there; each opens its table with filters already applied. Press <kbd>⌘B</kbd> (Mac) or <kbd>Ctrl+B</kbd> to hide or show the sidebar.

Grid state lives in the URL, so a link to a filtered, sorted page opens the same way for anyone who can see that table.

## Search and filter

**Search** looks for your text in the table's searchable columns (the box only appears on tables that have some). **Filter** matches exact conditions on any column, like _Status is paid_ or _Placed at after 1 March_. They combine: rows must match the search and every filter.

Active filters show as chips next to the toolbar; remove one with its ×, or all of them with **Clear filters**. Tables that soft-delete rows hide deleted ones until you tick **Show deleted**.

## Sorting

Click a column header to sort by it; click again to switch between ascending and descending. <kbd>Shift</kbd>+click another header to add it as a further sort, up to 5 columns. Numbers on the headers show the order.

The **Sort** menu in the toolbar does the same without the mouse, and can sort by columns you've hidden. Reorder or remove sorts there, or reset to the table's default.

## Columns

**Columns** in the toolbar chooses which columns the grid shows. Hidden columns can still be filtered and sorted on.

## Saved views

**Views** saves the current search, filters, sort and columns under a name, so you can come back to them. **From config** lists views your administrators set up, and **Shared views** those someone shared with everyone. If you change a config view, the menu says it's modified; **Reset** puts it back.

With the `views` admin area, you can also share your views with everyone, stop sharing them, and export views as config.

## Opening records

Click the underlined value in a row, or double-click anywhere else in the row, to open the record. Its page shows every field you can see, links to the records it points at, related records under **Related**, and its change history under **History**.

## Creating and editing records

_Needs `create` or `update` on the table._

**New** on a table's page opens a blank form. Fields the database fills in can be left empty.

**Edit** on a record's page changes it. If someone else saved it after you opened it, Warden says so instead of overwriting their change; review the current values and try again.

A field that points at another record has a picker: type to search, then use <kbd>↑</kbd> <kbd>↓</kbd> and <kbd>Enter</kbd>, or click.

## Deleting and restoring

_Deleting needs `delete` on the table; restoring needs `update`._

**Delete** on a record's page asks you to confirm. A record other records still point at can't be deleted.

Some tables only mark rows as deleted: those rows drop out of the grid until you tick **Show deleted**, and **Restore** on the record brings one back. Restoring counts as an edit, so it needs `update` rather than `delete`.

## Internal notes

_Shown to anyone who can change records or run actions._

Changes and actions have an **Internal note** field for saying why. Some tables and actions require one. The note is stored in the audit log with the change: people who can read the audit log see it, your customers don't.

## The audit trail

Every change made through Warden is recorded with who made it, when, what changed and the internal note. A record's **History** tab lists its changes, newest first.

## The audit log

_Needs the `audit` admin area._

**Audit log** under Admin searches every change by person, table, kind of change and date. A custom action's entry links to the rows it changed.

## Exporting to CSV

_Needs `export` on the table._

**Export CSV** downloads every row that matches the grid's search and filters (not just the current page), in its sort order, with the columns it shows.

## Custom actions

_Shown when you can run at least one action._

**Actions** runs operations your team built for a table: on one record from its page or a row's ⋯ menu, on several by ticking rows first, or on the table as a whole from the toolbar.

An action shows its form, then either a preview of exactly what it will change or a confirmation step, before it runs. Actions that call another service report how each record went. Everything an action changes is audited as one entry.

## "You don't have permission"

Your roles decide which tables you see and what you can do with them, and Warden only shows buttons you can use. If you still see this message, your access changed after the page loaded (reload it), or the action needs a role you don't have; ask your Warden administrator.

## Keyboard shortcuts

Press <kbd>?</kbd> anywhere (except while typing in a field), or choose **Keyboard shortcuts** in the user menu, to see these in the app. <kbd>⌘</kbd> is the Command key on a Mac; use <kbd>Ctrl</kbd> elsewhere.

| Where            | Keys or mouse                     | What it does                                                                                                 |
| ---------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Anywhere         | <kbd>?</kbd>                      | Show keyboard shortcuts (not while typing in a field)                                                        |
| Anywhere         | <kbd>⌘B</kbd> / <kbd>Ctrl+B</kbd> | Show or hide the sidebar                                                                                     |
| Anywhere         | <kbd>Esc</kbd>                    | Close the open menu, popover or dialog                                                                       |
| Tables           | Click a column header             | Sort by that column. Click again to switch between ascending and descending (it never goes back to unsorted) |
| Tables           | Shift+click a column header       | Add the column to the sort, or flip its direction if it's already there (up to 5 columns)                    |
| Tables           | Click the underlined value        | Open the record (the table's display field)                                                                  |
| Tables           | Double-click a row                | Open the record. Not on buttons, checkboxes or links, and not when you had text selected                     |
| Searchable lists | <kbd>↑</kbd> / <kbd>↓</kbd>       | Move through the results while typing in the search box of a record picker or the Sort menu                  |
| Searchable lists | <kbd>Enter</kbd>                  | Choose the highlighted result                                                                                |

New shortcuts and mouse modifiers are added to `apps/web/src/lib/shortcuts.ts`, which the handlers and the in-app dialog both read, and to this page.
