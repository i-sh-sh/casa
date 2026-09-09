import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeForAlert, readConnectionTarget, summariseConnection } from '../../shared/diagnostics.ts';

// This module exists because `DATABASE_URL` is a Vercel Secret — write-only,
// never displayable again. When Postgres answers 28P01 the only way to learn
// which user, host and database were tried is for the process holding the
// string to say so. So the two things being tested are: it reads a string
// correctly even when the string is broken, and it never says the password.

const REAL = 'postgresql://casa_app:0f3a9c1d@ep-beige-globe-12345-pooler.eu-central-1.aws.neon.tech/casa?sslmode=require';

test('a healthy Neon string is read into its parts', () => {
  const t = readConnectionTarget(REAL)!;
  assert.equal(t.scheme, 'postgresql');
  assert.equal(t.user, 'casa_app');
  assert.equal(t.host, 'ep-beige-globe-12345-pooler.eu-central-1.aws.neon.tech');
  assert.equal(t.database, 'casa');
  assert.equal(t.params, 'sslmode=require');
  assert.equal(t.pooled, true);
  assert.equal(t.passwordLength, 8);
  assert.deepEqual(t.passwordBreaks, []);
  assert.deepEqual(t.wrappers, []);
});

test('the password itself never appears in the summary', () => {
  // The whole point of the Secret is that this value stays unreadable. A
  // diagnostic that leaks it into a chat would be worse than no diagnostic.
  const summary = summariseConnection(REAL);
  assert.ok(!summary.includes('0f3a9c1d'), 'the summary leaked the password');
  assert.match(summary, /casa_app@ep-beige-globe/);
  assert.match(summary, /8 תווים/);
});

test('a slash in the password is named, not swallowed', () => {
  // This is the failure the doc warns about: `openssl rand -base64` produces
  // `/`, which ends the authority section, so everything after it is read as a
  // database name. A strict URL parser reports a wrong database; the person
  // reading it looks in entirely the wrong place.
  const t = readConnectionTarget('postgresql://casa_app:ab/cd@host-pooler.neon.tech/casa?sslmode=require')!;
  assert.equal(t.user, 'casa_app');
  assert.equal(t.host, 'host-pooler.neon.tech');
  assert.equal(t.database, 'casa');
  assert.deepEqual(t.passwordBreaks, ['/']);
  assert.match(summariseConnection('postgresql://casa_app:ab/cd@host-pooler.neon.tech/casa?sslmode=require'), /תו שובר/);
});

test('a `:` or `@` inside a password is not an error', () => {
  // A URL parser splits on the *first* `:` and the *last* `@`, so both survive.
  // Flagging them would send somebody to regenerate a password that was fine.
  const t = readConnectionTarget('postgresql://casa_app:a:b@c@host-pooler.neon.tech/casa')!;
  assert.equal(t.user, 'casa_app');
  assert.equal(t.host, 'host-pooler.neon.tech');
  assert.deepEqual(t.passwordBreaks, []);
});

test('what a phone copy-paste drags in is reported', () => {
  const t = readConnectionTarget(`  psql 'postgresql://casa_app:pw@host-pooler.neon.tech/casa'  `)!;
  assert.deepEqual(t.wrappers, ['רווח בהתחלה או בסוף', 'קידומת psql', 'גרשיים']);
  assert.equal(t.user, 'casa_app');
  assert.equal(t.database, 'casa');
});

test('a missing -pooler and a missing sslmode are both called out', () => {
  const summary = summariseConnection('postgresql://casa_app:pw@ep-beige-globe-12345.eu-central-1.aws.neon.tech/casa');
  assert.match(summary, /-pooler/);
  assert.match(summary, /sslmode/);
});

test('the wrong database name is visible at a glance', () => {
  // Neon's connect dialog defaults to `neondb`. Picking the wrong entry in that
  // dropdown produces a string that is correct in every other respect.
  const t = readConnectionTarget('postgresql://casa_app:pw@ep-x-pooler.neon.tech/neondb?sslmode=require')!;
  assert.equal(t.database, 'neondb');
});

test('an unset DATABASE_URL says so instead of parsing nothing', () => {
  assert.equal(readConnectionTarget(undefined), null);
  assert.equal(readConnectionTarget(''), null);
  assert.match(summariseConnection(undefined), /לא מוגדר/);
});

test('a string that is not a connection string at all still produces an answer', () => {
  // A parser that throws on the input worth diagnosing cannot diagnose it.
  const summary = summariseConnection('ep-beige-globe-12345-pooler.eu-central-1.aws.neon.tech');
  assert.match(summary, /postgresql:\/\//);
  assert.ok(summary.length > 0);
});

test('a connection failure carries the target; a row failure does not', () => {
  const connection = REAL;

  const refused = describeForAlert({
    method: 'GET', url: '/api/auth/me', householdId: null,
    err: { code: '28P01' }, connectionString: connection,
  });
  assert.match(refused.text, /casa_app@ep-beige-globe/);
  assert.match(refused.text, /28P01/);
  assert.ok(!refused.text.includes('0f3a9c1d'), 'the alert leaked the password');

  // 23505 is the database answering about a row. The connection was fine, and
  // sending its details would be noise on every duplicate key for a year.
  const duplicate = describeForAlert({
    method: 'POST', url: '/api/money/transactions', householdId: 3,
    err: { code: '23505' }, connectionString: connection,
  });
  assert.ok(!duplicate.text.includes('casa_app'), 'a row error carried the connection target');
  assert.ok(!duplicate.text.includes('neon.tech'));
});

test('the alert escapes what it interpolates', () => {
  // parse_mode is HTML, and an unescaped `<` silently drops the rest of the
  // message — the alert would arrive truncated exactly when it matters.
  const { text } = describeForAlert({
    method: 'GET', url: '/api/<script>', householdId: 1, err: { code: 'ETIMEDOUT' },
    connectionString: 'postgresql://a<b:pw@host-pooler.neon.tech/casa?sslmode=require',
  });
  assert.ok(!text.includes('<script>'), 'an unescaped tag reached the message');
  assert.match(text, /&lt;script&gt;/);
  assert.match(text, /a&lt;b@host-pooler/);
});
