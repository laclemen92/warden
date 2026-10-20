import type { Field } from './effective-schema.js';

/**
 * Checks that a value fits its column's type, shared by writes, filters, ids, and cursors. They
 * reject everything Postgres would refuse to parse as the type itself (typmods such as lengths
 * and numeric precision are checked only for writes), so a bad value is a 400, not a 500.
 */

const INTEGER_RANGES: Record<string, [bigint, bigint]> = {
  int2: [-(2n ** 15n), 2n ** 15n - 1n],
  int4: [-(2n ** 31n), 2n ** 31n - 1n],
  int8: [-(2n ** 63n), 2n ** 63n - 1n],
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER = /^-?\d+$/;
const NUMERIC = /^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const MONEY = /^-?(\d+(\.\d*)?|\.\d+)$/;
// Postgres' numeric limits: 131072 digits before the decimal point, 16383 after, and an exponent
// of at most INT_MAX / 2 (even for zero).
const NUMERIC_MAX_INTEGER_DIGITS = 131072;
const NUMERIC_MAX_SCALE = 16383;
const NUMERIC_MAX_EXPONENT = 2 ** 30 - 1;

/** Number of digits before the decimal point, e.g. 3 for `-123.45`, 0 for `0.5e-3`, 4 for `1.5e3`. */
export function integerDigits(value: string): number {
  const { whole, fraction, exponent } = parts(value);
  const digits = whole + fraction;
  const leadingZeros = digits.length - digits.replace(/^0+/, '').length;
  if (leadingZeros === digits.length) return 0;
  return Math.max(0, whole.length + exponent - leadingZeros);
}

function parts(value: string) {
  const [mantissa = '', exponent = '0'] = value.replace(/^-/, '').toLowerCase().split('e');
  const [whole = '', fraction = ''] = mantissa.split('.');
  return { whole, fraction, exponent: Number(exponent) };
}

/** Whether a numeric string has a nonzero digit, i.e. isn't some spelling of zero. */
const nonzero = (value: string) => /[1-9]/.test(value.split(/e/i)[0]!);

/** Error message when `value` isn't a number of `f`'s type, ignoring typmods. */
export function checkNumber(f: Field, value: number | string): string | undefined {
  const text = typeof value === 'number' ? String(value) : value;
  const range = INTEGER_RANGES[f.dataType];
  if (range) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      return Number.isInteger(value)
        ? 'integers this large must be sent as strings'
        : 'expected an integer';
    }
    if (!INTEGER.test(text)) return 'expected an integer';
    const n = BigInt(text);
    return n < range[0] || n > range[1] ? `must be between ${range[0]} and ${range[1]}` : undefined;
  }
  if (typeof value === 'number' ? !Number.isFinite(value) : !NUMERIC.test(value)) {
    return 'expected a number';
  }
  switch (f.dataType) {
    case 'float4':
    case 'float8': {
      // Postgres rejects values that overflow to infinity or underflow to zero.
      const n = f.dataType === 'float4' ? Math.fround(Number(text)) : Number(text);
      return !Number.isFinite(n) || (n === 0 && nonzero(text))
        ? `is out of range for ${f.dataType === 'float4' ? 'real' : 'double precision'}`
        : undefined;
    }
    case 'numeric': {
      const { fraction, exponent } = parts(text);
      return Math.abs(exponent) > NUMERIC_MAX_EXPONENT ||
        integerDigits(text) > NUMERIC_MAX_INTEGER_DIGITS ||
        fraction.length - exponent > NUMERIC_MAX_SCALE
        ? 'is out of range for numeric'
        : undefined;
    }
    case 'money':
      return checkMoney(text);
    default:
      return undefined;
  }
}

/** money is a 64-bit count of cents; Postgres rounds input half up to two decimal places. */
function checkMoney(text: string): string | undefined {
  if (!MONEY.test(text)) return 'expected an amount without an exponent';
  const { whole, fraction } = parts(text);
  let cents = BigInt((whole || '0') + fraction.slice(0, 2).padEnd(2, '0'));
  if ((fraction[2] ?? '0') >= '5') cents++;
  if (text.startsWith('-')) cents = -cents;
  return cents < -(2n ** 63n) || cents > 2n ** 63n - 1n ? 'is out of range for money' : undefined;
}

