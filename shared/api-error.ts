/**
 * Turning a failed response into a sentence worth reading.
 *
 * The rule that shapes this file: **our server always answers with JSON that
 * has an `error` field.** Every throw in `api/` goes through `HttpError` and
 * comes back that way. So a failure body that is *not* that shape did not come
 * from our code at all — it came from the platform in front of it, and the one
 * useful thing to say about it is which request it was.
 *
 * That distinction is not academic. A red bar reading «הנתיב המבוקש בשרת לא
 * נמצא» is unactionable: it is not a sentence we wrote, so it cannot be found
 * by searching the source, and it names no request. The same failure described
 * here reads «PATCH /admin/users · 404 · התשובה לא הגיעה מהשרת של קאסה», which
 * points straight at the routing layer and takes a minute instead of an evening.
 */

export interface Failure {
  method: string;
  /** The app-relative path, e.g. `/admin/users` — without the `/api` prefix. */
  path: string;
  /** 0 means the request never left the device. */
  status: number;
  /** The raw response body, as text. */
  text: string;
}

/** How much of a foreign response body is worth quoting back. */
const QUOTE = 120;

export function isOurError(text: string): string | null {
  if (!text) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const message = (parsed as { error?: unknown } | null)?.error;
  return typeof message === 'string' && message ? message : null;
}

/**
 * A body that is HTML, or empty, tells the reader nothing — but the fact that
 * it is HTML tells *us* a great deal, so it is named rather than quoted.
 */
function describeBody(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'התשובה הגיעה ריקה';
  if (/^\s*<(!doctype|html)/i.test(trimmed)) return 'התשובה הייתה עמוד HTML, לא נתונים';
  return trimmed.slice(0, QUOTE).replace(/\s+/g, ' ');
}

export function describeFailure(failure: Failure): string {
  const { method, path, status, text } = failure;

  // Our own sentence wins outright. It was written for this exact case and it
  // already knows more than anything we could reconstruct here.
  const ours = isOurError(text);
  if (ours) return ours;

  if (status === 0) return 'אין חיבור לרשת. הפעולה לא נשמרה.';

  const request = `${method.toUpperCase()} ${path}`;

  // 404 and 405 from outside our code mean the request never reached the
  // function — the platform answered instead. That is a deploy or routing
  // problem, never a data problem, and saying so saves looking in the wrong place.
  if (status === 404 || status === 405) {
    return `${request} · ${status} · הבקשה לא הגיעה לשרת של קאסה. ${describeBody(text)}`;
  }
  if (status >= 500) {
    return `${request} · ${status} · השרת נפל לפני שהספיק לענות. ${describeBody(text)}`;
  }
  return `${request} · ${status} · ${describeBody(text)}`;
}
