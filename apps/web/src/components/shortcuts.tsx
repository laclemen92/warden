import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from 'cn';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { HELP_PATH } from '@/lib/help';
import {
  SHORTCUTS,
  SHORTCUT_SCOPES,
  detectPlatform,
  isShortcutsKey,
  isTypingTarget,
  keyLabels,
  type Platform,
  type Shortcut,
} from '@/lib/shortcuts';

export function Kbd({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 font-sans text-xs font-medium text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

function ShortcutKeys({ shortcut, platform }: { shortcut: Shortcut; platform: Platform }) {
  if (shortcut.gesture) return <span className="text-sm">{shortcut.gesture}</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shortcut.keys.map((chord, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-xs text-muted-foreground">or</span>}
          {keyLabels(chord, platform).map((label) => (
            <Kbd key={label}>{label}</Kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

/** Every entry in the shortcuts module, grouped by where it works. */
export function ShortcutList({ platform = detectPlatform() }: { platform?: Platform }) {
  return (
    <div className="space-y-4">
      {SHORTCUT_SCOPES.map((scope) => (
        <section key={scope} aria-label={scope} className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">{scope}</h3>
          <dl className="grid grid-cols-[minmax(9rem,max-content)_1fr] gap-x-4 gap-y-2">
            {SHORTCUTS.filter((s) => s.scope === scope).map((s) => (
              <div key={s.id} className="contents" data-shortcut={s.id}>
                <dt>
                  <ShortcutKeys shortcut={s} platform={platform} />
                </dt>
                <dd className="text-sm">{s.description}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

const ShortcutsContext = createContext<() => void>(() => {});

/** Opens the keyboard shortcuts dialog. */
export function useOpenShortcuts(): () => void {
  return useContext(ShortcutsContext);
}

/** Holds the shortcuts dialog and opens it on "?" when focus isn't in a text field. */
export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const platform = useMemo(() => detectPlatform(), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isShortcutsKey(event) || isTypingTarget(event.target)) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const openShortcuts = useMemo(() => () => setOpen(true), []);

  return (
    <ShortcutsContext.Provider value={openShortcuts}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>
              Shortcuts and mouse modifiers.{' '}
              <Link
                to={HELP_PATH}
                className="underline underline-offset-4"
                onClick={() => setOpen(false)}
              >
                Help
              </Link>{' '}
              explains the rest.
            </DialogDescription>
          </DialogHeader>
          <ShortcutList platform={platform} />
        </DialogContent>
      </Dialog>
    </ShortcutsContext.Provider>
  );
}
