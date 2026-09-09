import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(process.cwd());
const read = (p: string) => readFileSync(join(root, p), 'utf-8');
const sw = read('public/sw.js');

// The service worker decides what a phone keeps after the tab is closed. These
// guard the two properties that are not visible in review: that the money is
// never cached, and that the file is actually loaded at all.

test('the service worker is registered — it once was not', () => {
  // public/sw.js shipped for several releases without a single call to
  // register(). The release tool stamped its CACHE_NAME, a test asserted that
  // stamp, and the file never ran. Everything else in this file guards a
  // service worker that has to be running to matter.
  const main = read('src/main.tsx');
  assert.match(main, /navigator\.serviceWorker\.register\(['"]\/sw\.js['"]\)/);
});

test('only the shopping list and pantry are cached from the API', () => {
  // A cached API response survives on the device until something evicts it, on
  // a phone that may be handed to somebody. The list is worth that; a budget is
  // not. This allowlist is the whole policy.
  const list = sw.match(/const CACHEABLE_API = \[([\s\S]*?)\]/);
  assert.ok(list, 'the API allowlist is gone');
  const paths = [...list[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  assert.deepEqual(paths, ['/api/shopping/items', '/api/pantry/products']);

  for (const forbidden of ['money', 'budget', 'transactions', 'accounts', 'admin', 'auth']) {
    assert.ok(!paths.some((p) => p.includes(forbidden)),
      `${forbidden} must never be cached on the device`);
  }
});

test('signing out clears what the device kept', () => {
  // Otherwise the next person to open the app on this phone sees the previous
  // household's shopping list before a single request is made.
  assert.match(sw, /casa:forget/);
  assert.match(sw, /caches\.delete\(CACHE_NAME\)/);
  assert.match(read('src/lib/session.tsx'), /postMessage\('casa:forget'\)/);
  assert.match(read('src/lib/session.tsx'), /removeItem\('casa\.outbox\.v1'\)/);
});

test('a cache miss never becomes respondWith(undefined)', () => {
  // `caches.match` resolves to undefined on a miss, and passing that through
  // produces a TypeError and the browser's own error page — which looks like a
  // broken site rather than an offline one.
  assert.doesNotMatch(sw, /respondWith\(\s*fetch\([^)]*\)\.catch\(\(\)\s*=>\s*caches\.match/);
  // Every helper it does respond with either returns a Response or throws.
  assert.match(sw, /if \(cached\) return cached;/);
});

test('another origin is never intercepted', () => {
  // Google's sign-in script in particular must never come from a cache.
  assert.match(sw, /url\.origin !== self\.location\.origin/);
});

test('the shell is cached at install, so the first offline open works', () => {
  assert.match(sw, /cache\.add\(new Request\(SHELL/);
  assert.match(sw, /caches\.match\(SHELL\)/);
});

test('the offline queue is persisted before the request is attempted', () => {
  // A phone in a coat pocket gets its tab evicted. A queue that lived only in
  // React state would take the shopping with it.
  const outbox = read('src/lib/outbox.tsx');
  assert.match(outbox, /localStorage\.setItem\(KEY/);
  assert.match(outbox, /localStorage\.getItem\(KEY\)/);
  // And the write happens in `update`, which every mutation goes through.
  assert.match(outbox, /const update = useCallback\(\(next: Outbox\) => \{[\s\S]{0,200}save\(next\)/);
});

test('adding an item sends a client id', () => {
  // Without it a replayed add bumps the quantity again — two cartons of milk
  // become four, silently. See db/schema.sql, "Working offline".
  const screen = read('src/features/shopping/ShoppingScreen.tsx');
  assert.match(screen, /client_id: actionId\(\)/);
  const api = read('api/shopping/[...path].ts');
  assert.match(api, /WHERE client_id = \$1/);
  assert.match(api, /client_id = COALESCE/);
});

test('a tick is queued, not awaited and reverted', () => {
  // The old version reverted the row when the request failed — correct at a
  // desk, exactly backwards in a supermarket, where a failed request is the
  // normal case and the tick is still true.
  const screen = read('src/features/shopping/ShoppingScreen.tsx');
  assert.match(screen, /function tick\(item: ShoppingItem\) \{[\s\S]{0,400}outbox\.send\(/);
  assert.doesNotMatch(screen, /setStatus\(item\.id, 'open'\);\s*\n\s*toast\.show\([^)]*tone: 'bad'/);
});

test('the sign-in screen does not invent a reason it cannot know', () => {
  // It used to have two states: a button, or «חסר GOOGLE_CLIENT_ID». So every
  // failure of /auth/me — a database that would not connect, a role without
  // privileges — rendered as a confident, specific, wrong claim about Google,
  // and sent us to reconfigure something that was never broken.
  const session = read('src/lib/session.tsx');
  const app = read('src/app/App.tsx');

  // The failure is kept rather than swallowed.
  assert.match(session, /setFailure\(err instanceof Error \? err\.message/);
  assert.doesNotMatch(session, /\} catch \{\s*\n\s*setUser\(null\);\s*\n\s*\}/,
    'the catch must not discard the reason');

  // And the screen distinguishes "the server did not answer" from "the server
  // answered without a client id".
  assert.match(app, /failure \?/);
  assert.match(app, /השרת לא ענה/);
  assert.match(app, /השרת ענה, אבל בלי/);
});
