import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

const { Pool, types } = pg;

// NUMERIC comes back from node-postgres as a string, on purpose: it is
// arbitrary precision and a JS number is not. We parse it to a number anyway,
// once, here — because every amount in this app is shekels with two decimals,
// which is exactly representable, and the alternative is `Number(row.amount)`
// scattered across forty query sites where forgetting it yields "300500"
// instead of 800. Anything that ever needs more than 15 digits of precision
// does not belong in a household budget.
const NUMERIC_OID = 1700;
types.setTypeParser(NUMERIC_OID, (v) => (v === null ? null : Number(v)));

// DATE likewise: pg turns it into a JS Date at local midnight, which in any
// timezone east of UTC is the *previous* day once serialised to JSON. A DATE
// column means a calendar day, so it stays the string Postgres sent.
const DATE_OID = 1082;
types.setTypeParser(DATE_OID, (v) => v);

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set — the app cannot reach its database.');
    }
    // Verified TLS unless the connection string says, in as many words, not to.
    //
    // Neon serves publicly-trusted certificates, and a serverless function
    // talking to its database over an unverified session is a database anyone
    // on the path can read — so this is never relaxed by inference, by an
    // environment name, or by a NODE_ENV check. The only way off is
    // `sslmode=disable` written into the URL, which is the Postgres convention
    // and which a Neon URL never carries: theirs say `sslmode=require`.
    //
    // What it is for: a local Postgres, which speaks no TLS at all, so the
    // isolation tests can run against a real database instead of being skipped.
    const plaintext = /[?&]sslmode=disable(&|$)/.test(connectionString);

    pool = new Pool({
      connectionString,
      ssl: plaintext ? false : { rejectUnauthorized: true },
      // Serverless: many short-lived instances, each holding a few sockets.
      // A high max here exhausts the Neon connection limit under load.
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
    });
  }
  return pool;
}

/**
 * The connection the current request is bound to, if it is inside a household.
 *
 * Row-level security reads `casa.household_id`, and that setting is
 * transaction-local — so every query in a request has to run on the *same*
 * connection, inside the *same* transaction as the `set_config` that scoped it.
 * Taking a fresh connection from the pool mid-request would land on one with no
 * setting at all, where the policy hides every row.
 *
 * Passing that client down through forty call sites would mean forty chances to
 * pass the wrong one. AsyncLocalStorage carries it implicitly instead, so
 * `query` and `one` keep the signatures they had and every existing handler is
 * scoped without being edited.
 */
const scoped = new AsyncLocalStorage<pg.PoolClient>();

/**
 * Binds everything `fn` does to one household.
 *
 * This is the only place a household is ever chosen, and it is called from one
 * place (api/_lib/router.ts). Outside it, a connection carries no household and
 * the policies deny both reads and writes — which is why an endpoint that
 * forgets to scope itself returns nothing rather than everything.
 */
/**
 * Proves that row-level security is actually in force, once per process.
 *
 * This check exists because of how the isolation fails. Row-level security is
 * ignored entirely for a superuser, and for any role holding BYPASSRLS — and
 * when it is ignored, nothing anywhere reports it. Every policy is still
 * listed, every table still says `rowsecurity = true`, every query still
 * succeeds. The only visible symptom is one household reading another's money,
 * which is the symptom we would find out about from a person, not a log.
 *
 * That is not hypothetical: the first run of this migration was tested against
 * a superuser and passed every isolation check by seeing everything.
 *
 * `row_security_active` answers the exact question — is RLS being applied to
 * *this* role, on a table that has it — so a database that cannot enforce the
 * separation refuses to serve instead of quietly serving everyone.
 */
class IsolationError extends Error {
  readonly casaIsolationFailure = true;
}

/**
 * Surfaces the isolation failure to the screen instead of hiding it.
 *
 * Everything unexpected becomes a flat "שגיאת שרת" on purpose — a stack trace
 * in a response body is a disclosure. This is the one exception, and it earns
 * it: the message names the exact misconfiguration and the exact fix, the
 * person reading it is the owner who can act on it, and the alternative is
 * hunting for a generic 500 while the database is unable to keep two
 * households apart. It leaks nothing: it describes our own configuration, not
 * anybody's data.
 */
