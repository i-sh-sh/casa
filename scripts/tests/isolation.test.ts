import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import pg from 'pg';

/**
 * The isolation, proved against a real Postgres.
 *
 * Everything in tenancy.test.ts reads source code; none of it can tell you
 * whether one household can actually read another's money. Only a database
 * answers that, so this runs the whole thing: migrate, create two homes, and
 * try to cross between them in every direction.
 *
 * It needs a throwaway database, named by `CASA_TEST_DATABASE_URL`. Without one
 * it skips rather than fails — a contributor with no local Postgres should not
 * be blocked, and the static checks still run. But when a Postgres is present
 * this is the test that matters, and the one to run before touching the schema.
 *
 *   createdb casa_test
 *   CASA_TEST_DATABASE_URL=postgres://localhost/casa_test npm test
 *
 * The role must not be a superuser and must not hold BYPASSRLS — both ignore
 * row-level security entirely. That is not a limitation of the test; it is the
 * single most important thing it checks, and the reason `proveIsolation` exists
 * in api/_lib/db.ts.
 */

const URL = process.env['CASA_TEST_DATABASE_URL'];
const root = resolve(process.cwd());

const options = { skip: URL ? false : 'set CASA_TEST_DATABASE_URL to a throwaway database' };

async function freshDatabase(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  await client.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await client.query(readFileSync(join(root, 'db/schema.sql'), 'utf-8'));
  return client;
}

/** Runs a block inside one household, the way api/_lib/db.ts does. */
async function asHousehold<T>(client: pg.Client, id: number, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('casa.household_id', $1, true)`, [String(id)]);
  try {
    const out = await fn();
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function twoHomes(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO users (email, name) VALUES ('a@example.com','א'), ('b@example.com','ב');
    INSERT INTO households (name) VALUES ('בית א'), ('בית ב');
    INSERT INTO household_members (household_id, email, role)
      VALUES (1,'a@example.com','owner'), (2,'b@example.com','owner');
  `);
  // Note what is *not* written here: household_id. The column default supplies
  // it from the scope, which is what keeps it out of forty insert statements.
  await asHousehold(client, 1, async () => {
    await client.query(`INSERT INTO accounts (name, opening_balance) VALUES ('עובר ושב א', 1000)`);
    await client.query(`INSERT INTO category_groups (name) VALUES ('קבועות')`);
    await client.query(`INSERT INTO transactions (occurred_on, account_id, amount, payee)
                        SELECT CURRENT_DATE, id, -100, 'רמי לוי' FROM accounts`);
  });
  await asHousehold(client, 2, async () => {
    await client.query(`INSERT INTO accounts (name, opening_balance) VALUES ('עובר ושב ב', 2000)`);
    await client.query(`INSERT INTO category_groups (name) VALUES ('קבועות')`);
  });
}

test('the migration runs clean, twice, on an empty database', options, async () => {
  const client = await freshDatabase();
  try {
    // Idempotency is not a nicety here: the migration is a button somebody
    // presses without knowing which half already ran.
    await client.query(readFileSync(join(root, 'db/schema.sql'), 'utf-8'));
    const { rows } = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM households`,
    );
    assert.equal(rows[0]?.count, 0, 'a fresh database must not invent a household');
  } finally {
    await client.end();
  }
});

test('row-level security is actually in force for this role', options, async () => {
  const client = await freshDatabase();
  try {
    const { rows } = await client.query<{ active: boolean; unsafe: boolean }>(
      `SELECT row_security_active('accounts') AS active,
              (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS unsafe`,
    );
    assert.equal(rows[0]?.unsafe, false,
      'this role bypasses RLS, so every isolation check below would pass by seeing everything');
    assert.equal(rows[0]?.active, true, 'RLS is not being applied to this role');
  } finally {
    await client.end();
  }
});

test('an unscoped connection reads nothing at all', options, async () => {
  const client = await freshDatabase();
  try {
    await twoHomes(client);
    // This is the handler that forgot. It gets an empty database, not somebody
    // else's — the failure mode the whole design exists to choose.
    for (const table of ['accounts', 'transactions', 'category_groups', 'products']) {
      const { rows } = await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${table}`);
      assert.equal(rows[0]?.count, 0, `${table} was visible without a household`);
    }
  } finally {
    await client.end();
  }
});

