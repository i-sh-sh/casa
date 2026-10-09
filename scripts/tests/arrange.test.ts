import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange, groupArchiveBlock, moveInList, movedAnnouncement } from '../../shared/arrange.ts';
import { buildBudgetMonth } from '../../shared/money.ts';
import type { Category, CategoryGroup } from '../../shared/types.ts';

const group = (id: number, name: string, sort_order: number, archived = false): CategoryGroup => ({
  id, name, sort_order, archived_at: archived ? '2026-10-01T00:00:00Z' : null,
});
const cat = (id: number, name: string, group_id: number | null, sort_order = 0, archived = false): Category => ({
  id, group_id, group_name: null, name, kind: 'spending', commitment: 'flexible',
  monthly_target: null, icon: null, sort_order, archived_at: archived ? '2026-10-01T00:00:00Z' : null,
});

test('groups and categories come back in their own order, archived ones apart', () => {
  const result = arrange(
    [group(1, 'יומיום', 1), group(2, 'קבועות', 0), group(3, 'ישן', 2, true)],
    [cat(10, 'סופר', 1, 1), cat(11, 'קפה', 1, 0), cat(12, 'ארנונה', 2), cat(13, 'גן', 1, 2, true)],
  );
  assert.deepEqual(result.groups.map((g) => g.group?.name), ['קבועות', 'יומיום']);
  assert.deepEqual(result.groups[1]!.categories.map((c) => c.name), ['קפה', 'סופר']);
  assert.deepEqual(result.archivedGroups.map((g) => g.name), ['ישן']);
  assert.deepEqual(result.archivedCategories.map((c) => c.name), ['גן']);
});

test('a category with no open group is listed, not lost', () => {
  const result = arrange([group(1, 'ישן', 0, true)], [cat(10, 'סופר', 1), cat(11, 'מתנות', null)]);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0]!.group, null);
  assert.deepEqual(result.groups[0]!.categories.map((c) => c.name), ['סופר', 'מתנות']);
});

test('moving swaps one step and stops at the ends', () => {
  assert.deepEqual(moveInList([1, 2, 3], 2, -1), [2, 1, 3]);
  assert.deepEqual(moveInList([1, 2, 3], 2, 1), [1, 3, 2]);
  assert.deepEqual(moveInList([1, 2, 3], 1, -1), [1, 2, 3]);
  assert.deepEqual(moveInList([1, 2, 3], 3, 1), [1, 2, 3]);
  assert.deepEqual(moveInList([1, 2, 3], 9, 1), [1, 2, 3]);
});

test('a move is announced as a position, in words', () => {
  assert.equal(movedAnnouncement('ארנונה', [5, 7, 9], 7, 'קבוצה קבועות'), 'ארנונה עכשיו במקום 2 מתוך 3 בקבוצה קבועות');
});

test('only an empty group can be archived', () => {
  assert.equal(groupArchiveBlock(0), null);
  assert.match(groupArchiveBlock(1)!, /סעיף אחד/);
  assert.match(groupArchiveBlock(4)!, /4 סעיפים/);
});

// ── Archive never takes money off the screen ─────────────────────────────

test('an archived category stays in the months it has money in', () => {
  // The regression this guards: the budget used to drop archived categories
  // outright, so archiving «ארנונה» in March took February's bill out of
  // February's spending and flow, with the transactions still in the list.
  const categories = [cat(1, 'ארנונה', 1, 0, true), cat(2, 'סופר', 1)];
  const feb = buildBudgetMonth({
    month: '2026-02-01',
    categories,
    allocations: [{ month: '2026-02-01', category_id: 1, allocated: 600 }],
    spends: [{ month: '2026-02-01', category_id: 1, amount: -580 }],
  });
  const arnona = feb.envelopes.find((e) => e.category_id === 1);
  assert.ok(arnona, 'the archived category disappeared from a month it was used in');
  assert.equal(arnona.archived, true);
  assert.equal(feb.spent, 580);
  assert.equal(feb.flow.spent, 580);
});

test('an archived category leaves the months it has nothing in', () => {
  const april = buildBudgetMonth({
    month: '2026-04-01',
    categories: [cat(1, 'ארנונה', 1, 0, true), cat(2, 'סופר', 1)],
    allocations: [],
    spends: [],
  });
  assert.deepEqual(april.envelopes.map((e) => e.category_name), ['סופר']);
  assert.equal(april.envelopes[0]!.archived, false);
});