const DATE = String.raw`\d{4}-\d{2}-\d{2}`;
const TIME = String.raw`\d{2}:\d{2}(:\d{2}(\.\d+)?)?`;
const OFFSET = String.raw`(Z|[+-]\d{2}(:?\d{2})?)`;
// ISO 8601 and Postgres' text output (`2026-01-02 03:04:05.123456+00`), which is how the API
// returns them, so values read from the API can be written back (or filtered on) unchanged.
const TEMPORAL: Record<string, { pattern: RegExp; expected: string }> = {
  date: { pattern: new RegExp(`^${DATE}$`), expected: 'expected a date (YYYY-MM-DD)' },
  timestamp: {
    pattern: new RegExp(`^${DATE}([T ]${TIME}${OFFSET}?)?$`),
    expected: 'expected an ISO 8601 date-time',
  },
  time: { pattern: new RegExp(`^${TIME}${OFFSET}?$`), expected: 'expected a time (HH:MM:SS)' },
};
TEMPORAL.timestamptz = TEMPORAL.timestamp!;
TEMPORAL.timetz = TEMPORAL.time!;

const temporal = (f: Pick<Field, 'dataType'>) => TEMPORAL[f.dataType] ?? TEMPORAL.timestamp!;

/** What a value of `f`'s date/time type looks like, as an error message. */
export const expectedTemporal = (f: Field): string => temporal(f).expected;

/** Error message when `value` isn't a date/time of `f`'s type. */
export function checkTemporal(f: Pick<Field, 'dataType'>, value: string): string | undefined {
  const { pattern, expected } = temporal(f);
  if (!pattern.test(value)) return expected;
  return isRealDateTime(value) ? undefined : 'is not a valid date/time';
}

/**
 * Error message when `value` isn't a timestamptz Postgres can hold, for values that aren't bound
 * for a column (such as search bounds).
 */
export const checkTimestamp = (value: string): string | undefined =>
  checkTemporal({ dataType: 'timestamptz' }, value);

/**
 * Whether the date, time, and offset parts of a format-checked value exist (no February 30th,
 * 25:00, or +16:00).
 */
function isRealDateTime(value: string): boolean {
  const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (date) {
    const [year, month, day] = date.slice(1).map(Number) as [number, number, number];
    // setUTCFullYear, unlike Date.UTC, doesn't map years 0-99 to 1900-1999.
    const daysInMonth = new Date(new Date(0).setUTCFullYear(year, month, 0)).getUTCDate();
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth) return false;
  }
  const time = /(?:^|[T ])(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?/.exec(value);
  if (time) {
    const [hour, minute, second] = [time[1], time[2], time[3] ?? '0'].map(Number) as [
      number,
      number,
      number,
    ];
    // Like Postgres, allow 24:00:00 and a leap second.
    if (minute > 59 || second > 60 || hour > 24 || (hour === 24 && minute + second > 0)) {
      return false;
    }
  }
  // Postgres accepts UTC offsets up to ±15:59.
  const offset = /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?[+-](\d{2}):?(\d{2})?$/.exec(value);
  if (offset && (Number(offset[1]) > 15 || Number(offset[2] ?? 0) > 59)) return false;
  return true;
}

/** Error message when `value` can't be stored in a text column. */
export const checkText = (value: string): string | undefined =>
  // Postgres text can't store NUL bytes.
  value.includes('\0') ? 'cannot contain NUL characters' : undefined;

/** Whether `value` nests deeper than `max`, checked without recursion. */
export function nestsDeeperThan(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (typeof v !== 'object' || v === null) continue;
    if (depth >= max) return true;
    for (const child of Object.values(v)) stack.push([child, depth + 1]);
  }
  return false;
}
