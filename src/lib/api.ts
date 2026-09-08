/**
 * The only place the app talks to the server.
 *
 * Two things it guarantees, and nothing else does: every failure arrives as an
 * Error that names the request that produced it, and a 401 anywhere logs the
 * app out instead of leaving a screen half-rendered against a dead session.
 */

import { describeFailure } from '@shared/api-error.js';

export class ApiError extends Error {
  readonly status: number;
  /** The request that failed — kept so anything logging or retrying can name it. */
  readonly method: string;
  readonly path: string;

  constructor(status: number, message: string, method = 'GET', path = '') {
    super(message);
    this.status = status;
    this.method = method;
    this.path = path;
    this.name = 'ApiError';
  }
}

type OnUnauthorized = () => void;
let onUnauthorized: OnUnauthorized = () => {};
export function setUnauthorizedHandler(fn: OnUnauthorized): void {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    // fetch only rejects for network-level failures. Saying "server error"
    // here would be a lie told to somebody standing in a supermarket with no
    // signal, who needs to know it is the connection, not the app.
    throw new ApiError(0, 'אין חיבור לרשת. הפעולה לא נשמרה.', method, path);
  }

  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'צריך להתחבר מחדש', method, path);
  }

  const text = await res.text();

  if (!res.ok) {
    // The message is built here rather than copied out of the body. A response
    // that is not our JSON shape did not come from our code, and the only
    // useful thing to say about it is which request produced it —
    // see shared/api-error.ts for why that matters so much.
    throw new ApiError(res.status, describeFailure({ method, path, status: res.status, text }), method, path);
  }

  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // A 200 that is not JSON means something answered in the function's place.
    // Returning null here would hand a screen an empty list and let it render
    // "הכול רגוע" over a broken deploy.
    throw new ApiError(res.status, describeFailure({ method, path, status: res.status, text }), method, path);
  }
}

function withQuery(path: string, params?: Record<string, string | number | undefined>): string {
  if (!params) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

export const api = {
  get: <T>(path: string, params?: Record<string, string | number | undefined>) => request<T>('GET', withQuery(path, params)),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
