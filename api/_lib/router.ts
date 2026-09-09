import type { VercelRequest, VercelResponse } from '@vercel/node';
import { body as parseBody, handler, json, notFound, HttpError } from './http.js';
import { requireMigrator, requireUser, type Role, type SessionUser } from './auth.js';
import { withHousehold } from './db.js';
import { match, queryOf, segmentsOf } from '../../shared/routing.js';

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
  /**
   * Runs outside any household scope.
   *
   * Almost nothing should: outside a scope, row-level security hides every
   * tenant row, so an endpoint that sets this by mistake finds an empty
   * database rather than a leak. It exists for the handful of routes that
   * operate on the household list itself.
   */
  unscoped?: boolean;
  /**
   * Runs before any household exists — the migration, and the health check
   * that tells you whether it needs running. Implies `unscoped`, and uses the
   * bootstrap authorisation in auth.ts rather than a membership.
   */
  bootstrap?: boolean;
  handle: (ctx: Ctx) => Promise<unknown>;
}

/** A stand-in for the bootstrap window, where there is no household to be in. */
const NO_HOUSEHOLD: SessionUser = {
  email: '', name: null, picture: null, display_name: null, color: null,
  household_id: 0, household_name: '', role: 'owner',
};

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

      const user = route.bootstrap
        ? { ...NO_HOUSEHOLD, email: await requireMigrator(req) }
        : await requireUser(req, route.role ?? 'member');
      const ctx: Ctx = {
        req,
        res,
        user,
        params,
        body: method === 'GET' ? {} : parseBody(req),
        query: queryOf(req),
      };

      // Everything a handler does runs inside one household, and nothing runs
      // outside one. `withHousehold` opens a transaction, sets the household
      // for its lifetime, and carries the connection to every query through
      // AsyncLocalStorage — so the isolation applies whether or not the handler
      // remembered it exists. The policies live in db/schema.sql, "Households".
      let result: unknown;
      try {
        result = route.unscoped || route.bootstrap
          ? await route.handle(ctx)
          : await withHousehold(user.household_id, () => route.handle(ctx));
      } catch (err) {
        // Which home hit it. The alert in http.ts is raised too far out to know
        // — and "בית 3" is the difference between one couple's broken evening
        // and a bug everybody has. A number, never a name: see _lib/alert.ts.
        if (err && typeof err === 'object') {
          (err as { casaHousehold?: number }).casaHousehold = user.household_id;
        }
        throw err;
      }

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
    // The raw URL goes in the message on purpose. The last time this fired it
    // said "אין נתיב כזה: /" — true, and useless: it named the path it had
    // failed to parse rather than the request it was given.
    console.error('no route', { url: req.url, method, segments });
    throw notFound(`אין נתיב כזה: ${req.url ?? `/${segments.join('/')}`}`);
  });
}
