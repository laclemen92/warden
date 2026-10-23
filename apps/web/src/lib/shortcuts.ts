import { MAX_SORT_TERMS } from '@wardenhq/core';

/**
 * Every keyboard shortcut and mouse modifier in the UI. The handlers match events with the
 * helpers below and the shortcuts dialog and help page list `SHORTCUTS`, so a new one added here
 * shows up in both. Document it in docs/using-warden.md too.
 */

export type Platform = 'mac' | 'other';

/** `Mod` is ⌘ on a Mac and Ctrl elsewhere. Other tokens are shown as written. */
export type KeyToken = 'Mod' | 'Shift' | 'Esc' | 'Enter' | '↑' | '↓' | '?' | 'B';

export interface Shortcut {
  id: string;
  /** Where it works. */
  scope: ShortcutScope;
  /** Alternatives, each a chord of keys pressed together. Empty for a mouse gesture. */
  keys: KeyToken[][];
  /** A mouse gesture, e.g. "Double-click a row", shown instead of keys. */
  gesture?: string;
  description: string;
}

export const SHORTCUT_SCOPES = ['Anywhere', 'Tables', 'Searchable lists'] as const;
export type ShortcutScope = (typeof SHORTCUT_SCOPES)[number];

export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: 'shortcuts',
    scope: 'Anywhere',
    keys: [['?']],
    description: 'Show keyboard shortcuts (not while typing in a field)',
  },
  {
    id: 'sidebar',
    scope: 'Anywhere',
    keys: [['Mod', 'B']],
    description: 'Show or hide the sidebar',
  },
  {
    id: 'close',
    scope: 'Anywhere',
    keys: [['Esc']],
    description: 'Close the open menu, popover or dialog',
  },
  {
    id: 'sort',
    scope: 'Tables',
    keys: [],
    gesture: 'Click a column header',
    description:
      'Sort by that column. Click again to switch between ascending and descending (it never goes back to unsorted)',
  },
  {
    id: 'multi-sort',
    scope: 'Tables',
    keys: [],
    gesture: 'Shift+click a column header',
    description: `Add the column to the sort, or flip its direction if it's already there (up to ${MAX_SORT_TERMS} columns)`,
  },
  {
    id: 'open-link',
    scope: 'Tables',
    keys: [],
    gesture: 'Click the underlined value',
    description: "Open the record (the table's display field)",
  },
  {
    id: 'open-row',
    scope: 'Tables',
    keys: [],
    gesture: 'Double-click a row',
    description:
      'Open the record. Not on buttons, checkboxes or links, and not when you had text selected',
  },
  {
    id: 'list-move',
    scope: 'Searchable lists',
    keys: [['↑'], ['↓']],
    description:
      'Move through the results while typing in the search box of a record picker or the Sort menu',
  },
  {
    id: 'list-choose',
    scope: 'Searchable lists',
    keys: [['Enter']],
    description: 'Choose the highlighted result',
  },
];

export function shortcut(id: string): Shortcut {
  const found = SHORTCUTS.find((s) => s.id === id);
  if (!found) throw new Error(`No shortcut "${id}"`);
  return found;
}

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const name = nav.userAgentData?.platform ?? nav.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(name) ? 'mac' : 'other';
}

/** The labels of a chord's keys, e.g. ["⌘", "B"] on a Mac and ["Ctrl", "B"] elsewhere. */
export function keyLabels(chord: readonly KeyToken[], platform: Platform): string[] {
  return chord.map((key) => (key === 'Mod' ? (platform === 'mac' ? '⌘' : 'Ctrl') : key));
}

/** A chord as text: "⌘B" on a Mac, "Ctrl+B" elsewhere. */
export function chordText(chord: readonly KeyToken[], platform: Platform): string {
  const labels = keyLabels(chord, platform);
  return platform === 'mac' && chord[0] === 'Mod' ? labels.join('') : labels.join('+');
}

/** The `aria-keyshortcuts` value for a chord. */
export function ariaKeys(chord: readonly KeyToken[], platform: Platform): string {
  return chord
    .map((key) => (key === 'Mod' ? (platform === 'mac' ? 'Meta' : 'Control') : key))
    .join('+');
}

interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** ⌘B or Ctrl+B. Either modifier works on every platform. Not with Shift: ⌘⇧B is the browser's bookmarks bar. */
export function isSidebarToggle(event: KeyLike): boolean {
  return (
    event.key.toLowerCase() === 'b' &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

/** "?" with no command modifier (Shift is how most layouts type it). */
export function isShortcutsKey(event: KeyLike): boolean {
  return event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey;
}

/** Whether a click on a column header adds to the sort instead of replacing it. */
export function isMultiSortEvent(event: unknown): boolean {
  return typeof event === 'object' && event !== null && 'shiftKey' in event && !!event.shiftKey;
}

/** What a key does in a searchable list: move the highlight, choose it, or nothing. */
export function listKey(key: string): 1 | -1 | 'choose' | null {
  if (key === 'ArrowDown') return 1;
  if (key === 'ArrowUp') return -1;
  if (key === 'Enter') return 'choose';
  return null;
}

/** Whether keys typed with focus on `target` are text, so single-key shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  // jsdom doesn't implement isContentEditable.
  const editable = target.closest('[contenteditable]');
  if (editable && editable.getAttribute('contenteditable') !== 'false') return true;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}
