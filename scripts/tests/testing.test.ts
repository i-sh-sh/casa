import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { register } from 'node:module';
import pg from 'pg';
import {
  PERSONAS, TEST_DOMAIN, coupleFixture, isTestEmail, monthStart, personaByEmail, personaByKey,
} from '../../shared/testing.ts';
import { SEED_SQL } from '../../api/admin/_seed.ts';

/**
 * The test people: that they can never be anybody real, that their home is a
 * believable one, and — against a real Postgres when there is one — that a
 * reset wipes only what it should and that stepping in and back works.
 */

const root = resolve(process.cwd());
const code = (path: string): string => readFileSync(join(root, path), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// ── Who they are ─────────────────────────────────────────────────────────

test('every test person lives on a domain nobody can sign in from', () => {
  // `.invalid` is reserved (RFC 2606): Google cannot issue an account there,
  // so no real sign-in ever arrives as one of these people.
  assert.equal(TEST_DOMAIN.split('.').pop(), 'invalid');
  for (const p of PERSONAS) {
    assert.ok(p.email.endsWith(`@${TEST_DOMAIN}`), p.email);
    assert.ok(isTestEmail(p.email));
  }
  assert.equal(new Set(PERSONAS.map((p) => p.email)).size, PERSONAS.length);
});

test('a real address is never mistaken for a test one', () => {
  assert.equal(isTestEmail('shshteinberg@gmail.com'), false);
  assert.equal(isTestEmail(`someone@${TEST_DOMAIN}.com`), false);
  assert.equal(isTestEmail(`someone@not${TEST_DOMAIN}`), false);
  assert.equal(isTestEmail(null), false);
  assert.equal(isTestEmail(`Dana@${TEST_DOMAIN.toUpperCase()}`), true);
});

test('a persona is chosen by key, never by an address from the request', () => {
  assert.equal(personaByKey('dana')?.email, `dana@${TEST_DOMAIN}`);
  assert.equal(personaByKey(`dana@${TEST_DOMAIN}`), null);
  assert.equal(personaByKey('shshteinberg@gmail.com'), null);
  assert.equal(personaByKey(undefined), null);
  assert.equal(personaByEmail('shshteinberg@gmail.com'), null);

  // The route itself: it reads `persona` from the body and nothing else.
  const auth = code('api/auth/[action].ts');
  const stepIn = auth.slice(auth.indexOf('async function stepIn'), auth.indexOf('async function stepBack'));
  assert.match(stepIn, /personaByKey\(parseBody\(req\)\['persona'\]\)/);
  assert.doesNotMatch(stepIn, /\['email'\]/, 'stepping in must not take an address from the request');
  assert.match(stepIn, /signSession\(persona\.email\)/);
});

test('stepping in is checked against CASA_OPERATORS on every call', () => {
  const auth = code('api/auth/[action].ts');
  const operatorOf = auth.slice(auth.indexOf('function operatorOf'), auth.indexOf('async function stepIn'));
  assert.equal((operatorOf.match(/isOperator\(operators,/g) ?? []).length, 2,
    'both the parked session and the live one must be checked against the operator list');
});

test('a reset deletes only by the test domain', () => {
  // Hard deletes are the exception in this codebase; they are allowed here
  // only because every one of them is fenced by the `.invalid` address.
  const testing = code('api/admin/_testing.ts');
  const deletes = [...testing.matchAll(/DELETE FROM [^`]+`, \[([^\]]+)\]/g)];
  assert.ok(deletes.length >= 3, 'expected the reset deletes');
  for (const [statement, params] of deletes) {
    assert.match(statement, /LIKE \$1/, statement);
    assert.equal(params?.trim(), 'TEST_ADDRESSES', statement);
  }
  assert.match(testing, /const TEST_ADDRESSES = `%@\$\{TEST_DOMAIN\}`/);
});

// ── Their home ───────────────────────────────────────────────────────────

const seededCategories = new Set(
  [...SEED_SQL.matchAll(/\('[^']+', '([^']+)', '(?:spending|income|saving)'/g)].map((m) => m[1]!),
);
const seededProducts = new Set(
  [...SEED_SQL.matchAll(/\('[^']+',\s+'([^']+)',\s+'[^']+',\s+'[^']+',\s+0,/g)].map((m) => m[1]!),
);

for (const today of ['2026-10-08', '2026-10-01', '2026-10-31', '2026-03-31', '2028-02-29', '2027-01-03']) {
  test(`the couple's two months make sense on ${today}`, () => {
    const f = coupleFixture(today);
    const from = monthStart(today, 1);

    assert.ok(f.transactions.length > 20, 'two months should be more than a handful of lines');
    for (const t of f.transactions) {
      assert.ok(t.occurred_on <= today, `${t.payee} is in the future: ${t.occurred_on}`);
      assert.ok(t.occurred_on >= from, `${t.payee} is before last month: ${t.occurred_on}`);
      assert.match(t.occurred_on, /^\d{4}-\d{2}-\d{2}$/);
      assert.notEqual(t.amount, 0);
      assert.equal(Math.round(t.amount * 100) / 100, t.amount, `${t.amount} has more than two decimals`);
      // Income is positive and only income is: the sign is the whole type.
      assert.equal(t.amount > 0, t.category === 'משכורת', `${t.payee} has the wrong sign`);
      if (t.category) assert.ok(seededCategories.has(t.category), `not a seeded category: ${t.category}`);
      if (t.installment_no) assert.ok(t.installment_no <= t.installments_total!);
    }
    assert.ok(f.transactions.some((t) => t.category === null), 'one line should be waiting to be filed');

    for (const a of f.allocations) assert.ok(seededCategories.has(a.category), a.category);
    assert.deepEqual([...new Set(f.allocations.map((a) => a.month))], [monthStart(today, 1), monthStart(today, 0)]);
    for (const r of f.recurring) assert.ok(r.next_due > today, `${r.name} is due in the past`);
    for (const s of f.stock) assert.ok(seededProducts.has(s.product), `not a seeded product: ${s.product}`);
    for (const key of Object.keys(f.minimums)) assert.ok(seededProducts.has(key), key);
  });
}

test('the seed parse above actually found the seed', () => {
  assert.ok(seededCategories.size > 20);
  assert.ok(seededProducts.size >= 15);
});

// ── Against a real database ──────────────────────────────────────────────

/**
 * Its own schema in the throwaway database, because node runs test files in
 * parallel and isolation.test.ts drops `public` at the start of every test.
 * Sharing it made both files fail at random.
 */
const SCHEMA = 'casa_test_people';
const BASE_URL = process.env['CASA_TEST_DATABASE_URL'];
const URL = BASE_URL
  ? `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`
  : undefined;
const options = { skip: URL ? false : 'set CASA_TEST_DATABASE_URL to a throwaway database' };

// auth.ts reads JWT_SECRET once, when it is first imported — so before any test
// here imports it.
process.env['JWT_SECRET'] = 'a-test-secret-that-is-long-enough-for-hmac';
process.env['CASA_OPERATORS'] = 'operator@example.com';

/**
 * The API imports its siblings as `./db.js`, which is right for the bundle and
 * wrong for Node running the .ts sources directly. The other database tests
 * never import anything that does; these import the auth handler, so they
 * teach the resolver the one fallback it needs.
 */
if (URL) {
  register(`data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      try { return await next(specifier, context); }
      catch (err) {
        if (err?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js')) {
          return next(specifier.slice(0, -3) + '.ts', context);
        }
        throw err;
      }
    }
  `)}`);
}

after(async () => {
  if (!URL) return;
  const db = await import('../../api/_lib/db.ts');
  await db.getPool().end().catch(() => { /* never opened */ });
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).finally(() => client.end());
});

const OPERATOR = 'operator@example.com';
const REAL = 'real@example.com';

async function freshDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    await client.query(readFileSync(join(root, 'db/schema.sql'), 'utf-8'));
    await client.query(`INSERT INTO users (email) VALUES ($1), ($2)`, [OPERATOR, REAL]);
  } finally {
    await client.end();
  }
}

test('a rebuild fills the couple and leaves real homes alone', options, async () => {
  process.env['DATABASE_URL'] = URL;
  await freshDatabase();
  const db = await import('../../api/_lib/db.ts');
  const auth = await import('../../api/_lib/auth.ts');
  const { rebuildTestHomes } = await import('../../api/admin/_testing.ts');

  const real = await auth.createHousehold('הבית האמיתי', REAL);
  await db.withHousehold(real.household_id, () =>
    db.query(`INSERT INTO transactions (occurred_on, account_id, amount) VALUES (CURRENT_DATE, (SELECT min(id) FROM accounts), -10)`));

  const first = await rebuildTestHomes();
  assert.equal(first.built, true);
  const dana = first.personas.find((p) => p.key === 'dana')!;
  assert.equal(dana.homes.length, 1);
  assert.deepEqual(first.personas.find((p) => p.key === 'noa')!.homes, []);

  // A test person opens a home, and is invited into the real one.
  const noa = PERSONAS.find((p) => p.key === 'noa')!;
  await auth.createHousehold('הבית של נועה', noa.email);
  await db.query(`INSERT INTO household_members (household_id, email, role) VALUES ($1, $2, 'member')`,
    [real.household_id, noa.email]);

  const second = await rebuildTestHomes();
  assert.deepEqual(second.personas.find((p) => p.key === 'noa')!.homes, [], 'noa should be homeless again');

  const homes = await db.query<{ name: string }>(`SELECT name FROM households ORDER BY id`);
  assert.equal(homes.length, 2, 'the real home and one rebuilt couple, nothing left over');
  assert.equal(homes[0]!.name, 'הבית האמיתי');

  const realLeft = await db.withHousehold(real.household_id, async () =>
    (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM transactions`))!.n);
  assert.equal(realLeft, 1, 'the real home lost data in a reset');

  const coupleId = (await db.one<{ household_id: number }>(
    `SELECT household_id FROM household_members WHERE email = $1`, [`dana@${TEST_DOMAIN}`]))!.household_id;
  const counts = await db.withHousehold(coupleId, () => db.one<Record<string, number>>(
    `SELECT (SELECT count(*)::int FROM transactions)                      AS transactions,
            (SELECT count(*)::int FROM accounts WHERE kind = 'credit')    AS cards,
            (SELECT count(*)::int FROM budget_allocations)                AS allocations,
            (SELECT count(*)::int FROM stock_entries)                     AS stock,
            (SELECT count(*)::int FROM shopping_items WHERE source = 'auto_min_stock') AS auto_items,
            (SELECT count(*)::int FROM transactions WHERE category_id IS NULL) AS unfiled`,
  ));
  assert.ok(counts!['transactions']! > 20);
  assert.equal(counts!['cards'], 2);
  assert.ok(counts!['allocations']! > 20);
  assert.equal(counts!['stock'], coupleFixture('2026-10-08').stock.length);
  assert.ok(counts!['auto_items']! > 0, 'the staples below minimum should already be on the list');
  assert.equal(counts!['unfiled'], 1);
});

/** Just enough of a Vercel request and response to drive the auth handler. */
function call(action: string, opts: { cookies?: Record<string, string>; body?: unknown } = {}) {
  const headers: Record<string, unknown> = {};
  const res = {
    statusCode: 0, sent: '',
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: unknown) { headers[name.toLowerCase()] = value; return this; },
    getHeader(name: string) { return headers[name.toLowerCase()]; },
    send(body: string) { this.sent = body; return this; },
  };
  const req = {
    method: 'POST',
    url: `/api/auth/${action}`,
    query: { action },
    headers: { cookie: Object.entries(opts.cookies ?? {}).map(([k, v]) => `${k}=${v}`).join('; ') },
    body: opts.body ?? {},
  };
  const cookies = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const c of (headers['set-cookie'] as string[] | undefined) ?? []) {
      const [pair] = c.split(';');
      const eq = pair!.indexOf('=');
      out[pair!.slice(0, eq)] = pair!.slice(eq + 1);
    }
    return out;
  };
  return { req, res, cookies };
}

