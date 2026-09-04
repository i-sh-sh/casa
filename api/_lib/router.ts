import type { VercelRequest, VercelResponse } from '@vercel/node';
import { body as parseBody, handler, json, notFound, HttpError } from './http.js';
import { requireUser, type Role, type SessionUser } from './auth.js';

// Why a router inside a serverless function at all:
//
// Vercel's Hobby plan deploys at most twelve functions. One file per endpoint
// would spend that budget on the money module alone and leave nothing for the
// pantry, so each module is a single catch-all function that dispatches
// internally. The cost is this file; the benefit is that adding an endpoint
// never again means asking whether we can afford one.

export interface Ctx {
  req: VercelRequest;
  res: VercelResponse;
  user: SessionUser;
  /** Named segments from the route pattern, e.g. `:id`. */
  params: Record<string, string>;
  /** Parsed JSON body. Empty object for GET. */
  body: Record<string, unknown>;
  /** Query-string values, first one wins. */
  query: Record<string, string>;
}

export interface RouteDef {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** e.g. 'products', 'products/:id', 'products/:id/stock' */
  path: string;
  /** Minimum role. Defaults to 'member'; read-only routes usually take 'viewer'. */
  role?: Role;
  handle: (ctx: Ctx) => Promise<unknown>;
}

function segmentsOf(req: VercelRequest): string[] {
  // The catch-all gives us `path` as an array; a single-segment match gives a
  // string. Both shapes reach here, so both are handled rather than trusted.
  const raw = (req.query as Record<string, string | string[] | undefined>)['path'];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string' && raw) return raw.split('/').filter(Boolean);
  return [];
}

function match(pattern: string, segments: string[]): Record<string, string> | null {
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

function flatQuery(req: VercelRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (key === 'path') continue;
    out[key] = Array.isArray(value) ? (value[0] ?? '') : String(value ?? '');
  }
  return out;
}

export function router(routes: RouteDef[]) {
  return handler(async (req, res) => {
    const segments = segmentsOf(req);
    const method = (req.method ?? 'GET').toUpperCase();

    let pathMatched = false;
    for (const route of routes) {
      const params = match(route.path, segments);
      if (!params) continue;
      pathMatched = true;
      if (route.method !== method) continue;

      const user = await requireUser(req, route.role ?? 'member');
      const result = await route.handle({
        req,
        res,
        user,
        params,
        body: method === 'GET' ? {} : parseBody(req),
        query: flatQuery(req),
      });
      // A handler that already wrote the response returns undefined.
      if (res.writableEnded) return;
      json(res, method === 'POST' ? 201 : 200, result ?? { ok: true });
      return;
    }

    // A known path with the wrong verb is a 405, not a 404 — the difference
    // matters when the caller is us, debugging at 1am.
    if (pathMatched) {
      const allowed = routes.filter((r) => match(r.path, segments)).map((r) => r.method);
      res.setHeader('allow', allowed.join(', '));
      throw new HttpError(405, `השיטה ${method} לא נתמכת בנתיב הזה`);
    }
    throw notFound(`אין נתיב כזה: /${segments.join('/')}`);
  });
}
