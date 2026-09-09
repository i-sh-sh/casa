import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeForAlert } from '../../shared/diagnostics.ts';

// The alert exists so that a couple who hits a server error is not lost in
// silence for three weeks. But it sends into a chat, and the promise made to
// the pilot couples in writing was «ספירות, לא סכומים» — so what it may say is
// as much the point as that it says anything.

test('an alert names the request and the household, and nothing else', () => {
  const { text } = describeForAlert({
    method: 'post', url: '/api/money/transactions?q=רמי', householdId: 3,
    err: Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505', constraint: 'categories_unique_name',
    }),
  });
  assert.match(text, /POST \/api\/money\/transactions/);
  assert.match(text, /בית 3/);
  assert.match(text, /23505/);
  assert.match(text, /categories_unique_name/);
});

test('the error message never leaves the server', () => {
  // Postgres puts row values into its errors: a unique violation names the key,
  // a check violation names the row. Forwarding the message would forward a
  // couple's payees and amounts into a chat.
  const secret = 'Key (payee)=(רמי לוי, ₪243.90) already exists';
  const { text } = describeForAlert({
    method: 'POST', url: '/api/money/transactions', householdId: 1,
    err: Object.assign(new Error(secret), { code: '23505' }),
  });
  assert.ok(!text.includes(secret), 'the alert forwarded the error message');
  assert.ok(!text.includes('רמי לוי'), 'the alert forwarded a payee');
  assert.ok(!text.includes('243.90'), 'the alert forwarded an amount');
});

test('the query string is dropped, because somebody typed it', () => {
  // A path is something we wrote. A query string can be a search term — which
  // in this app means the name of a shop, a person, or a product.
  const { text } = describeForAlert({
    method: 'GET', url: '/api/pantry/products?search=תרופות', err: new Error('x'),
  });
  assert.ok(!text.includes('תרופות'), 'the alert forwarded a search term');
  assert.match(text, /\/api\/pantry\/products/);
});

test('the same failure twice is one signature', () => {
  // The dedupe key is what stops a phone retrying a broken request from sending
  // a hundred messages and making the channel unreadable — which is the same as
  // having no channel at all.
  const one = describeForAlert({ method: 'GET', url: '/api/a?x=1', err: { code: '42P01' } });
  const two = describeForAlert({ method: 'GET', url: '/api/a?x=2', err: { code: '42P01' } });
  assert.equal(one.signature, two.signature);

  const other = describeForAlert({ method: 'GET', url: '/api/b', err: { code: '42P01' } });
  assert.notEqual(one.signature, other.signature);
});

test('an error with no code still produces a usable alert', () => {
  const { text, signature } = describeForAlert({ err: new TypeError('undefined is not a function') });
  assert.match(text, /TypeError/);
  assert.ok(signature.length > 0);
  assert.ok(!text.includes('undefined is not a function'));
});

test('a request outside any household says so rather than inventing one', () => {
  const { text } = describeForAlert({ method: 'POST', url: '/api/auth/google', householdId: null, err: {} });
  assert.match(text, /ללא בית/);
  assert.doesNotMatch(text, /בית 0|בית null/);
});
