import type { VercelRequest, VercelResponse } from '@vercel/node';
import { describeDbError } from './db.js';
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
      const schemaHint = describeDbError(err);
      if (schemaHint) {
        json(res, 503, { error: schemaHint });
        return;
      }
      console.error('unhandled error', { url: req.url, method: req.method, err });
      // Only here, and only for the unexpected. An HttpError is the app working
      // — a 404 for a deleted item, a 403 for a viewer — and paging ourselves
      // for those would bury the one message that means something.
      alertServerError({
        method: req.method, url: req.url, err,
        householdId: (err as { casaHousehold?: number } | null)?.casaHousehold ?? null,
      });
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
