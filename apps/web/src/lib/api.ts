import type { FieldError } from '@wardenhq/core';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Field errors from a rejected write (400 invalid record, 409 conflict). */
    readonly details: FieldError[] = [],
    /** The parsed error body, for routes that say more than a message. */
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      message?: unknown;
      details?: unknown;
    } | null;
    const message = typeof body?.message === 'string' ? body.message : res.statusText;
    throw new ApiError(
      res.status,
      message || `Request failed (${res.status})`,
      fieldErrors(body?.details),
      body,
    );
  }
  // No Content (e.g. a delete) has no body to parse.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const isUnauthorized = (err: unknown) => err instanceof ApiError && err.status === 401;

/** The `{ field?, message }` entries of an error body's details. */
function fieldErrors(details: unknown): FieldError[] {
  if (!Array.isArray(details)) return [];
  return details.flatMap((d: unknown): FieldError[] => {
    if (typeof d !== 'object' || d === null) return [];
    const { field, message } = d as { field?: unknown; message?: unknown };
    if (typeof message !== 'string') return [];
    return [{ ...(typeof field === 'string' ? { field } : {}), message }];
  });
}
