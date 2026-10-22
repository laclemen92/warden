import { MAX_REASON_LENGTH } from '@wardenhq/config/schema';

export { MAX_REASON_LENGTH };

/** Sent when a write or action must give a reason and none (or only whitespace) was given. */
export const REASON_REQUIRED = 'a reason is required for this change';

export type ReasonCheck = { ok: true; reason?: string } | { ok: false; message: string };

/**
 * Check the reason a write or action gives. `minLength` is the shortest a required reason may be
 * once trimmed; when absent, a reason is optional. Lengths count characters, not UTF-16 units.
 */
export function checkReason(reason: string | null | undefined, minLength?: number): ReasonCheck {
  const raw = reason ?? '';
  if ([...raw].length > MAX_REASON_LENGTH) {
    return { ok: false, message: `the reason must be at most ${MAX_REASON_LENGTH} characters` };
  }
  const trimmed = raw.trim();
  if (minLength !== undefined) {
    if (!trimmed) return { ok: false, message: REASON_REQUIRED };
    if ([...trimmed].length < minLength) {
      return {
        ok: false,
        message: `a reason of at least ${minLength} characters is required for this change`,
      };
    }
  }
  return trimmed ? { ok: true, reason: trimmed } : { ok: true };
}

/** Whether `message` is one `checkReason` gives, so a form can point at its reason field. */
export function isReasonError(message: string): boolean {
  return (
    message === REASON_REQUIRED ||
    /^a reason of at least \d+ characters is required for this change$/.test(message) ||
    message === `the reason must be at most ${MAX_REASON_LENGTH} characters`
  );
}
