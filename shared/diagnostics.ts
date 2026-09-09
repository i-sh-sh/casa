/**
 * Saying what broke, without saying what anybody spent.
 *
 * Two halves that share one rule. The first reads back a connection string
 * nobody is allowed to read. The second composes the alert that carries it —
 * and decides, for every other kind of failure, how little may go out.
 *
 * They live here rather than in `api/_lib` because they are pure text, and pure
 * text is the half worth testing: `node --test` runs `.ts` directly but does
 * not remap the `.js` specifiers that `api/` uses for the bundler, so anything
 * a test must reach has to be reachable without one. What stays in
 * `api/_lib/alert.ts` is the part that cannot be pure: the token, the fetch,
 * and the rate limit.
 *
 * ---
 *
 * ## Reading back a connection string that nobody is allowed to read
 *
 * `DATABASE_URL` is stored in Vercel as a **Secret**, which is write-only: once
 * saved, its value can never be displayed again, not to the owner, not in the
 * dashboard, nowhere. That is the right default for a password — and it means
 * that when the database answers `28P01` (*password authentication failed*),
 * the one question that matters, "which user, on which host, against which
 * database did we just try?", has no answer anywhere a person can look.
 *
 * An evening went into that gap. `28P01` is returned for a wrong password *and*
 * for a role that does not exist, so the same three characters cover "you
 * mistyped it", "you created the role on a different Neon branch", and "you are
 * pointing at a different project entirely" — and the string that would settle
 * it is unreadable by design. The fix is not to weaken the secret; it is for
 * the process that *does* hold it to say what it is holding, minus the password.
 *
 * So this file parses a connection string the way a person would read it, not
 * the way a URL parser would:
 *
 * - **It is deliberately lenient.** `new URL()` throws, or silently mangles, on
 *   exactly the inputs worth diagnosing — a `/` inside a password ends the
 *   authority section and the rest becomes a path. A parser that fails on a
 *   broken string cannot tell you the string is broken. This one always
 *   produces an answer and *names* the character that will break the strict
 *   parser downstream.
 * - **The password is never a value here.** Only its length and whether it
 *   contains something that will not survive a URL. The point is to make the
 *   secret describable without making it readable.
 */

export interface ConnectionTarget {
  /** `postgres` or `postgresql`, or null when the string does not start with either. */
  scheme: string | null;
  user: string | null;
  host: string | null;
  database: string | null;
  /** Everything after `?`, e.g. `sslmode=require`. */
  params: string | null;
  passwordLength: number;
  /**
   * Characters in the password that end a URL field early, so that the password
   * Postgres receives is not the password that was typed.
   */
  passwordBreaks: string[];
  /** Neon's pooled endpoint. Without it, every function opens a direct connection. */
  pooled: boolean;
  /** What a copy from a console brings with it: quotes, a `psql` prefix, stray whitespace. */
  wrappers: string[];
}

// `:` and `@` are safe: a URL parser takes the *first* `:` as the user/password
// split and the *last* `@` as the credentials/host split, so later ones land in
// the password intact. These three, and whitespace, do not: each one terminates
// the authority section, and everything after it is read as host or path.
const BREAKING = ['/', '?', '#'];

/** Parses without judging. A string too broken to connect still parses here. */
export function readConnectionTarget(raw: string | null | undefined): ConnectionTarget | null {
  if (!raw) return null;

  let s = raw;
  const wrappers: string[] = [];
  if (s !== s.trim()) {
    wrappers.push('רווח בהתחלה או בסוף');
    s = s.trim();
  }
  // `psql 'postgresql://…'` is what Neon's console hands you when the "psql"
  // tab is selected rather than the connection-string one.
  if (/^psql\s+/i.test(s)) {
    wrappers.push('קידומת psql');
    s = s.replace(/^psql\s+/i, '');
  }
  if (s.length >= 2 && ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')))) {
    wrappers.push('גרשיים');
    s = s.slice(1, -1);
  }

  const scheme = /^(postgres(?:ql)?):\/\//i.exec(s)?.[1]?.toLowerCase() ?? null;
  const after = scheme ? s.slice(s.indexOf('://') + 3) : s;

  const at = after.lastIndexOf('@');
  const credentials = at >= 0 ? after.slice(0, at) : '';
  const server = at >= 0 ? after.slice(at + 1) : after;

  const colon = credentials.indexOf(':');
  const user = at < 0 ? null : ((colon >= 0 ? credentials.slice(0, colon) : credentials) || null);
  const password = colon >= 0 ? credentials.slice(colon + 1) : '';

  const slash = server.indexOf('/');
  const host = (slash >= 0 ? server.slice(0, slash) : server) || null;
  const tail = slash >= 0 ? server.slice(slash + 1) : '';
  const question = tail.indexOf('?');
  const database = (question >= 0 ? tail.slice(0, question) : tail) || null;
  const params = question >= 0 ? (tail.slice(question + 1) || null) : null;

  return {
    scheme,
    user,
    host,
    database,
    params,
    passwordLength: password.length,
    passwordBreaks: [...new Set(
      [...password].filter((ch) => BREAKING.includes(ch) || /\s/.test(ch)),
    )],
    pooled: host?.includes('-pooler') ?? false,
    wrappers,
  };
}

