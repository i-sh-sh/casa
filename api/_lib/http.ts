import type { VercelRequest, VercelResponse } from '@vercel/node';
import { describeDbError, describeIsolationFailure } from './db.js';
import { alertServerError } from './alert.js';

/** An error the user is allowed to read. Anything else becomes a generic 500. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const unauthorized = (msg = 'צריך להתחבר') => new HttpError(401, msg);
export const forbidden = (msg = 'אין לך הרשאה לפעולה הזו') => new HttpError(403, msg);
export const notFound = (msg = 'לא נמצא') => new HttpError(404, msg);
export const conflict = (msg: string) => new HttpError(409, msg);

export function json(res: VercelResponse, status: number, body: unknown): void {
  res.status(status).setHeader('content-type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

type Handler = (req: VercelRequest, res: VercelResponse) => Promise<unknown>;

/**
 * Wraps a handler so that every failure leaves by the same door.
 *
 * Without this, an unhandled rejection in a Vercel function is a 500 with a
 * stack trace in the response body — which is both ugly and a disclosure. With
 * it: HttpError says what it means, a stale-schema error says to run the
 * migration, and everything else is logged server-side and shows one sentence.
 */
export function handler(fn: Handler) {
  return async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        json(res, err.status, { error: err.message });
        return;
      }
      // Every 5xx from here on is paged. An HttpError is the app working — a
      // 404 for a deleted item, a 403 for a viewer — and paging those would
      // bury the one message that means something. Everything below is the app
      // *not* working, and the person who can fix it is not the one looking at
      // the screen.
      //
      // This block used to return before reaching the alert. That is not a
      // hypothetical: naming 28P01 in describeDbError silently switched off the
      // alert for the exact failure that was being diagnosed at the time, and
      // an evening went into wondering why the chat had gone quiet. The order
      // is now: decide the message, page, then answer. See http.test.ts, which
      // reads this file and fails if a 5xx branch ever gets ahead of the page
      // again.
      const page = () => alertServerError({
        method: req.method, url: req.url, err,
        householdId: (err as { casaHousehold?: number } | null)?.casaHousehold ?? null,
      });

      // Before anything else: the database cannot keep two households apart.
      // A generic 500 here would send the owner hunting for a bug in the app.
      const isolation = describeIsolationFailure(err);
      if (isolation) {
        await page();
        json(res, 503, { error: isolation });
        return;
      }
      const dbHint = describeDbError(err);
      if (dbHint) {
        await page();
        json(res, 503, { error: dbHint });
        return;
      }
      console.error('unhandled error', { url: req.url, method: req.method, err });
      await page();
      json(res, 500, { error: 'שגיאת שרת. נסו שוב בעוד רגע.' });
    }
  };
}

/** Refuses anything not in `methods`, and answers CORS preflight for none of them. */
export function methods(req: VercelRequest, res: VercelResponse, allowed: string[]): boolean {
  const method = (req.method ?? 'GET').toUpperCase();
  if (allowed.includes(method)) return true;
  res.setHeader('allow', allowed.join(', '));
  json(res, 405, { error: `השיטה ${method} לא נתמכת כאן` });
  return false;
}

export function body(req: VercelRequest): Record<string, unknown> {
  const raw = req.body;
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      throw badRequest('גוף הבקשה אינו JSON תקין');
    }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}
