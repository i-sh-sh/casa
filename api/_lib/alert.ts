/**
 * Telling us when something broke, without telling us what somebody spent.
 *
 * The gap this closes: a couple who hits a server error today simply stops
 * using the app, and we find out in the week-three interview — or never. Three
 * weeks of a pilot is the whole pilot.
 *
 * This file is the transport: the token, the fetch, and the rate limit. **What
 * may be said** — and in particular the rule that the error message itself
 * never leaves the server, because Postgres puts row values into it — lives in
 * shared/diagnostics.ts, which a test can reach and this file cannot be.
 *
 * It lives apart from notify.ts so that importing it does not pull `web-push`
 * into every serverless bundle — this is imported by the error path of every
 * single request.
 */

import { describeForAlert } from '../../shared/diagnostics.js';

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID ?? '';

/** Long enough for a slow API, short enough not to hold a failing request open. */
const SEND_TIMEOUT_MS = 3_000;

export async function telegram(text: string): Promise<boolean> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) console.error('telegram failed', res.status, await res.text());
    return res.ok;
  } catch (err) {
    // A notification that fails must never fail the job that triggered it.
    console.error('telegram error', err);
    return false;
  }
}

/**
 * The same failure, over and over, is one piece of news.
 *
 * A phone retrying a broken request every few seconds would otherwise send a
 * hundred messages and make the channel unreadable — which is the same as
 * having no channel. The window is per process and therefore leaky in
 * serverless; it does not have to be exact, only enough to stop a loop.
 */
const seen = new Map<string, number>();
const QUIET_MS = 10 * 60 * 1000;

function fresh(signature: string): boolean {
  const now = Date.now();
  for (const [key, at] of seen) if (now - at > QUIET_MS) seen.delete(key);
  if (seen.has(signature)) return false;
  seen.set(signature, now);
  return true;
}

/**
 * Sends, and resolves when it has. Never rejects, never fails the request.
 *
 * It used to be fire-and-forget, which in a serverless runtime is closer to
 * fire-and-hope: the function returns as soon as the response is written and
 * the instance is frozen, so a `fetch` still in flight is simply abandoned —
 * silently, and most reliably on a fast error path, which is every path here.
 * Awaiting costs an already-failing request a few hundred milliseconds and is
 * bounded by SEND_TIMEOUT_MS; not awaiting costs the message.
 */
export function alertServerError(input: {
  method?: string; url?: string; householdId?: number | null; err: unknown;
}): Promise<void> {
  const { signature, text } = describeForAlert(input);
  if (!fresh(signature)) return Promise.resolve();
  return telegram(text)
    .then(() => { /* sent, or logged as unsent */ })
    .catch(() => { /* the response still has to go out */ });
}
