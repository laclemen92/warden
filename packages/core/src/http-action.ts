/** Why an HTTP action may not call `url`, if it may not. */
export function checkActionUrl(url: string, allowHttp: boolean): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'is not a valid URL';
  }
  if (parsed.protocol === 'https:') return undefined;
  if (parsed.protocol !== 'http:') return 'must use https';
  if (allowHttp || isLoopback(parsed.hostname)) return undefined;
  return 'must use https (http is allowed only on loopback, or with WARDEN_ACTION_ALLOW_HTTP=true)';
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Longest API message shown to a user. */
export const MAX_API_MESSAGE_LENGTH = 300;

/**
 * Text from an API made safe to show: tags and control characters removed, whitespace collapsed,
 * and length capped. Undefined when nothing is left.
 */
export function cleanApiMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .slice(0, 10_000)
    .replace(/<[^>]*>?/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > MAX_API_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_API_MESSAGE_LENGTH - 1).trimEnd()}…`
    : text;
}

/**
 * The message an API put in a JSON body: `message`, or `error` when it's text
 * (`{ error: 'Not found' }`), or the first of a `message` list (NestJS validation errors).
 */
export function apiBodyMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return cleanApiMessage(body);
  if (typeof body !== 'object' || body === null) return undefined;
  const { message, error } = body as Record<string, unknown>;
  if (Array.isArray(message)) return cleanApiMessage(message[0]);
  return cleanApiMessage(message) ?? cleanApiMessage(error);
}
