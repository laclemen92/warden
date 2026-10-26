// Reference verifier for requests signed by Warden HTTP actions (`http.auth.type: 'hmac'` or
// `client_credentials`). Copy it into your API; it needs only node:crypto.
// See docs/actions.md#calling-your-api.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export class WardenSignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WardenSignatureError';
  }
}

const header = (headers, name) => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Check a request's Warden signature and return its context: `{ action, auditId, requestId,
 * actor: { subject, email?, userId?, roles }, reason?, records, recordCount }`. Throws a
 * WardenSignatureError when the headers are missing, the timestamp is more than `toleranceSeconds`
 * away from now, or the signature doesn't match the method, host, path, timestamp,
 * Idempotency-Key, context and body.
 *
 * `host` is this API's host as Warden's URL names it (`api.example.com`, or `api.example.com:8443`
 * for a port that isn't the default), from your configuration: never the request's Host header,
 * which the sender chooses. Pass a list when the API answers on several. `path` is the path and
 * query as Warden requested them (Express: `req.originalUrl`), and `rawBody` the body exactly as
 * received (a Buffer or string), before any JSON parsing.
 */
export function verifyWardenRequest({
  secret,
  host,
  method,
  path,
  headers,
  rawBody = '',
  toleranceSeconds = 300,
  now = Date.now(),
}) {
  const hosts = (Array.isArray(host) ? host : [host]).filter(Boolean);
  if (hosts.length === 0) throw new TypeError('verifyWardenRequest needs the API host');
  const context = header(headers, 'x-warden-context');
  const timestamp = header(headers, 'x-warden-timestamp');
  const signature = header(headers, 'x-warden-signature');
  const idempotencyKey = header(headers, 'idempotency-key');
  if (!context || !timestamp || !signature || !idempotencyKey) {
    throw new WardenSignatureError('missing Warden signature headers');
  }
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) {
    throw new WardenSignatureError('stale or invalid timestamp');
  }
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const given = Buffer.from(signature);
  const matches = hosts.some((h) => {
    const payload = [
      'v2',
      method.toUpperCase(),
      h.toLowerCase(),
      path,
      timestamp,
      idempotencyKey,
      context,
      bodyHash,
    ].join('\n');
    const expected = Buffer.from(
      `v2=${createHmac('sha256', secret).update(payload).digest('hex')}`,
    );
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
  if (!matches) throw new WardenSignatureError('signature does not match');
  return JSON.parse(Buffer.from(context, 'base64url').toString('utf8'));
}

/**
 * Express middleware. Register the JSON parser with
 * `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })` so the raw body is kept.
 * `options.host` is required (see verifyWardenRequest). On success `req.warden` holds the context.
 */
export function wardenAuth(secret, options) {
  if (!options?.host) throw new TypeError('wardenAuth needs options.host');
  return (req, res, next) => {
    try {
      req.warden = verifyWardenRequest({
        ...options,
        secret,
        method: req.method,
        path: req.originalUrl,
        headers: req.headers,
        rawBody: req.rawBody ?? '',
      });
      next();
    } catch (err) {
      if (!(err instanceof WardenSignatureError)) return next(err);
      res.status(401).json({ message: 'invalid Warden signature' });
    }
  };
}
