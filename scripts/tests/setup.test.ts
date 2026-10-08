import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDone, setupSteps, wantsAnotherCard, weekIndex, type SetupFacts } from '../../shared/setup.ts';

// The checklist a new home sees and the column the operator reads are the same
// function, so these hold both: a step is done when the thing exists, however
// it came to exist.

const fresh: SetupFacts = { credit_accounts: 0, allocations: 0, stocked: 0, tracked: 0, members: 1, invites: 0 };

test('a home fresh from the seed has done nothing yet', () => {
  // The seed adds a bank account and cash, never a card; categories with no
  // amounts; products with no stock. None of that is the household's own.
  const steps = setupSteps(fresh);
  assert.equal(setupDone(steps), 0);
  // The partner first: the rest are decisions the two of them make together.
  assert.deepEqual(steps.map((s) => s.key), ['partner', 'card', 'budget', 'pantry']);
});

test('each step is read from the data, not from a flag', () => {
  const steps = setupSteps({ credit_accounts: 1, allocations: 12, stocked: 3, tracked: 0, members: 2, invites: 0 });
  assert.equal(setupDone(steps), 4);
  assert.match(steps.find((s) => s.key === 'budget')!.status, /12 סעיפים/);
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

test('saying what is bought regularly sets the pantry up, even with nothing in the cupboard', () => {
  const pantry = setupSteps({ ...fresh, tracked: 4 }).find((s) => s.key === 'pantry')!;
  assert.equal(pantry.done, true);
});

test('one card between two people is done, and still asks about the second', () => {
  const two = { ...fresh, credit_accounts: 1, members: 2 };
  const card = setupSteps(two).find((s) => s.key === 'card')!;
  assert.equal(card.done, true, 'some couples share one card');
  assert.equal(wantsAnotherCard(two), true);
  assert.match(card.status, /השני/);
  assert.equal(wantsAnotherCard({ ...two, credit_accounts: 2 }), false);
  assert.equal(wantsAnotherCard({ ...fresh, credit_accounts: 1 }), false, 'alone, one card is the whole answer');
});
