/**
 * The only place the app talks to the server.
 *
 * Two things it guarantees, and nothing else does: every failure arrives as an
 * Error with the server's own Hebrew sentence in it, and a 401 anywhere logs
 * the app out instead of leaving a screen half-rendered against a dead session.
 */

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
    throw new ApiError(0, 'אין חיבור לרשת. הפעולה לא נשמרה.');
  }

  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'צריך להתחבר מחדש');
  }

  const text = await res.text();
  const payload: unknown = text ? safeParse(text) : null;

  if (!res.ok) {
    const message = (payload as { error?: string } | null)?.error;
    throw new ApiError(res.status, message ?? `שגיאה ${res.status}`);
  }
  return payload as T;
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return { error: text.slice(0, 200) }; }
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
