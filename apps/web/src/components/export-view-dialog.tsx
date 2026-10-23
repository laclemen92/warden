import { useEffect, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import type { ConfigExport } from '@/lib/view-export';

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shows a config snippet for a view, copied to the clipboard when it opens. Warden never writes
 * the config file: the snippet goes through review like any other config change.
 */
export function ExportViewDialog({
  value,
  onClose,
}: {
  value: ConfigExport | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => {
    if (!value) return;
    let current = true;
    void copy(value.yaml).then((ok) => current && setCopied(ok));
    return () => {
      current = false;
      setCopied(null);
    };
  }, [value]);

  return (
    <AlertDialog open={value !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="sm:max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Export to config: {value?.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {copied === true
              ? 'Copied to the clipboard. '
              : copied === false
                ? 'Copy it below. '
                : ''}
            {value?.pasteUnder ? (
              <>
                Paste it under <code>{value.pasteUnder}</code> in your Warden config (
                <code>warden.config.yaml</code>), replacing any entry with the same key.
              </>
            ) : (
              <>
                Merge it into <code>tables</code> in your Warden config (
                <code>warden.config.yaml</code>).
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <pre
          aria-label="Config snippet"
          className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs"
        >
          {value?.yaml}
        </pre>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => value && void copy(value.yaml).then(setCopied)}>
            Copy again
          </Button>
          <AlertDialogAction>Done</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