test('the operator steps in, switches, and steps back to themselves', options, async () => {
  process.env['DATABASE_URL'] = URL;
  const auth = await import('../../api/_lib/auth.ts');
  const { default: route } = await import('../../api/auth/[action].ts');
  const { rebuildTestHomes } = await import('../../api/admin/_testing.ts');
  await rebuildTestHomes();

  const operatorSession = auth.signSession(OPERATOR);

  // In as dana.
  const asDana = call('test-as', { cookies: { casa_session: operatorSession }, body: { persona: 'dana' } });
  await route(asDana.req as never, asDana.res as never);
  assert.equal(asDana.res.statusCode, 200, asDana.res.sent);
  const c1 = asDana.cookies();
  assert.equal(auth.verifySession(c1['casa_session']!)?.email, `dana@${TEST_DOMAIN}`);
  assert.equal(c1['casa_return'], operatorSession, 'the operator session must be parked');

  // The banner knows.
  const me = call('me', { cookies: { casa_session: c1['casa_session']!, casa_return: c1['casa_return']! } });
  me.req.method = 'GET';
  await route(me.req as never, me.res as never);
  const meBody = JSON.parse(me.res.sent) as { testing: { persona: string } | null; user: { household_name: string } };
  assert.equal(meBody.testing?.persona, 'dana');
  assert.match(meBody.user.household_name, /דנה ויואב/);

  // From dana straight to omer: the parked session is still the operator's.
  const asOmer = call('test-as', { cookies: { casa_session: c1['casa_session']!, casa_return: c1['casa_return']! }, body: { persona: 'omer' } });
  await route(asOmer.req as never, asOmer.res as never);
  assert.equal(asOmer.res.statusCode, 200, asOmer.res.sent);
  const c2 = asOmer.cookies();
  assert.equal(auth.verifySession(c2['casa_session']!)?.email, `omer@${TEST_DOMAIN}`);
  assert.equal(c2['casa_return'], operatorSession);

  // And back.
  const back = call('test-back', { cookies: { casa_session: c2['casa_session']!, casa_return: c2['casa_return']! } });
  await route(back.req as never, back.res as never);
  assert.equal(back.res.statusCode, 200, back.res.sent);
  assert.equal(back.cookies()['casa_session'], operatorSession);
  assert.equal(back.cookies()['casa_return'], '', 'the parked session must be cleared');
});

