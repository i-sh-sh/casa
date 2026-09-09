import { after, test } from 'node:test';
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

/**
 * The pool in api/_lib/db.ts is a module singleton, shared by every test here.
 * Closing it inside one test leaves the next with a dead pool — whose errors
 * carry no Postgres code, which once made a check pass for the wrong reason. It
 * is closed exactly once, when the file is done.
 */
after(async () => {
  if (!URL) return;
  const db = await import('../../api/_lib/db.ts');
  await db.getPool().end().catch(() => { /* never opened */ });
});

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

test('the real db layer carries the household through AsyncLocalStorage', options, async () => {
  // Everything above drives Postgres directly. This drives api/_lib/db.ts —
  // because the mechanism that binds a request to a household is not the SQL,
  // it is AsyncLocalStorage carrying one client to every `query` call. If that
  // slips, `query` silently takes a fresh pooled connection with no household
  // on it, and every handler quietly finds nothing.
  process.env['DATABASE_URL'] = URL;
  const db = await import('../../api/_lib/db.ts');

  const client = await freshDatabase();
  try {
    await twoHomes(client);
  } finally {
    await client.end();
  }

  const inFirst = await db.withHousehold(1, async () =>
    (await db.query<{ name: string }>(`SELECT name FROM accounts`)).map((r) => r.name));
  assert.deepEqual(inFirst, ['עובר ושב א']);

  const inSecond = await db.withHousehold(2, async () =>
    (await db.query<{ name: string }>(`SELECT name FROM accounts`)).map((r) => r.name));
  assert.deepEqual(inSecond, ['עובר ושב ב']);

  // Nested `transaction` must reuse the request's client. Taking its own would
  // land on a connection with no household — the subtlest failure in the whole
  // design, because it throws nothing and returns an empty list.
  const nested = await db.withHousehold(1, async () =>
    db.transaction(async (c) => (await c.query(`SELECT name FROM accounts`)).rows.length));
  assert.equal(nested, 1, 'transaction() inside a household took an unscoped connection');

  // An insert that names no household lands in the current one.
  await db.withHousehold(2, () => db.query(`INSERT INTO accounts (name) VALUES ('נוסף')`));
  const after = await db.withHousehold(1, async () =>
    (await db.query(`SELECT name FROM accounts`)).length);
  assert.equal(after, 1, 'a write in one household appeared in another');

  // Outside any scope, the same helpers read nothing.
  assert.deepEqual(await db.query(`SELECT name FROM accounts`), []);

});

test('the upgrade path works on a database that predates households', options, async () => {
  // The deadlock this guards: on the deploy that introduces households nobody
  // belongs to one, so the gate replaces the whole app — including the settings
  // screen holding the migration button. If reading memberships throws on a
  // database that predates them, /auth/me returns 500 and the app never renders
  // far enough to offer the migration that would fix it.
  //
  // api/_lib/auth.ts cannot be imported here: files under api/ use `.js`
  // specifiers that Node's type-stripping does not remap. So this proves the
  // premise its catch depends on — that the missing table raises exactly 42P01
  // — and tenancy.test.ts asserts that the catch is present.
  process.env['DATABASE_URL'] = URL;
  const db = await import('../../api/_lib/db.ts');

  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  await client.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await client.query(`
    CREATE TABLE users (
      email TEXT PRIMARY KEY, name TEXT, picture TEXT,
      role TEXT NOT NULL DEFAULT 'pending', display_name TEXT, color TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ);
    INSERT INTO users (email, name, role) VALUES ('owner@example.com','בעלים','owner');
  `);
  await client.end();

  await assert.rejects(
    db.query(`SELECT 1 FROM household_members`),
    (err: { code?: string }) => {
      assert.equal(err.code, '42P01', 'the missing table must raise undefined_table');
      return true;
    },
  );

  // The health check has to answer on an unmigrated database rather than throw:
  // it is what tells the gate to offer the migration.
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
  assert.ok(!tables.some((t) => t.table_name === 'households'), 'setup is wrong: already migrated');

  // And the migration runs from there and adopts the legacy owner.
  await db.query(readFileSync(join(root, 'db/schema.sql'), 'utf-8'));
  const members = await db.query<{ email: string; role: string }>(
    `SELECT email, role FROM household_members`);
  assert.deepEqual(members, [{ email: 'owner@example.com', role: 'owner' }]);

});

