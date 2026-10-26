export interface WardenContext {
  action: string;
  auditId: string;
  requestId: string;
  actor: { subject: string; email?: string; userId?: string; roles: string[] };
  reason?: string;
  records: string[];
  recordCount: number;
}

export class WardenSignatureError extends Error {}

export function verifyWardenRequest(options: {
  secret: string;
  /** This API's host as Warden's URL names it, from configuration, never the Host header. */
  host: string | readonly string[];
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: string | Uint8Array;
  toleranceSeconds?: number;
  now?: number;
}): WardenContext;

export function wardenAuth(
  secret: string,
  options: { host: string | readonly string[]; toleranceSeconds?: number },
): (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
