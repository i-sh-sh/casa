import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOperator, parseOperators } from '../../shared/operators.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
}

const read = (path: string) => code(readFileSync(join(root, path), 'utf8'));

// ── Who is an operator ───────────────────────────────────────────────────

test('the operator list is read leniently, because it is typed by hand', () => {
  // It goes into a Vercel form, at night, on a phone. A list that comes back
  // empty over a trailing comma produces a screen saying "you are not an
  // operator" with nothing to explain it.
  assert.deepEqual(parseOperators('a@x.com, b@y.com'), ['a@x.com', 'b@y.com']);
  assert.deepEqual(parseOperators(' a@x.com ;b@y.com,'), ['a@x.com', 'b@y.com']);
  assert.deepEqual(parseOperators('a@x.com\nb@y.com'), ['a@x.com', 'b@y.com']);
});

test('casing never decides who can see the pilot', () => {
  // Google returns the address as the account was created; a person typing the
  // list into Vercel will not match its casing.
  assert.ok(isOperator('Israel@Example.com', 'israel@example.com'));
  assert.ok(isOperator('israel@example.com', ' Israel@Example.COM '));
});

test('an unset or empty list makes nobody an operator', () => {
  // The failure that matters: an env var missing after a redeploy must close
  // the screen, never open it to everyone.
  for (const raw of [undefined, null, '', '   ', ',,,', 'not-an-email']) {
    assert.equal(isOperator(raw, 'israel@example.com'), false, `opened up on ${JSON.stringify(raw)}`);
  }
});

test('a signed-out request is not an operator', () => {
  assert.equal(isOperator('israel@example.com', null), false);
  assert.equal(isOperator('israel@example.com', ''), false);
});

test('being in one household does not put you in the list', () => {
  assert.equal(isOperator('israel@example.com', 'noa@example.com'), false);
});

// ── What the operator may see ────────────────────────────────────────────

const metrics = read('api/admin/_metrics.ts');

/** Tables holding a household's own data — everything RLS protects. */
const TENANT_TABLES = [
  'accounts', 'category_groups', 'categories', 'budget_allocations',
  'transactions', 'recurring_bills', 'settlements',
  'products', 'stock_entries', 'stock_log', 'shopping_items',
  'sent_notifications',
];

test('every read of a household\'s own tables is an aggregate', () => {
  // The rule this whole file exists to hold: the operator screen answers "is
  // anybody using this" with counts, and never by reading a row. A promise in
  // a comment lasts until somebody is in a hurry; this fails the build.
  //
  // Each `SELECT ... FROM <tenant table>` in the metrics module must select
  // nothing but count()/max()/min(). Anything else — a column, a `*` outside a
  // count, a payee, an amount — is content, and content does not leave a
  // household.
  // Every count here is a subquery — `SELECT (SELECT count(*) FROM accounts)
  // AS accounts, …` — so matching SELECT…FROM greedily reads the *outer*
  // projection and reports a false positive on code that is correct. The
  // projection that governs a table is the nearest SELECT before its FROM.
  const froms = [...metrics.matchAll(/\bFROM\s+(\w+)/gi)];
  assert.ok(froms.length >= 6, `expected the metric queries, found ${froms.length}`);

  const offenders: string[] = [];
  let checked = 0;
  for (const from of froms) {
    const table = from[1]!.toLowerCase();
    if (!TENANT_TABLES.includes(table)) continue;
    checked++;
    const before = metrics.slice(0, from.index);
    const opens = before.toUpperCase().lastIndexOf('SELECT');
    const projection = before.slice(opens + 'SELECT'.length).trim();
    if (!/^(count|max|min)\s*\(/i.test(projection)) {
      offenders.push(`SELECT ${projection} FROM ${table}`);
    }
  }
  assert.ok(checked >= 6, `expected several reads of tenant tables, saw ${checked}`);
  assert.deepEqual(offenders, [], `content selected from a household's tables:\n${offenders.join('\n')}`);

  // A join to a tenant table pulls its columns into the enclosing projection,
  // which the check above cannot see. None is needed here, so none is allowed.
  for (const join of metrics.matchAll(/\bJOIN\s+(\w+)/gi)) {
    assert.ok(
      !TENANT_TABLES.includes(join[1]!.toLowerCase()),
      `the metrics module joins ${join[1]}, a household's own table`,
    );
  }
});

test('no money word appears in the metrics module at all', () => {
  // A blunt second net under the first. These are the column names that carry
  // what a couple spent and where; none of them has any business here.
  for (const word of ['amount', 'payee', 'note', 'balance', 'formatILS']) {
    assert.ok(
      !new RegExp(`\\b${word}\\b`, 'i').test(metrics),
      `"${word}" appears in api/admin/_metrics.ts — the operator screen must carry no content`,
    );
  }
});

test('the counts are taken inside a real household scope, not around it', () => {
  // The tempting shortcut is a GROUP BY across households, which returns
  // nothing (RLS hides every row outside a scope) — and the tempting fix for
  // *that* is a policy exception for operators, which would be a hole in the
  // one mechanism keeping two couples apart, open on every table, for one
  // screen. So the module opens a legitimate scope per home instead.
  assert.match(metrics, /withHousehold\(/);
  assert.ok(
    !/GROUP\s+BY\s+household_id/i.test(metrics),
    'a cross-household GROUP BY means RLS was bypassed somewhere',
  );
});

test('the route is gated on the operator list, not on a household role', () => {
  // `role: 'viewer'` on the route is not the gate: every signed-in member of
  // any home passes that. The gate has to be the operator check, and it has to
  // run before the metrics are gathered.
  const admin = read('api/admin/[...path].ts');
  const route = admin.slice(admin.indexOf("path: 'metrics'"));
  const upToCall = route.slice(0, route.indexOf('pilotMetrics()'));
  assert.match(upToCall, /isOperator\(/, 'metrics are gathered before anyone checks who is asking');
  assert.match(upToCall, /throw forbidden\(\)/);
});

test('the operator flag in the session is a hint, never the authorisation', () => {
  // The screen asks /auth/me whether to offer the section. If that were also
  // what guarded the data, anyone able to alter a response body would have the
  // whole pilot — so the API checks the list again for itself.
  const auth = read('api/auth/[action].ts');
  assert.match(auth, /isOperator\(process\.env\.CASA_OPERATORS/);
  const admin = read('api/admin/[...path].ts');
  assert.match(admin, /isOperator\(process\.env\.CASA_OPERATORS/);
});