test('the export carries one household only, and reads as Hebrew', options, async () => {
  // The export is the promise «הנתונים שלכם, ואפשר לקחת אותם». An export that
  // quietly carried a neighbour's transactions would break the pilot on its
  // most sensitive surface — a file a person can forward to anyone.
  process.env['DATABASE_URL'] = URL;
  const db = await import('../../api/_lib/db.ts');
  // The sheet definitions, not the handler: files under api/ import each other
  // with `.js` specifiers that Node's type-stripping cannot resolve, which is
  // why the definitions live in shared/ in the first place.
  const { SHEETS, findSheet, BACKUP_TABLES } = await import('../../shared/export-sheets.ts');
  const { toCsv } = await import('../../shared/csv.ts');
  const exportSheet = async (name: string) => ({
    csv: toCsv(await db.query(findSheet(name)!.sql), findSheet(name)!.columns),
  });

  const client = await freshDatabase();
  try {
    await twoHomes(client);
    // twoHomes already gave household 1 a רמי לוי row; this one has a payee
    // that appears nowhere else, so the assertions below are about isolation
    // rather than about the fixture.
    await asHousehold(client, 1, () => client.query(
      `INSERT INTO transactions (occurred_on, account_id, amount, payee)
       SELECT '2026-09-03', id, -243.90, 'מאפיית לחם ארז' FROM accounts`));
    await asHousehold(client, 2, () => client.query(
      `INSERT INTO transactions (occurred_on, account_id, amount, payee)
       SELECT '2026-09-04', id, -999.00, 'סוד של בית ב' FROM accounts`));
  } finally {
    await client.end();
  }

  const first = await db.withHousehold(1, () => exportSheet('transactions'));
  assert.ok(first.csv.includes('מאפיית לחם ארז'), 'the household’s own row is missing');
  assert.ok(!first.csv.includes('סוד של בית ב'), 'the export leaked another household');
  assert.ok(first.csv.startsWith('﻿'), 'no BOM — Excel would mangle the Hebrew');
  assert.ok(first.csv.includes('תאריך,סכום,בית עסק'), 'the header is not in Hebrew');
  // Column headers are names rather than ids, because the person opening this
  // in Excel cannot join to another table.
  assert.ok(first.csv.includes('עובר ושב א'), 'the account name was not joined in');

  const second = await db.withHousehold(2, () => exportSheet('transactions'));
  assert.ok(second.csv.includes('סוד של בית ב'));
  assert.ok(!second.csv.includes('מאפיית לחם ארז'));

  // Every sheet, not just the one with the interesting join.
  for (const sheet of ['budget', 'accounts', 'pantry', 'shopping', 'bills']) {
    const out = await db.withHousehold(1, () => exportSheet(sheet));
    assert.ok(!out.csv.includes('סוד של בית ב'), `${sheet} leaked another household`);
    assert.ok(out.csv.startsWith('﻿'), `${sheet} has no BOM`);
  }

  // And the full backup, which is the one that keeps raw rows.
  const backup = await db.withHousehold(1, async () => {
    const raw: Record<string, { payee?: string }[]> = {};
    for (const table of BACKUP_TABLES) raw[table] = await db.query(`SELECT * FROM ${table}`);
    return raw;
  });
  const payees = backup['transactions']!.map((t) => t.payee).sort();
  assert.deepEqual(payees, ['מאפיית לחם ארז', 'רמי לוי'], 'the backup leaked another household');

  // Every sheet the UI offers must actually run. A renamed column fails here
  // rather than as an empty download three weeks into the pilot.
  for (const sheet of SHEETS) {
    await db.withHousehold(1, () => db.query(sheet.sql));
  }

});

