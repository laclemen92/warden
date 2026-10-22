import { checkReason, isReasonError, MAX_REASON_LENGTH, REASON_REQUIRED } from '@wardenhq/core';
import { Textarea } from '@/components/ui/textarea';

/**
 * What's wrong with `note` as the reason for a write, or null when it will do. `minLength` is
 * the shortest a required note may be; absent when the note is optional. Uses the server's check.
 */
export function noteProblem(note: string, minLength: number | undefined): string | null {
  const checked = checkReason(note, minLength);
  if (checked.ok) return null;
  if (checked.message === REASON_REQUIRED) return "Say why you're making this change.";
  if (minLength !== undefined && [...note.trim()].length < minLength) {
    return `Write at least ${minLength} characters.`;
  }
  return `Keep it to ${MAX_REASON_LENGTH} characters or fewer.`;
}

/** The note's problem when the server rejected a write over it (config changed since loading). */
export function rejectedNote(message: string): string | null {
  if (message === REASON_REQUIRED) return "Say why you're making this change.";
  return isReasonError(message) ? message.charAt(0).toUpperCase() + message.slice(1) : null;
}

/**
 * The reason a write or action gives, stored in the audit log. Labeled "Internal note" so it's
 * clear who reads it.
 */
export function InternalNote({
  id,
  value,
  onChange,
  minLength,
  error,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** The shortest the note may be; absent when it's optional. */
  minLength: number | undefined;
  /** Shown under the field, e.g. after a submit with an invalid note. */
  error?: string | null;
}) {
  const required = minLength !== undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        Internal note
        {required && (
          <span className="text-destructive" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      <Textarea
        id={id}
        rows={2}
        value={value}
        maxLength={MAX_REASON_LENGTH}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
        onChange={(e) => onChange(e.target.value)}
      />
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {required ? `Required, at least ${minLength} characters` : 'Optional'}. Say why. Saved in
        the audit log: people who can read the audit log see it, end users don't.
      </p>
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
