import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFailure, isOurError } from '../../shared/api-error.ts';

// The bug these guard against was not a crash. It was a red bar reading
// «הנתיב המבוקש בשרת לא נמצא» — a sentence that appears nowhere in this
// repository, names no request, and cost an evening to chase. Every case below
// is about one property: a failure must say which request produced it, unless
// our own server already said something better.

test('our server’s own sentence is passed through untouched', () => {
  const message = describeFailure({
    method: 'PATCH', path: '/admin/users', status: 404,
    text: JSON.stringify({ error: 'המשתמש לא נמצא' }),
  });
  assert.equal(message, 'המשתמש לא נמצא');
});

test('a 404 that is not ours names the request and says it never arrived', () => {
  const message = describeFailure({
    method: 'patch', path: '/admin/users', status: 404,
    text: '<!DOCTYPE html><html><head><title>404</title></head></html>',
  });
  assert.match(message, /PATCH \/admin\/users/);
  assert.match(message, /404/);
  assert.match(message, /לא הגיעה לשרת של קאסה/);
  // The HTML is named, not quoted: a tag soup in a toast helps nobody, but
  // knowing it *was* a page rather than data is the whole diagnosis.
  assert.match(message, /עמוד HTML/);
  assert.doesNotMatch(message, /DOCTYPE/);
});

test('a 405 is treated the same way — it also means the function was skipped', () => {
  const message = describeFailure({ method: 'PATCH', path: '/admin/users', status: 405, text: '' });
  assert.match(message, /לא הגיעה לשרת של קאסה/);
  assert.match(message, /התשובה הגיעה ריקה/);
});

test('a 500 from outside our code says the server fell over, and which request', () => {
  const message = describeFailure({
    method: 'POST', path: '/admin/migrate', status: 502, text: 'An error occurred with your deployment',
  });
  assert.match(message, /POST \/admin\/migrate/);
  assert.match(message, /502/);
  assert.match(message, /נפל לפני שהספיק לענות/);
});

test('status 0 is the network, and says so without mentioning the server', () => {
  const message = describeFailure({ method: 'GET', path: '/shopping/items', status: 0, text: '' });
  assert.match(message, /אין חיבור לרשת/);
  assert.doesNotMatch(message, /שרת/);
});

test('a foreign body is quoted short and on one line', () => {
  const message = describeFailure({
    method: 'GET', path: '/money/budget', status: 403,
    text: 'x'.repeat(500) + '\n\nmore',
  });
  assert.ok(message.length < 220, `too long to fit in a toast: ${message.length}`);
  assert.doesNotMatch(message, /\n/);
});

test('an error field that is empty or not a string is not ours', () => {
  assert.equal(isOurError(JSON.stringify({ error: '' })), null);
  assert.equal(isOurError(JSON.stringify({ error: { code: 1 } })), null);
  assert.equal(isOurError('not json at all'), null);
  assert.equal(isOurError(''), null);
  assert.equal(isOurError(JSON.stringify({ error: 'כן' })), 'כן');
});

test('the role change no longer puts an address in the request path', async () => {
  // An address ends in `.com`. A path ending in something shaped like a file
  // extension is claimed by the static layer in front of the function, which
  // answers 404 itself. This is the regression that produced the red bar.
  const { readFile } = await import('node:fs/promises');
  const screen = await readFile(
    new URL('../../src/features/settings/SettingsScreen.tsx', import.meta.url), 'utf8',
  );
  assert.doesNotMatch(screen, /admin\/users\/\$\{/, 'the address is back in the path');
  assert.match(screen, /api\.patch\('\/admin\/users', \{ email, role \}\)/);
});
