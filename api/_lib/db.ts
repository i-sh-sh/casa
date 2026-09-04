import pg from 'pg';

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
    pool = new Pool({
      connectionString,
      // Neon serves publicly-trusted certificates. Verify them; a serverless
      // function talking to a database over an unverified TLS session is a
      // database anyone on the path can read.
      ssl: { rejectUnauthorized: true },
      // Serverless: many short-lived instances, each holding a few sockets.
      // A high max here exhausts the Neon connection limit under load.
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as never[]);
  return result.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
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
