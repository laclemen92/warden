import type { FastifyBaseLogger, FastifyRequest, FastifyServerOptions } from 'fastify';

const REDACTED = '[redacted]';
// OIDC callback parameters. Codes are single-use and need the client secret and PKCE verifier,
// but still shouldn't end up in log pipelines.
const SECRET_PARAMS = new Set([
  'code',
  'state',
  'session_state',
  'id_token',
  'access_token',
  'refresh_token',
]);

/**
 * `url` as it is safe to log: the whole query string of `/auth/*` routes is dropped, and the
 * values of OIDC parameters are redacted everywhere else.
 */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const path = url.slice(0, q);
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Not a path the router would match; keep it, but not its query.
    return `${path}?${REDACTED}`;
  }
  // The router matches the decoded path, so `/%61uth/callback` is the callback too.
  if (decoded.startsWith('/auth/')) return `${path}?${REDACTED}`;

  const params = new URLSearchParams(url.slice(q + 1));
  let changed = false;
  for (const key of new Set(params.keys())) {
    if (SECRET_PARAMS.has(key.toLowerCase())) {
      params.set(key, REDACTED);
      changed = true;
    }
  }
  return changed ? `${path}?${params.toString()}` : url;
}

// Fastify's default request serializer, with the URL redacted.
const serializeReq = (req: FastifyRequest) => ({
  method: req.method,
  url: redactUrl(req.url),
  host: req.host,
  remoteAddress: req.ip,
  ...(req.socket?.remotePort ? { remotePort: req.socket.remotePort } : {}),
});

type LoggerOption = NonNullable<FastifyServerOptions['logger']>;

/** Logger options whose request logs never include OIDC codes or state. */
export function redactingLogger(logger: LoggerOption): LoggerOption {
  if (logger === false) return logger;
  const options = logger === true ? {} : logger;
  return { ...options, serializers: { ...options.serializers, req: serializeReq } };
}

/**
 * Log unhandled promise rejections instead of letting Node exit on them. Custom action code runs
 * in-process, and a promise it forgot to await (`records.forEach(async ...)`) must not take the
 * server down. The run it belonged to has already failed. Returns a function that stops logging.
 */
export function logUnhandledRejections(
  log: FastifyBaseLogger,
  target: Pick<NodeJS.Process, 'on' | 'off'> = process,
): () => void {
  const listener = (err: unknown) => log.error({ err }, 'unhandled promise rejection');
  target.on('unhandledRejection', listener);
  return () => void target.off('unhandledRejection', listener);
}
