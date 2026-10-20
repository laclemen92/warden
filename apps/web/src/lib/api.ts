export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
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
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof body?.message === 'string' ? body.message : res.statusText;
    throw new ApiError(res.status, message || `Request failed (${res.status})`);
  }
  // No Content (e.g. a delete) has no body to parse.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const isUnauthorized = (err: unknown) => err instanceof ApiError && err.status === 401;
