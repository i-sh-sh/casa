import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeDbError } from '../../api/_lib/db.ts';

/**
 * The one class of failure that is not a bug in this app, and the one where a
 * generic message costs the most.
 *
 * Every case here is a wrong DATABASE_URL in a specific, nameable way. They all
 * used to arrive as the same flat «שגיאת שרת. נסו שוב בעוד רגע» — a sentence
 * that is true, useless, and identical to the database being down. Naming them
 * turns an afternoon of guessing into one line of reading.
 */

test('a rejected password says so, and does not blame the app', () => {
  const message = describeDbError({ code: '28P01' });
  assert.match(message!, /שם המשתמש או הסיסמה/);
  assert.match(message!, /DATABASE_URL/);
  assert.match(message!, /NEON\.md/);
  assert.equal(describeDbError({ code: '28000' }), message);
});

test('a role without privileges points at the step that was skipped', () => {
  // Running only CREATE ROLE, without REASSIGN OWNED and GRANT, produces
  // exactly this — a role that connects and can read nothing.
  const message = describeDbError({ code: '42501' });
  assert.match(message!, /אין הרשאה/);
  assert.match(message!, /REASSIGN OWNED/);
});

test('a wrong database name and a wrong host are told apart', () => {
  assert.match(describeDbError({ code: '3D000' })!, /שם מסד הנתונים/);
  assert.match(describeDbError({ code: 'ENOTFOUND' })!, /שם המארח/);
  assert.match(describeDbError({ code: 'ENOTFOUND' })!, /-pooler/);
});

test('the schema hint still works and still names the button', () => {
  assert.match(describeDbError({ code: '42P01' })!, /טבלה/);
  assert.match(describeDbError({ code: '42703' })!, /עמודה/);
  assert.match(describeDbError({ code: '42P01' })!, /הרץ מיגרציה/);
});

test('anything else stays generic, deliberately', () => {
  // An unexpected failure must not be dressed up as a known one: a confident
  // wrong diagnosis is what sent us to reconfigure Google.
  assert.equal(describeDbError({ code: '23505' }), null);
  assert.equal(describeDbError(new Error('boom')), null);
  assert.equal(describeDbError(null), null);
  assert.equal(describeDbError(undefined), null);
});
