import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
}

const auth = code(readFileSync(join(root, 'api/_lib/auth.ts'), 'utf8'));

/**
 * The first evening decides whether there is a second one.
 *
 * The seed has existed since the first week and was reachable from one place: a
 * button in settings, owners only, labelled «זריעת קטגוריות ומוצרי ברירת מחדל».
 * A couple opening casa for the first time was never going to find it, so what
 * they actually got was every screen empty at once — nothing to budget, no
 * account to hang a transaction on, nothing to shop for.
 *
 * These are read as source rather than run, because api/_lib/auth.ts imports
 * `./db.js` and `../admin/_seed.js` — specifiers the bundler resolves and
 * `node --test` does not. The behaviour itself was verified against a real
 * Postgres 16 with a NOBYPASSRLS role, which is the only way to prove the part
 * that matters: two homes created in a row each see 28 categories, 2 accounts
 * and 15 products, each sees exactly one household's worth, and an unscoped
 * read still sees nothing at all.
 */

test('creating a home furnishes it', () => {
  const create = auth.slice(auth.indexOf('export async function createHousehold'));
  const body = create.slice(0, create.indexOf('\n}'));
  assert.match(body, /furnish\(/, 'a new household is created empty — the seed is never applied');
});

test('the seed runs inside the new household\'s own scope', () => {
  // The failure this prevents is silent and total: outside a scope,
  // `household_id` defaults to NULL, every insert fails the NOT NULL — or, on
  // some future schema, succeeds into nobody's home.
  const furnish = auth.slice(auth.indexOf('async function furnish'));
  assert.match(furnish, /withHousehold\(\s*householdId/);
  assert.match(furnish, /SEED_SQL/);
});

test('a home is still created when the seed fails', () => {
  // The home exists, the person owns it, and the seed is idempotent — every
  // statement is ON CONFLICT DO NOTHING, so the settings button fixes it with
  // one press. Refusing to open a home because we could not pre-fill its
  // shopping list would be the wrong trade in every direction.
  const furnish = auth.slice(auth.indexOf('async function furnish'));
  const body = furnish.slice(0, furnish.indexOf('\n}\n') + 2);
  assert.match(body, /try\s*\{/, 'a seed failure would take the household creation down with it');
  assert.match(body, /catch/);
  assert.ok(!/throw/.test(body), 'furnish rethrows, which fails the creation it is decorating');
});

test('furnishing happens after the household is committed, not inside it', () => {
  // The seed reads `casa.household_id` and writes rows referencing the
  // household row. Running it inside the creating transaction would mean
  // opening a second connection to a household that is not visible from it yet.
  const create = auth.slice(auth.indexOf('export async function createHousehold'));
  const body = create.slice(0, create.indexOf('\n}'));
  const transactionEnds = body.lastIndexOf('});');
  assert.ok(
    body.indexOf('furnish(') > transactionEnds,
    'furnish is called inside the creating transaction',
  );
});

test('the seed itself is idempotent, so furnishing twice is harmless', () => {
  const seed = code(readFileSync(join(root, 'api/admin/_seed.ts'), 'utf8'));
  const inserts = [...seed.matchAll(/INSERT INTO/g)].length;
  const guarded = [...seed.matchAll(/ON CONFLICT[\s\S]*?DO NOTHING/g)].length;
  assert.equal(guarded, inserts, `${inserts} INSERTs but only ${guarded} guarded by ON CONFLICT`);
});
