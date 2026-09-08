import { test } from 'node:test';
import assert from 'node:assert/strict';
import { match, queryOf, segmentsOf } from '../../shared/routing.ts';

// These tests exist because of a real outage, not a hypothetical one.
//
// The router read its path from `req.query.path` — what a `[...path]` catch-all
// is documented to populate. In production it arrived empty, so EVERY module
// endpoint answered "אין נתיב כזה: /" while sign-in, which uses an ordinary
// dynamic segment, worked perfectly. The whole app was dead and the one screen
// people saw first said the house was calm.
//
// The fix reads the URL, which is ground truth. These lock that in.

const req = (url: string, query: Record<string, string | string[]> = {}) => ({ url, query });

test('a module path is read from the URL, with no help from req.query', () => {
  assert.deepEqual(segmentsOf(req('/api/money/budget')), ['budget']);
  assert.deepEqual(segmentsOf(req('/api/shopping/items')), ['items']);
  assert.deepEqual(segmentsOf(req('/api/money/bills/3/pay')), ['bills', '3', 'pay']);
  assert.deepEqual(segmentsOf(req('/api/users/a%40b.com')), ['users', 'a@b.com']);
  assert.deepEqual(segmentsOf(req('/admin/users/a%40b.com')), ['users', 'a@b.com']);
});

test('the query string is not part of the path', () => {
  assert.deepEqual(segmentsOf(req('/api/money/budget?month=2026-09-01')), ['budget']);
  assert.deepEqual(segmentsOf(req('/api/pantry/products?below_min=1&search=%D7%97%D7%9C%D7%91')), ['products']);
});

test('an empty req.query does not empty the path — the exact production failure', () => {
  assert.deepEqual(segmentsOf({ url: '/api/money/budget?month=2026-09-01', query: {} }), ['budget']);
});

test('segments are percent-decoded, so an email can be a path segment', () => {
  // /admin/users/:email is reached as .../users/a%40b.com, and the handler
  // compares it against a real address.
  assert.deepEqual(segmentsOf(req('/api/admin/users/a%40b.com')), ['users', 'a@b.com']);
  assert.deepEqual(segmentsOf(req('/api/pantry/products?q=x')), ['products']);
});

test('a malformed escape does not crash the router', () => {
  // It simply will not match a route, which is a 404 — not a 500.
  assert.deepEqual(segmentsOf(req('/api/money/%E0%A4%A')), ['%E0%A4%A']);
});

test('the module root has no segments, and is a 404 rather than a match', () => {
  assert.deepEqual(segmentsOf(req('/api/money')), []);
  assert.deepEqual(segmentsOf(req('/api/money/')), []);
});

test('an already-stripped URL falls back to req.query, then to itself', () => {
  assert.deepEqual(segmentsOf({ url: '/budget', query: { path: ['budget'] } }), ['budget']);
  assert.deepEqual(segmentsOf({ url: '/bills/3/pay', query: {} }), ['bills', '3', 'pay']);
  assert.deepEqual(segmentsOf(req('/pantry/products/123/stock')), ['products', '123', 'stock']);
});

test('Vercel catch-all [...path] placeholder in URL is ignored in favor of query.path or search params', () => {
  assert.deepEqual(segmentsOf({ url: '/api/pantry/[...path]?path=products&path=2&path=stock', query: { path: ['products', '2', 'stock'] } }), ['products', '2', 'stock']);
  assert.deepEqual(segmentsOf({ url: '/api/pantry/[...path]?path=pantry&path=products&path=2&path=stock', query: { path: ['pantry', 'products', '2', 'stock'] } }), ['products', '2', 'stock']);
  assert.deepEqual(segmentsOf({ url: '/api/pantry/[...path]?path=products&path=2&path=stock', query: {} }), ['products', '2', 'stock']);
  assert.deepEqual(segmentsOf({ url: '/api/pantry/[...path]', query: { path: ['products', '2', 'stock'] } }), ['products', '2', 'stock']);
});


// ── Pattern matching ─────────────────────────────────────────────────────

test('a literal pattern matches only itself', () => {
  assert.deepEqual(match('budget', ['budget']), {});
  assert.equal(match('budget', ['bills']), null);
  assert.equal(match('budget', ['budget', 'autofill']), null, 'length must match exactly');
  assert.equal(match('budget', []), null);
});

test('named parameters are captured', () => {
  assert.deepEqual(match('bills/:id', ['bills', '42']), { id: '42' });
  assert.deepEqual(match('bills/:id/pay', ['bills', '42', 'pay']), { id: '42' });
  assert.deepEqual(match('users/:email', ['users', 'a@b.com']), { email: 'a@b.com' });
});

// ── Query string ─────────────────────────────────────────────────────────

test('query values come off the URL, whatever req.query says', () => {
  assert.deepEqual(queryOf({ url: '/api/money/budget?month=2026-09-01', query: {} }), { month: '2026-09-01' });
  assert.deepEqual(queryOf({ url: '/api/pantry/products?below_min=1&category=%D7%97%D7%9C%D7%91' }),
    { below_min: '1', category: 'חלב' });
});

test('`path` never leaks into the query values', () => {
  assert.deepEqual(queryOf({ url: '/api/money/budget', query: { path: ['budget'] } }), {});
});

test('a repeated parameter takes the last value, not an array', () => {
  // Every consumer treats query values as strings; an array here would reach a
  // validator as "1,2" and be stored as nonsense.
  assert.deepEqual(queryOf({ url: '/api/x/y?limit=10&limit=50' }), { limit: '50' });
});

test('a literal route wins over a parameter only by being registered first', () => {
  // 'budget/autofill' and 'budget/:categoryId' both match ['budget','autofill'],
  // so the order in the route table is what decides. This asserts the ambiguity
  // is real, so nobody reorders those two by accident.
  assert.deepEqual(match('budget/autofill', ['budget', 'autofill']), {});
  assert.deepEqual(match('budget/:categoryId', ['budget', 'autofill']), { categoryId: 'autofill' });
});
