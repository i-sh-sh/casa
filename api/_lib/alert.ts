/**
 * Telling us when something broke, without telling us what somebody spent.
 *
 * The gap this closes: a couple who hits a server error today simply stops
 * using the app, and we find out in the week-three interview — or never. Three
 * weeks of a pilot is the whole pilot.
 *
 * **What it deliberately does not send: the error message.** Postgres puts row
 * values into its errors — a unique violation names the key, a check violation
 * names the row — so forwarding the message would forward another couple's
 * payees and amounts into a chat. That breaks the promise made to them in
 * writing ("ספירות, לא סכומים") on the exact surface where breaking it is
 * hardest to notice. What goes out is the request, the household number, and
 * the error's class. The detail is in the Vercel log, behind an account.
 *
 * It lives apart from notify.ts so that importing it does not pull `web-push`
 * into every serverless bundle — this is imported by the error path of every
 * single request.
 */

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID ?? '';

export async function telegram(text: string): Promise<boolean> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
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

/** How a failure is described without describing anybody's data. */
export function describeForAlert(input: {
  method?: string; url?: string; householdId?: number | null; err: unknown;
}): { signature: string; text: string } {
  const method = (input.method ?? 'GET').toUpperCase();
  // The query string can carry a search term somebody typed. The path cannot.
  const path = (input.url ?? '').split('?')[0] ?? '';
  const err = input.err as { code?: string; name?: string; constraint?: string } | null;
  // A Postgres SQLSTATE, or the error's class. Both are vocabulary, not data.
  const kind = err?.code ?? err?.name ?? 'Error';
  // A constraint name is schema, which we wrote, so it is safe and it is the
  // single most useful word for finding the cause.
  const where = err?.constraint ? ` · ${err.constraint}` : '';

  const signature = `${method} ${path} ${kind}${where}`;
  const home = input.householdId ? `בית ${input.householdId}` : 'ללא בית';
  return {
    signature,
    text: [
      '<b>קאסה · שגיאת שרת</b>',
      `<code>${method} ${path}</code>`,
      `${home} · <code>${kind}</code>${where}`,
      '',
      'הפרטים בלוג של Vercel — הודעת השגיאה עצמה לא נשלחת לכאן, כי היא עלולה להכיל נתונים של הבית.',
    ].join('\n'),
  };
}

/** Fire-and-forget. Never awaited by a request, never able to fail one. */
export function alertServerError(input: {
  method?: string; url?: string; householdId?: number | null; err: unknown;
}): void {
  const { signature, text } = describeForAlert(input);
  if (!fresh(signature)) return;
  void telegram(text).catch(() => { /* the response has already gone out */ });
}