/**
 * One line that answers "what did we just try to connect as", plus whatever is
 * visibly wrong with it.
 *
 * Every branch here had to be reachable from a phone at 1am with no terminal,
 * so each note names the thing to change rather than the rule that was broken.
 */
export function summariseConnection(raw: string | null | undefined): string {
  const target = readConnectionTarget(raw);
  if (!target) return 'DATABASE_URL לא מוגדר כלל בסביבה הזו.';

  const address = `${target.user ?? '(בלי משתמש)'}@${target.host ?? '(בלי מארח)'}`
    + `/${target.database ?? '(בלי מסד)'}`
    + (target.params ? `?${target.params}` : '');

  const notes: string[] = [];
  if (!target.scheme) notes.push('⚠ לא מתחיל ב-postgresql://');
  for (const wrapper of target.wrappers) notes.push(`⚠ נגרר בהעתקה: ${wrapper}`);
  if (target.passwordLength === 0) notes.push('⚠ אין סיסמה בכתובת');
  else notes.push(`סיסמה: ${target.passwordLength} תווים`);
  if (target.passwordBreaks.length) {
    // Named, never quoted in context: the character is the diagnosis, the
    // password around it is not ours to repeat.
    notes.push(`⚠ תו שובר בסיסמה: ${target.passwordBreaks.map((c) => (/\s/.test(c) ? 'רווח' : c)).join(' ')}`);
  }
  if (target.host && !target.pooled) notes.push('⚠ המארח בלי -pooler');
  if (!target.params?.includes('sslmode=')) notes.push('⚠ בלי sslmode');

  return `${address}\n${notes.join(' · ')}`;
}

// ---------------------------------------------------------------------------
// ## The alert itself
//
// **What it deliberately does not send: the error message.** Postgres puts row
// values into its errors — a unique violation names the key, a check violation
// names the row — so forwarding the message would forward another couple's
// payees and amounts into a chat. That breaks the promise made to the pilot
// couples in writing («ספירות, לא סכומים») on the exact surface where breaking
// it is hardest to notice. What goes out is the request, the household number,
// and the error's class. The detail stays in the Vercel log, behind an account.
// ---------------------------------------------------------------------------

/**
 * Failures that mean "we never reached the database", rather than "the database
 * said no to this row".
 *
 * These are the only ones for which the connection target is worth sending, and
 * they are also the only ones where it is the entire diagnosis: `28P01` is
 * returned both for a wrong password and for a role that does not exist, so
 * without knowing *which user against which host* it is indistinguishable from
 * having created the role on the wrong Neon branch.
 */
const CONNECTION_CODES = new Set([
  '28P01', '28000', '42501', '3D000',
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET',
]);

/** Telegram is asked for HTML, so anything interpolated has to stop being HTML. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** How a failure is described without describing anybody's data. */
export function describeForAlert(input: {
  method?: string; url?: string; householdId?: number | null; err: unknown;
  /** Defaults to the live value; passed explicitly by the tests. */
  connectionString?: string | null;
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
  const shown = err?.constraint ? ` · ${esc(err.constraint)}` : '';
  const home = input.householdId ? `בית ${input.householdId}` : 'ללא בית';

  const lines = [
    '<b>קאסה · שגיאת שרת</b>',
    `<code>${esc(method)} ${esc(path)}</code>`,
    `${home} · <code>${esc(kind)}</code>${shown}`,
  ];

  // The connection target, and only for a connection failure. It names our own
  // configuration — a role, a hostname, a database — never a row, and it goes
  // to one private chat. Without it, the string it describes is unreadable
  // everywhere: Vercel stores DATABASE_URL as a write-only Secret.
  if (CONNECTION_CODES.has(kind)) {
    const connection = input.connectionString === undefined
      ? process.env.DATABASE_URL ?? null
      : input.connectionString;
    lines.push(
      '',
      '<b>DATABASE_URL שהפונקציה קיבלה</b> — בלי הסיסמה:',
      `<code>${esc(summariseConnection(connection))}</code>`,
    );
  }

  lines.push(
    '',
    'הפרטים בלוג של Vercel — הודעת השגיאה עצמה לא נשלחת לכאן, כי היא עלולה להכיל נתונים של הבית.',
  );

  return { signature, text: lines.join('\n') };
}