test('nobody but an operator can step in, and only into a test person', options, async () => {
  process.env['DATABASE_URL'] = URL;
  const auth = await import('../../api/_lib/auth.ts');
  const { default: route } = await import('../../api/auth/[action].ts');

  const notOperator = call('test-as', { cookies: { casa_session: auth.signSession(REAL) }, body: { persona: 'dana' } });
  await route(notOperator.req as never, notOperator.res as never);
  assert.equal(notOperator.res.statusCode, 403);
  assert.equal(notOperator.cookies()['casa_session'], undefined);

  // A real person's address in place of a key buys nothing.
  const byEmail = call('test-as', { cookies: { casa_session: auth.signSession(OPERATOR) }, body: { persona: REAL } });
  await route(byEmail.req as never, byEmail.res as never);
  assert.equal(byEmail.res.statusCode, 400);
  assert.equal(byEmail.cookies()['casa_session'], undefined);

  // A test person with a forged parked session cannot pivot to anyone.
  const forged = call('test-as', {
    cookies: { casa_session: auth.signSession(`dana@${TEST_DOMAIN}`), casa_return: 'forged.token.value' },
    body: { persona: 'yoav' },
  });
  await route(forged.req as never, forged.res as never);
  assert.equal(forged.res.statusCode, 403);

  // A non-operator's parked session does not count either.
  const parkedReal = call('test-as', {
    cookies: { casa_session: auth.signSession(`dana@${TEST_DOMAIN}`), casa_return: auth.signSession(REAL) },
    body: { persona: 'yoav' },
  });
  await route(parkedReal.req as never, parkedReal.res as never);
  assert.equal(parkedReal.res.statusCode, 403);
});