test('replaying an add does not double the quantity', options, async () => {
  // The supermarket case: the request left, the response never came back, and
  // the phone retries. Adding an item that is already on the list *bumps* its
  // quantity, so without the client id this turns two cartons of milk into
  // four — silently, and only noticed at the till or in the pantry.
  const client = await freshDatabase();
  try {
    await twoHomes(client);

    const add = (clientId: string | null, qty: number) => asHousehold(client, 1, async () => {
      // The handler's logic, in the order it runs it.
      if (clientId) {
        const seen = await client.query(`SELECT id FROM shopping_items WHERE client_id = $1`, [clientId]);
        if (seen.rows[0]) return;
      }
      const open = await client.query<{ id: number }>(
        `SELECT id FROM shopping_items WHERE status = 'open' AND product_id IS NULL AND name_key = $1`, ['חלב']);
      if (open.rows[0]) {
        await client.query(
          `UPDATE shopping_items SET qty = qty + $2, client_id = COALESCE($3, client_id) WHERE id = $1`,
          [open.rows[0].id, qty, clientId]);
        return;
      }
      await client.query(
        `INSERT INTO shopping_items (name, name_key, qty, client_id) VALUES ('חלב','חלב',$1,$2)`,
        [qty, clientId]);
    });

    await add('tap-1', 2);
    await add('tap-1', 2);   // the replay
    await add('tap-1', 2);   // and again, because reception is bad

    const qty = await asHousehold(client, 1, async () =>
      (await client.query<{ qty: number }>(`SELECT qty FROM shopping_items WHERE name_key = 'חלב'`)).rows[0]?.qty);
    assert.equal(qty, 2, 'the replay doubled the quantity');

    // A genuinely separate tap still bumps, which is the behaviour we want to
    // keep: two rows of «חלב» is how a list stops being scannable.
    await add('tap-2', 3);
    const after = await asHousehold(client, 1, async () =>
      (await client.query<{ qty: number }>(`SELECT qty FROM shopping_items WHERE name_key = 'חלב'`)).rows[0]?.qty);
    assert.equal(after, 5);

    const rows = await asHousehold(client, 1, async () =>
      (await client.query(`SELECT id FROM shopping_items`)).rows.length);
    assert.equal(rows, 1, 'a second line was created');
  } finally {
    await client.end();
  }
});

test('the same client id in two households is two different items', options, async () => {
  // The uniqueness is per household. Two phones can mint the same id — they are
  // random, but the guarantee has to hold without trusting that.
  const client = await freshDatabase();
  try {
    await twoHomes(client);
    await asHousehold(client, 1, () => client.query(
      `INSERT INTO shopping_items (name, name_key, client_id) VALUES ('לחם','לחם','same')`));
    await asHousehold(client, 2, () => client.query(
      `INSERT INTO shopping_items (name, name_key, client_id) VALUES ('לחם','לחם','same')`));

    for (const home of [1, 2]) {
      const n = await asHousehold(client, home, async () =>
        (await client.query(`SELECT id FROM shopping_items WHERE client_id = 'same'`)).rows.length);
      assert.equal(n, 1, `household ${home} sees the wrong number of items`);
    }
  } finally {
    await client.end();
  }
});

test('a tick replayed after a lost response does not stock twice', options, async () => {
  // This one is safe by accident and must stay that way: the handler matches
  // `status = 'open'`, which a successful first attempt has already cleared.
  const client = await freshDatabase();
  try {
    await twoHomes(client);
    await asHousehold(client, 1, () => client.query(`
      INSERT INTO products (name, name_key, min_qty) VALUES ('חלב 3%','חלב 3%',2);
      INSERT INTO shopping_items (name, name_key, product_id, qty)
        SELECT 'חלב 3%','חלב 3%', id, 2 FROM products;`));

    const buy = () => asHousehold(client, 1, async () => {
      const item = await client.query<{ id: number; product_id: number; qty: number }>(
        `SELECT id, product_id, qty FROM shopping_items WHERE status = 'open'`);
      if (!item.rows[0]) return false;
      await client.query(`UPDATE shopping_items SET status='bought', bought_at=NOW() WHERE id=$1`, [item.rows[0].id]);
      await client.query(`INSERT INTO stock_entries (product_id, qty) VALUES ($1,$2)`,
        [item.rows[0].product_id, item.rows[0].qty]);
      return true;
    });

    assert.equal(await buy(), true);
    assert.equal(await buy(), false, 'the second attempt found something to buy');

    const stocked = await asHousehold(client, 1, async () =>
      (await client.query<{ total: number }>(`SELECT COALESCE(SUM(qty),0)::float AS total FROM stock_entries`)).rows[0]?.total);
    assert.equal(stocked, 2, 'the replay stocked the milk twice');
  } finally {
    await client.end();
  }
});
