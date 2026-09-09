import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(process.cwd());
const schemaRaw = readFileSync(join(root, 'db/schema.sql'), 'utf-8');
/**
 * The schema with its commentary removed.
 *
 * Not fussiness: this file explains itself at length, and prose that quotes SQL
 * — "CREATE TABLE IF NOT EXISTS does nothing to a table that already exists" —
 * matches these patterns and reports a table named "does". Assert on the
 * statements, never on the explanation of them.
 */
const schema = schemaRaw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

/**
 * The separation between households, asserted from the outside.
 *
 * These are static checks on the schema and the API source. They cannot prove
 * the isolation works — only a database can, and isolation.test.ts does that
 * when one is available. What they prove is the part that rots: that the next
 * table someone adds does not quietly arrive without a household, and that the
 * handful of hand-scoped queries stays a handful.
 */

/** The tables the schema itself declares as belonging to one home. */
function tenantTables(): string[] {
  const block = schema.match(/tenant_tables TEXT\[\] :=\s*ARRAY\[([\s\S]*?)\]/);
  assert.ok(block, 'could not find the tenant_tables array in db/schema.sql');
  return [...block[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

/**
 * Tables that deliberately hold no household_id, each for a stated reason.
 *
 * The point of listing them here rather than inferring them: a table added
 * later belongs to exactly one of these two lists, and until someone puts it in
 * one, the test below fails. That is the only mechanism that survives the
 * author forgetting this file exists.
 */
const EXEMPT: Record<string, string> = {
  users: 'a person is not owned by a household',
  households: 'it is the household',
  household_members: 'it is the mapping, and is read before a household is known',
  household_invites: 'read before the invitee belongs to anything',
  push_subscriptions: 'belongs to a device, and reaches a home through its member',
};

test('every table is either scoped to a household or explicitly exempt', () => {
  const declared = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]!);
  const scoped = new Set(tenantTables());

  const unclassified = declared.filter((t) => !scoped.has(t) && !(t in EXEMPT));
  assert.deepEqual(
    unclassified, [],
    `these tables are neither household-scoped nor exempt. Add them to tenant_tables in `
    + `db/schema.sql, or to EXEMPT in this test with the reason why: ${unclassified.join(', ')}`,
  );

  // And the reverse: an exemption for a table that no longer exists is a stale
  // claim that would quietly cover a future table of the same name.
  const stale = Object.keys(EXEMPT).filter((t) => !declared.includes(t));
  assert.deepEqual(stale, [], `EXEMPT names tables that do not exist: ${stale.join(', ')}`);
});

test('every scoped table gets the column, the default, the index and forced RLS', () => {
  // One loop in the schema does all six for every table, so this asserts the
  // loop's body rather than each table — but it asserts all six, because five
  // of them working is a leak.
  assert.match(schema, /ADD COLUMN IF NOT EXISTS household_id INTEGER\s*\n?\s*REFERENCES households\(id\) ON DELETE CASCADE/);
  assert.match(schema, /ALTER COLUMN household_id SET DEFAULT %s/);
  assert.match(schema, /ALTER COLUMN household_id SET NOT NULL/);
  assert.match(schema, /CREATE INDEX IF NOT EXISTS %I ON %I \(household_id\)/);
  assert.match(schema, /ENABLE ROW LEVEL SECURITY/);
  assert.match(schema, /FORCE ROW LEVEL SECURITY/);
  assert.match(schema, /CREATE POLICY casa_household_isolation/);

  // FORCE is not optional and not a detail: without it the role that owns the
  // tables — which is the role the app connects as — bypasses every policy.
  const enable = (schema.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length;
  const force = (schema.match(/FORCE ROW LEVEL SECURITY/g) ?? []).length;
  assert.equal(force, enable, 'every ENABLE ROW LEVEL SECURITY needs a matching FORCE');
});

test('the policy fails closed when no household is set', () => {
  // `current_setting(..., true)` returns NULL rather than raising when unset,
  // and `household_id = NULL` is never true — so an unscoped connection reads
  // nothing instead of everything. The `true` is the whole safety property.
  assert.match(schema, /nullif\(current_setting\(''casa\.household_id'', true\), ''''\)::int/);
  assert.doesNotMatch(
    schema, /current_setting\('casa\.household_id'\)[^,]/,
    'current_setting without the missing_ok argument raises instead of failing closed',
  );
});

test('uniqueness that was global is now per-household', () => {
  // Two homes must both be able to have a category called «סופר». The old
  // constraints are dropped by name, so this also guards against the drop
  // being removed while the new index stays.
  for (const dropped of [
    'category_groups_name_key', 'products_name_key_key',
    'sent_notifications_kind_subject_key_sent_on_key',
  ]) {
    assert.ok(schema.includes(`DROP CONSTRAINT IF EXISTS ${dropped}`), `${dropped} is not dropped`);
  }
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS category_groups_unique_name\s*\n?\s*ON category_groups \(household_id, lower\(name\)\)/);
  assert.match(schema, /ON categories \(household_id, COALESCE\(group_id, -1\), lower\(name\)\)/);
  assert.match(schema, /ON products \(household_id, name_key\)/);
  assert.match(schema, /ON shopping_items \(household_id, name_key\)/);
  assert.match(schema, /ON sent_notifications \(household_id, kind, subject_key, sent_on\)/);
});

test('the seed inserts against conflict targets the schema actually creates', () => {
  // A dropped constraint takes its ON CONFLICT clauses with it, and the failure
  // is at seed time on a real new household — the worst moment to find it.
  const seed = readFileSync(join(root, 'api/admin/_seed.ts'), 'utf-8');
  for (const target of [...seed.matchAll(/ON CONFLICT \(([^)]+)\)/g)].map((m) => m[1]!)) {
    assert.ok(
      target.includes('household_id'),
      `ON CONFLICT (${target}) targets a constraint that is no longer global`,
    );
  }
});

// ── The API side ─────────────────────────────────────────────────────────

/**
 * TypeScript source with its comments removed.
 *
 * This project explains itself at length, and a rule stated in prose — "must
 * not depend on a NODE_ENV check" — matches the pattern that forbids it. Three
 * separate tests here have failed on their own commentary. Assert on code.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

function apiFiles(): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.ts')) out.push({ path: rel, source: readFileSync(join(root, rel), 'utf-8') });
    }
  };
  walk('api');
  return out;
}

test('only the three household-aware files scope by hand', () => {
  // Everywhere else, the policies do it. A `household_id = $n` appearing in a
  // module router means either a query against the three unprotected tables —
  // which belongs here — or a redundant filter that reads as though the
  // isolation were the handler's job.
  const allowed = new Set([
    join('api', '_lib', 'auth.ts'),
    join('api', 'auth', '[action].ts'),
    join('api', 'admin', '[...path].ts'),
    join('api', 'money', '[...path].ts'),   // getBalance, over household_members
  ]);

  const offenders = apiFiles()
    .filter((f) => !allowed.has(f.path))
    .filter((f) => /household_id\s*=\s*\$/.test(f.source))
    .map((f) => f.path);

  assert.deepEqual(
    offenders, [],
    `these files scope by hand; either they query households/household_members/household_invites `
    + `(and belong in the allowed list, with a comment saying so) or the filter is redundant: ${offenders.join(', ')}`,
  );
});

test('no handler takes its own connection', () => {
  // A fresh connection from the pool carries no casa.household_id, so every
  // policy hides every row on it. The symptom is a handler that silently finds
  // nothing, with no error anywhere — which is why this is a test and not a
  // comment. `migrate` is the exception: it runs DDL, before any household.
  const offenders = apiFiles()
    .filter((f) => f.path !== join('api', 'admin', '[...path].ts'))  // migrate: DDL, before any household
    .filter((f) => f.path !== join('api', '_lib', 'db.ts'))          // where the scoping itself is built
    .filter((f) => f.source.includes('getPool().connect()'))
    .map((f) => f.path);
  assert.deepEqual(offenders, [], `these take an unscoped connection: ${offenders.join(', ')}`);
});

test('the household scope is opened in exactly two places', () => {
  const callers = apiFiles()
    .filter((f) => /withHousehold\(/.test(f.source))
    .map((f) => f.path)
    .sort();
  assert.deepEqual(callers, [
    join('api', '_lib', 'router.ts'),    // every request
    join('api', 'cron', 'daily.ts'),     // no signed-in person, so it walks the homes itself
  ].sort());
});

test('the runtime refuses a database where RLS would be ignored', () => {
  // The mechanism's failure mode is silence: for a superuser, or any role with
  // BYPASSRLS, every policy is listed and none applies. Nothing logs it. The
  // only symptom is one household reading another's money.
  const db = readFileSync(join(root, 'api/_lib/db.ts'), 'utf-8');
  assert.match(db, /row_security_active\('accounts'\)/);
  assert.match(db, /rolsuper OR rolbypassrls/);
  assert.match(db, /throw new Error\(/);
});

test('nothing but the bootstrap reads the old global users.role', () => {
  const offenders = apiFiles()
    .filter((f) => f.path !== join('api', '_lib', 'auth.ts'))
    // The legacy shapes specifically: reading a role off `users`, or writing
    // one there. A join to `users` beside `household_members.role` is correct
    // and must not trip this.
    .filter((f) => /FROM users WHERE role|UPDATE users SET role|\busers\.role\b/.test(f.source))
    .map((f) => f.path);
  assert.deepEqual(
    offenders, [],
    `the authoritative role is household_members.role — users.role is legacy: ${offenders.join(', ')}`,
  );
});

test('TLS is only ever relaxed by an explicit sslmode=disable', () => {
  // The database holds other couples' salaries. Verified TLS must not be
  // switchable by an environment name, a NODE_ENV check, or a hostname guess —
  // only by the connection string saying so in as many words, which a Neon URL
  // never does.
  const db = code(readFileSync(join(root, 'api/_lib/db.ts'), 'utf-8'));
  assert.match(db, /sslmode=disable/);
  assert.match(db, /rejectUnauthorized: true/);
  assert.doesNotMatch(
    db, /NODE_ENV|localhost|127\.0\.0\.1/,
    'TLS verification must not depend on guessing the environment',
  );
});

test('reading memberships survives a database that predates households', () => {
  // /auth/me calls membershipsOf before anything else. On the deploy that
  // introduces households the tables do not exist yet, and an uncaught 42P01
  // there returns 500 for every request — so the app never renders far enough
  // to show the migration button that would end the state. The live half of
  // this (that the missing table raises exactly 42P01) is in isolation.test.ts.
  const auth = code(readFileSync(join(root, 'api/_lib/auth.ts'), 'utf-8'));
  const fn = auth.slice(auth.indexOf('export async function membershipsOf'));
  assert.match(fn.slice(0, 700), /42P01/, 'membershipsOf must tolerate the tables not existing yet');
});

test('an isolation failure reaches the screen instead of becoming a generic 500', () => {
  // Everything unexpected becomes "שגיאת שרת" on purpose. This is the one
  // exception and it earns it: the message names the exact misconfiguration and
  // the exact fix, the person reading it is the owner who can act on it, and
  // the alternative is hunting for a bug in the app while the database is
  // unable to keep two households apart.
  const db = code(readFileSync(join(root, 'api/_lib/db.ts'), 'utf-8'));
  const http = code(readFileSync(join(root, 'api/_lib/http.ts'), 'utf-8'));
  assert.match(db, /casaIsolationFailure/);
  assert.match(db, /export function describeIsolationFailure/);
  assert.match(http, /describeIsolationFailure\(err\)/);
  // And ahead of the schema hint, which would otherwise claim the response
  // first for a database that is migrated but unsafe.
  assert.ok(
    http.indexOf('describeIsolationFailure(err)') < http.indexOf('describeDbError(err)'),
    'the isolation check must be tested before the schema check',
  );
});
