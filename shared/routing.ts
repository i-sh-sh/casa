// Path parsing, with nothing else attached.
//
// It lives here rather than next to the router for the reason everything else
// in shared/ does: it is pure, so it can be tested without a database, a
// request, or a deploy — and this is the one piece of the API whose failure
// mode is total. When it got the path wrong, every endpoint in every module
// returned 404 at once.

export interface RequestShape {
  url?: string | undefined;
  query?: Record<string, string | string[] | undefined> | undefined;
}

/**
 * The path segments a request is asking for, read from the URL itself.
 *
 * This used to trust `req.query.path`, which is what a `[...path]` catch-all is
 * documented to populate. In production it arrived empty — every module route
 * answered "אין נתיב כזה: /" while `api/auth/[action].ts`, an ordinary single
 * dynamic segment, worked fine. Whatever the cause, the URL is ground truth and
 * the framework's parse of it is a convenience; a router that depends on the
 * convenience fails exactly this way: silently, and everywhere at once.
 *
 * `/api/money/bills/3/pay` → `['bills', '3', 'pay']` — drop `api` and the module
 * directory the function is mounted under, keep the rest. Segments are decoded,
 * because `/api/admin/users/a%40b.com` has to arrive as an email address.
 */
export function segmentsOf(req: RequestShape): string[] {
  const pathname = (req.url ?? '').split('?')[0] ?? '';
  const all = pathname.split('/').filter(Boolean).map(decodeSegment);

  if (all[0] === 'api') return all.slice(2);

  // A runtime that hands us an already-stripped path, or none at all.
  const raw = req.query?.['path'];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string' && raw) return raw.split('/').filter(Boolean);
  return all;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape is not worth a 500 — it simply will not match a route.
    return segment;
  }
}

/**
 * Matches one route pattern against a path, capturing `:name` segments.
 *
 * Returns the captured params (possibly empty) on a match, or null. An empty
 * object is a match and `null` is not, so callers must check for null rather
 * than truthiness — `{}` is truthy, which is the trap this note exists for.
 */
export function match(pattern: string, segments: string[]): Record<string, string> | null {
  const parts = pattern.split('/').filter(Boolean);
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    const seg = segments[i] as string;
    if (part.startsWith(':')) {
      params[part.slice(1)] = seg;
      continue;
    }
    if (part !== seg) return null;
  }
  return params;
}

/** Query-string values from the URL, first one wins. `path` is never one of them. */
export function queryOf(req: RequestShape): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (key === 'path') continue;
    out[key] = Array.isArray(value) ? (value[0] ?? '') : String(value ?? '');
  }
  // The URL wins over req.query for the same reason the segments do: one source
  // that is always right beats two that usually agree.
  const url = req.url ?? '';
  const search = url.indexOf('?');
  if (search !== -1) {
    for (const [key, value] of new URLSearchParams(url.slice(search + 1))) {
      if (key === 'path') continue;
      out[key] = value;
    }
  }
  return out;
}
