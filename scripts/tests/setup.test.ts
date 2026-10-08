import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDone, setupSteps, weekIndex, type SetupFacts } from '../../shared/setup.ts';

// The checklist a new home sees and the column the operator reads are the same
// function, so these hold both: a step is done when the thing exists, however
// it came to exist.

const fresh: SetupFacts = { credit_accounts: 0, allocations: 0, stocked: 0, members: 1, invites: 0 };

test('a home fresh from the seed has done nothing yet', () => {
  // The seed adds a bank account and cash, never a card; categories with no
  // amounts; products with no stock. None of that is the household's own.
  const steps = setupSteps(fresh);
  assert.equal(setupDone(steps), 0);
  assert.deepEqual(steps.map((s) => s.key), ['card', 'budget', 'pantry', 'partner']);
});

test('each step is read from the data, not from a flag', () => {
  const steps = setupSteps({ credit_accounts: 1, allocations: 12, stocked: 3, members: 2, invites: 0 });
  assert.equal(setupDone(steps), 4);
  assert.match(steps[1]!.status, /12 סעיפים/);
});

test('an invite that was sent and not accepted is said, and not counted as done', () => {
  const partner = setupSteps({ ...fresh, invites: 1 }).find((s) => s.key === 'partner')!;
  assert.equal(partner.done, false);
  assert.match(partner.status, /נשלחה/);
});

test('weeks are counted from the day the home opened, the first being 0', () => {
  const opened = '2026-09-01T10:00:00Z';
  assert.equal(weekIndex(opened, new Date('2026-09-01T12:00:00Z')), 0);
  assert.equal(weekIndex(opened, new Date('2026-09-08T09:00:00Z')), 0, 'six days and 23 hours is still week one');
  assert.equal(weekIndex(opened, new Date('2026-09-15T11:00:00Z')), 2, 'the pilot\'s week three');
  assert.equal(weekIndex(opened, new Date('2026-08-30T00:00:00Z')), 0, 'a clock behind the server never goes negative');
});