test('each household sees only its own rows', options, async () => {
  const client = await freshDatabase();
  try {
    await twoHomes(client);

    const first = await asHousehold(client, 1, async () =>
      (await client.query<{ name: string }>(`SELECT name FROM accounts`)).rows.map((r) => r.name));
    assert.deepEqual(first, ['עובר ושב א']);

    const second = await asHousehold(client, 2, async () =>
      (await client.query<{ name: string }>(`SELECT name FROM accounts`)).rows.map((r) => r.name));
    assert.deepEqual(second, ['עובר ושב ב']);

    // The transaction belongs to household 1, and household 2 has none.
    const seen = await asHousehold(client, 2, async () =>
      (await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM transactions`)).rows[0]?.count);
    assert.equal(seen, 0);
  } finally {
    await client.end();
  }
});

test('writing into another household is refused, not silently redirected', options, async () => {
  const client = await freshDatabase();
  try {
    await twoHomes(client);

    await assert.rejects(
      asHousehold(client, 1, () =>
        client.query(`INSERT INTO accounts (name, household_id) VALUES ('גניבה', 2)`)),
      /row-level security/,
      'inserting into another household must fail',
    );

    await assert.rejects(
      asHousehold(client, 1, () =>
        client.query(`UPDATE accounts SET household_id = 2`)),
      /row-level security/,
      'moving a row into another household must fail',
    );

    // And the softer version: a household cannot reach another's row to change
    // it at all, so an UPDATE with no WHERE touches only its own.
    const changed = await asHousehold(client, 1, async () =>
      (await client.query(`UPDATE accounts SET name = 'שונה'`)).rowCount);
    assert.equal(changed, 1, 'an unfiltered UPDATE reached beyond one household');

    const other = await asHousehold(client, 2, async () =>
      (await client.query<{ name: string }>(`SELECT name FROM accounts`)).rows[0]?.name);
    assert.equal(other, 'עובר ושב ב', 'the other household was modified');
  } finally {
    await client.end();
  }
});

test('a deleted household takes its data with it', options, async () => {
  const client = await freshDatabase();
  try {
    await twoHomes(client);
    // A couple leaving the pilot asked for their data to be gone. One statement
    // has to be enough, or "we deleted it" is a claim nobody can verify.
    await client.query(`DELETE FROM households WHERE id = 2`);
    const { rows } = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM accounts`,
    );
    assert.equal(rows[0]?.count, 0, 'unscoped, so this counts nothing — but it must not error');

    const left = await asHousehold(client, 1, async () =>
      (await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM accounts`)).rows[0]?.count);
    assert.equal(left, 1, 'deleting one household damaged another');
  } finally {
    await client.end();
  }
});

test('two households may use the same names', options, async () => {
  const client = await freshDatabase();
  try {
    await twoHomes(client);
    // Both wrote a group called «קבועות» in twoHomes. Before household_id
    // joined the unique index, the second one failed with a duplicate key —
    // and the message said nothing about tenancy.
    const groups = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pg_class WHERE relname = 'category_groups_unique_name'`,
    );
    assert.equal(groups.rows[0]?.count, 1);

    // But a duplicate *within* one home is still refused.
    await assert.rejects(
      asHousehold(client, 1, () => client.query(`INSERT INTO category_groups (name) VALUES ('קבועות')`)),
      /duplicate key/,
    );
  } finally {
    await client.end();
  }
});

test('the seed fills each household independently', options, async () => {
  const client = await freshDatabase();
  try {
    await twoHomes(client);
    const { SEED_SQL } = await import('../../api/admin/_seed.ts');

    await asHousehold(client, 2, () => client.query(SEED_SQL));
    const seeded = await asHousehold(client, 2, async () =>
      (await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM categories`)).rows[0]?.count);
    assert.ok((seeded ?? 0) > 20, `expected a full set of categories, got ${seeded}`);

    // Household 1 was never seeded and must still be empty.
    const untouched = await asHousehold(client, 1, async () =>
      (await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM categories`)).rows[0]?.count);
    assert.equal(untouched, 0);
  } finally {
    await client.end();
  }
});

test('an existing single-household database upgrades without losing anything', options, async () => {
  // The path every live database takes exactly once, and the one with no undo.
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);

    // The schema as it stood before households, reduced to what matters here.
    await client.query(`
      CREATE TABLE users (
        email TEXT PRIMARY KEY, name TEXT, picture TEXT,
        role TEXT NOT NULL DEFAULT 'pending', display_name TEXT, color TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ);
      CREATE TABLE accounts (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'bank',
        currency TEXT NOT NULL DEFAULT 'ILS', opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
        color TEXT, sort_order INTEGER NOT NULL DEFAULT 0, archived_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      INSERT INTO users (email, name, role) VALUES
        ('israel@example.com','ישראל','owner'), ('noa@example.com','נעה','member');
      INSERT INTO accounts (name, opening_balance) VALUES ('עובר ושב', 12000);
    `);

    await client.query(readFileSync(join(root, 'db/schema.sql'), 'utf-8'));

    // One home, both people, their roles carried across unchanged.
    const homes = await client.query<{ id: number; name: string }>(`SELECT id, name FROM households`);
    assert.equal(homes.rows.length, 1, 'the upgrade must adopt exactly one household');

    const members = await client.query<{ email: string; role: string }>(
      `SELECT email, role FROM household_members ORDER BY email`);
    assert.deepEqual(members.rows, [
      { email: 'israel@example.com', role: 'owner' },
      { email: 'noa@example.com', role: 'member' },
    ]);

    // And the money is still there, inside that home.
    const home = homes.rows[0]!.id;
    const adopted = await asHousehold(client, home, async () =>
      (await client.query<{ name: string }>(`SELECT name FROM accounts`)).rows.map((r) => r.name));
    assert.deepEqual(adopted, ['עובר ושב'], 'existing data was not adopted into the household');
  } finally {
    await client.end();
  }
});
