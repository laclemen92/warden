import { describe, expect, it } from 'vitest';
import { checkReason, isReasonError, MAX_REASON_LENGTH, REASON_REQUIRED } from '../src/index.js';

const TOO_SHORT = 'a reason of at least 10 characters is required for this change';
const TOO_LONG = `the reason must be at most ${MAX_REASON_LENGTH} characters`;

describe('checkReason', () => {
  it('accepts a long enough reason, trimmed', () => {
    expect(checkReason('  fixing a typo \n', 10)).toEqual({ ok: true, reason: 'fixing a typo' });
    expect(checkReason('x'.repeat(10), 10)).toEqual({ ok: true, reason: 'x'.repeat(10) });
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace', '  \n\t '],
  ])('rejects a required reason that is %s', (_, reason) => {
    expect(checkReason(reason, 10)).toEqual({ ok: false, message: REASON_REQUIRED });
  });

  it('rejects a required reason shorter than the minimum once trimmed', () => {
    expect(checkReason('fix', 10)).toEqual({ ok: false, message: TOO_SHORT });
    expect(checkReason(`   ${'x'.repeat(9)}   `, 10)).toEqual({ ok: false, message: TOO_SHORT });
  });

  it('counts characters, not UTF-16 units', () => {
    // Five emoji are ten UTF-16 units.
    expect(checkReason('🙂'.repeat(5), 10).ok).toBe(false);
    expect(checkReason('🙂'.repeat(MAX_REASON_LENGTH)).ok).toBe(true);
  });

  it('rejects a reason over the maximum, required or not', () => {
    const long = 'x'.repeat(MAX_REASON_LENGTH + 1);
    expect(checkReason(long, 10)).toEqual({ ok: false, message: TOO_LONG });
    expect(checkReason(long)).toEqual({ ok: false, message: TOO_LONG });
    expect(checkReason('x'.repeat(MAX_REASON_LENGTH)).ok).toBe(true);
  });

  it('takes any reason, or none, when it is optional', () => {
    expect(checkReason(undefined)).toEqual({ ok: true });
    expect(checkReason('   ')).toEqual({ ok: true });
    expect(checkReason(' fix ')).toEqual({ ok: true, reason: 'fix' });
  });

  it('recognizes its own messages', () => {
    expect(isReasonError(REASON_REQUIRED)).toBe(true);
    expect(isReasonError(TOO_SHORT)).toBe(true);
    expect(isReasonError(TOO_LONG)).toBe(true);
    expect(isReasonError('invalid record')).toBe(false);
  });
});