export function describeIsolationFailure(err: unknown): string | null {
  return (err as { casaIsolationFailure?: boolean } | null)?.casaIsolationFailure
    ? (err as Error).message
    : null;
}

let rlsProven: Promise<void> | undefined;

function proveIsolation(client: pg.PoolClient): Promise<void> {
  rlsProven ??= (async () => {
    const probe = await client.query<{ active: boolean; superuser: boolean }>(
      `SELECT row_security_active('accounts') AS active,
              (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS superuser`,
    );
    const row = probe.rows[0];
    if (!row?.active || row.superuser) {
      rlsProven = undefined; // a transient failure must not poison the process
      throw new IsolationError(
        'ההפרדה בין בתים לא פעילה במסד הנתונים הזה. '
        + `row_security_active=${row?.active} superuser_or_bypassrls=${row?.superuser}. `
        + 'המשמעות היא שבית אחד יכול לקרוא את הנתונים של בית אחר. '
        + 'התחברו למסד בתור תפקיד שאינו superuser ואינו BYPASSRLS, או הריצו את המיגרציה מחדש.',
      );
    }
  })();
  return rlsProven;
}

export async function withHousehold<T>(householdId: number, fn: () => Promise<T>): Promise<T> {
  if (!Number.isInteger(householdId) || householdId <= 0) {
    throw new Error(`withHousehold called with an invalid household: ${householdId}`);
  }
  const client = await getPool().connect();
  try {
    await proveIsolation(client);
    await client.query('BEGIN');
    // set_config, not SET LOCAL: the value is a parameter, and SET LOCAL takes
    // only literals. `true` makes it local to this transaction, so it cannot
    // survive on a pooled connection into somebody else's request.
    await client.query(`SELECT set_config('casa.household_id', $1, true)`, [String(householdId)]);
    const result = await scoped.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* the original error is the one worth throwing */ });
    throw err;
  } finally {
    client.release();
  }
}

/** The household this code is running for, or null outside a scope. Diagnostics only. */
export const currentHouseholdScope = (): boolean => scoped.getStore() !== undefined;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = scoped.getStore() ?? getPool();
  const result = await client.query<T>(text, params as never[]);
  return result.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Runs `fn` inside a transaction, rolling back on any throw.
 *
 * Inside a household scope there is already a transaction open on this
 * request's connection, so this runs on that one rather than checking out a
 * second. Taking a fresh connection here would be the subtlest possible bug:
 * the new one carries no `casa.household_id`, every policy would hide every
 * row, and the symptom would be a handler that silently finds nothing — with
 * no error anywhere to explain it.
 *
 * The nested case therefore does not BEGIN or COMMIT of its own. A throw still
 * unwinds correctly: withHousehold rolls the whole request back.
 */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const ambient = scoped.getStore();
  if (ambient) return await fn(ambient);

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* the original error is the one worth throwing */ });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The one database failure that is not a bug: the schema is behind the code.
 *
 * A deploy ships a new column; the migration that creates it is a button in
 * settings, and somebody has to press it. In between, every request touching
 * that column returns a flat "שגיאת שרת" — true, useless, and identical to the
 * database being down.
 *
 * Postgres names the problem precisely (42703 = undefined_column,
 * 42P01 = undefined_table), so we can too. Everything else stays generic on
 * purpose: an unexpected failure should not be dressed up as a known one.
 */
export function describeDbError(err: unknown): string | null {
  const code = (err as { code?: string } | null)?.code;
  if (code !== '42703' && code !== '42P01') return null;
  const what = code === '42703' ? 'עמודה' : 'טבלה';
  return `מסד הנתונים לא מעודכן לגרסה הזו — חסרה ${what} שהקוד מצפה לה. `
    + 'הריצו את המיגרציה: «הגדרות» ← «מסד הנתונים» ← «הרץ מיגרציה». '
    + 'ההרצה בטוחה לחזור עליה ולא מוחקת שום נתון.';
}
