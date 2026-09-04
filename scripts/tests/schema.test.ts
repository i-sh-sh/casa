import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { toModule } from '../build-schema.ts';
import { SCHEMA_SQL } from '../../db/schema.ts';
import { SEED_SQL } from '../../api/admin/_seed.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The schema with its prose removed.
 *
 * These assertions are about the DDL, and the file is more comment than DDL.
 * Matching the raw text made "never float" in a comment fail a test that was
 * checking for float columns — the assertion was right and the input was wrong.
 */
const ddl = (sql: string): string => sql.replace(/--[^\n]*/g, '');

test('db/schema.ts is not stale', () => {
  // The failure this guards against is silent and nasty: somebody edits the
  // .sql, deploys, presses "run migration", and gets the old schema — because
  // the migration imports the .ts.
  const sql = readFileSync(join(root, 'db', 'schema.sql'), 'utf8');
  const onDisk = readFileSync(join(root, 'db', 'schema.ts'), 'utf8');
  assert.equal(onDisk, toModule(sql), 'run `npm run schema:build` and commit db/schema.ts');
});

test('every statement in the schema is safe to run twice', () => {
  // The migration is a button pressed by a person who cannot know which half
  // already ran. Anything that is not idempotent turns that button into a trap.
  const sql = ddl(SCHEMA_SQL);
  const creates = sql.match(/^\s*CREATE TABLE(?! IF NOT EXISTS)/gim) ?? [];
  assert.deepEqual(creates, [], 'every CREATE TABLE needs IF NOT EXISTS');
  const indexes = sql.match(/^\s*CREATE (UNIQUE )?INDEX(?! IF NOT EXISTS)/gim) ?? [];
  assert.deepEqual(indexes, [], 'every CREATE INDEX needs IF NOT EXISTS');
  assert.equal(/\bDROP TABLE\b/i.test(sql), false, 'a migration must never drop a table');
});

test('the tables the app actually reads all exist in the schema', () => {
  const expected = [
    'users', 'accounts', 'category_groups', 'categories', 'budget_allocations',
    'transactions', 'recurring_bills', 'settlements', 'products', 'stock_entries',
    'stock_log', 'shopping_items', 'push_subscriptions', 'sent_notifications',
  ];
  for (const table of expected) {
    assert.ok(
      SCHEMA_SQL.includes(`CREATE TABLE IF NOT EXISTS ${table} (`),
      `schema is missing table ${table}`,
    );
  }
});

test('money columns are NUMERIC, never floating point', () => {
  // One REAL or DOUBLE PRECISION column is all it takes for a budget to stop
  // adding up to itself.
  assert.equal(/\b(REAL|DOUBLE PRECISION|FLOAT)\b/i.test(ddl(SCHEMA_SQL)), false);
});

test('the shopping list cannot list the same product twice', () => {
  // This partial index is load-bearing: without it the nightly sync re-adds
  // milk every morning until somebody shops.
  assert.ok(SCHEMA_SQL.includes("ON shopping_items (product_id) WHERE status = 'open'"));
});

test('the seed only inserts, and never overwrites', () => {
  assert.equal(/\b(UPDATE|DELETE|DROP|TRUNCATE)\b/i.test(ddl(SEED_SQL)), false);
  const inserts = SEED_SQL.match(/INSERT INTO/g) ?? [];
  const guards = SEED_SQL.match(/ON CONFLICT/g) ?? [];
  assert.equal(inserts.length, guards.length, 'every seed INSERT needs an ON CONFLICT guard');
});

test('the seed uses the same normalised keys the app generates', async () => {
  // A seeded product whose name_key does not match what normalizeName() would
  // produce is a product the app can never find again — adding "קוטג׳" to the
  // list would silently create a second one.
  const { normalizeName } = await import('../../shared/pantry.ts');
  const rows = [...SEED_SQL.matchAll(/\('([^']+)',\s*'([^']+)',\s*'[^']*',\s*'(?:פירות|חלב|בשר|לחם|יבשים|קפואים|משקאות|חטיפים|ניקיון|טואלטיקה|כללי)/g)];
  assert.ok(rows.length > 0, 'expected to find seeded products');
  for (const [, name, key] of rows) {
    assert.equal(key, normalizeName(name!), `name_key for ${name} does not match normalizeName()`);
  }
});
