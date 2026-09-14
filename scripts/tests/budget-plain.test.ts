import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBudgetMonth, commitmentBreakdown, round2, unplannedCheck } from '../../shared/money.ts';
import type { Category } from '../../shared/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * Source with its comments removed.
 *
 * This project explains itself at length, and these tests forbid words that
 * the explanations necessarily use — the comment on the new allocation sheet
 * says what a «בפועל» button used to do, which is exactly the string being
 * banned. Assert on code.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
}

/**
 * The budget shows figures the household typed, and differences between them.
 *
 * The line these tests hold is not «nothing computed» — it is **nothing
 * invented**. Two things sit on either side of it:
 *
 * - A figure the app made up and put in the household's budget: a seeded
 *   ₪5,000 target, a button that fills a month from those targets, a
 *   three-month average typed into the allocation box. Those are gone, and
 *   these tests keep them gone.
 * - A reading of what the household typed: grouping their own allocations by
 *   how much control they have over each (the ladder), or checking what they
 *   set aside for the unforeseen against a stated 5% floor. Those invent
 *   nothing, and they came back.
 *
 * Rollover is gone for a different reason again: it was not from the method,
 * and it made «נשאר» impossible to recompute in your head.
 */

test('available is always allocated minus spent, for every envelope', () => {
  const cat = (id: number, name: string): Category => ({
    id, group_id: 1, group_name: 'ג', name, kind: 'spending', commitment: 'flexible',
    monthly_target: null, icon: null, sort_order: 0, archived_at: null,
  });
  const result = buildBudgetMonth({
    month: '2026-03-01',
    categories: [cat(1, 'א'), cat(2, 'ב'), cat(3, 'ג')],
    allocations: [
      { month: '2026-02-01', category_id: 1, allocated: 9999 },  // last month: irrelevant
      { month: '2026-03-01', category_id: 1, allocated: 1000 },
      { month: '2026-03-01', category_id: 2, allocated: 250.55 },
    ],
    spends: [
      { month: '2026-02-01', category_id: 1, amount: -5000 },     // last month: irrelevant
      { month: '2026-03-01', category_id: 1, amount: -300.25 },
      { month: '2026-03-01', category_id: 3, amount: -40 },
    ],
  });
  for (const e of result.envelopes) {
    assert.equal(
      e.available, round2(e.allocated - e.spent),
      `${e.category_name}: ${e.available} is not ${e.allocated} − ${e.spent}`,
    );
  }
  assert.equal(result.envelopes.find((e) => e.category_id === 1)!.available, 699.75);
});

test('the seed ships names and classifications, never amounts', () => {
  // A structure worth suggesting; figures that were only ever plausible. The
  // rung is structure — «שכירות is hard to change» is the same kind of claim as
  // «there is a category called שכירות», and both are editable.
  const seed = code(read('api/admin/_seed.ts'));
  const categories = seed.slice(seed.indexOf('INSERT INTO categories'), seed.indexOf('INSERT INTO accounts'));
  assert.ok(!/monthly_target/.test(categories), 'the seed sets a monthly target');
  // Every VALUES row is (group, name, kind, rung, order) — no figure among them.
  const rows = [...categories.matchAll(
    /\('[^']+',\s*'[^']+',\s*'(?:spending|income|saving)',\s*'(?:rigid|flexible|liquid|unplanned)',\s*\d+\)/g,
  )];
  assert.ok(rows.length >= 25, `expected the seeded categories, found ${rows.length}`);
  // Nothing in the block may be a bare number other than a sort order.
  const figures = [...categories.matchAll(/,\s*(\d{2,})\s*[,)]/g)];
  assert.deepEqual(figures.map((m) => m[1]), [], 'a figure is seeded into a category');
});

test('no endpoint fills a budget on the household\'s behalf', () => {
  const api = code(read('api/money/[...path].ts'));
  assert.ok(!/autofill/.test(api), 'the autofill endpoint is back');
  assert.ok(!/averages/i.test(api), 'the averages endpoint is back');
  // Allocation happens one envelope at a time, from a number in the request.
  assert.match(api, /INSERT INTO budget_allocations/);
  const inserts = [...api.matchAll(/INSERT INTO budget_allocations/g)];
  assert.equal(inserts.length, 1, 'more than one place writes allocations');
});

test('the budget screen offers no button that types a figure for you', () => {
  const screen = code(read('src/features/money/BudgetScreen.tsx'));
  // Projection multiplied a deficit out to three years; autofill and the
  // average typed into the box. The ladder and COMMITMENT_* are not on this
  // list: they read the allocations, they never write one.
  for (const gone of ['Projection', 'autofill', 'average', 'monthly_target']) {
    assert.ok(!new RegExp(gone).test(screen), `${gone} is back on the budget screen`);
  }
  // Exactly one thing writes the allocation box, and it is the person typing
  // in it. Every «בפועל»/«היעד» shortcut was a second writer.
  const setters = [...screen.matchAll(/setAllocated\(/g)];
  assert.equal(setters.length, 1, `${setters.length} things write the allocation box; only the input may`);
  const onChange = screen.slice(screen.indexOf('setAllocated(') - 60, screen.indexOf('setAllocated(') + 30);
  assert.match(onChange, /onChange=\{\(e\) =>/, 'the allocation box is written by something other than typing');
});

test('the model exports nothing that invents a number', () => {
  const money = code(read('shared/money.ts'));
  // The average is the only one of these that ever produced a figure for
  // somebody to accept; the ladder and the floor only ever grouped or checked.
  for (const gone of ['categoryAverages']) {
    assert.ok(!new RegExp(`export .*${gone}`).test(money), `${gone} is exported again`);
  }
  // Cash flow is a subtraction, not a forecast.
  const flow = money.slice(money.indexOf('export function cashFlow'));
  assert.ok(!/\*\s*12|\*\s*36/.test(flow.slice(0, 400)), 'the projection is back');
});

test('the guide does not describe features the app no longer has', () => {
  // A guide showing a ladder the app dropped is worse than no guide, and three
  // couples are about to be handed the link.
  const guide = read('public/guide.html');
  for (const claim of ['43,200', 'בפועל · ₪', 'היעד · ₪']) {
    assert.ok(!guide.includes(claim), `the guide still promises «${claim}»`);
  }
});

test('the ladder reads the allocations and writes none of them', () => {
  // The whole basis for bringing it back: it is a reading, so it must leave
  // what it read exactly as it found it. Asserted by behaviour rather than by
  // grepping for an assignment — the first version of this test matched a local
  // named `allocated` and failed against correct code.
  const cat = (id: number, name: string, commitment: Category['commitment']): Category => ({
    id, group_id: 1, group_name: 'ג', name, kind: 'spending', commitment,
    monthly_target: null, icon: null, sort_order: 0, archived_at: null,
  });
  const result = buildBudgetMonth({
    month: '2026-09-01',
    categories: [cat(1, 'שכירות', 'rigid'), cat(2, 'מסעדות', 'liquid'), cat(3, 'בלת״מ', 'unplanned')],
    allocations: [
      { month: '2026-09-01', category_id: 1, allocated: 5000 },
      { month: '2026-09-01', category_id: 2, allocated: 800 },
      { month: '2026-09-01', category_id: 3, allocated: 200 },
    ],
    spends: [],
  });

  const before = JSON.stringify(result.envelopes);
  commitmentBreakdown(result.envelopes);
  unplannedCheck(result.envelopes);
  assert.equal(JSON.stringify(result.envelopes), before, 'reading the ladder changed the envelopes');

  // Every rung's allocation is exactly the sum of its own envelopes.
  const rigid = result.commitments.find((c) => c.commitment === 'rigid')!;
  assert.equal(rigid.allocated, 5000);
  assert.equal(rigid.share, round2(5000 / 6000));
  assert.equal(
    result.commitments.reduce((sum, c) => sum + c.allocated, 0), result.allocated,
    'the ladder does not add up to the month',
  );

  // 200 of 6,000 is 3.3% — under the floor, and the gap is stated.
  assert.equal(result.unplanned.meets_floor, false);
  assert.equal(result.unplanned.shortfall, 100);
});

test('a month nobody has budgeted is not nagged about the floor', () => {
  const cat = (id: number, name: string): Category => ({
    id, group_id: 1, group_name: 'ג', name, kind: 'spending', commitment: 'flexible',
    monthly_target: null, icon: null, sort_order: 0, archived_at: null,
  });
  const result = buildBudgetMonth({
    month: '2026-09-01', categories: [cat(1, 'סופר')], allocations: [], spends: [],
  });
  assert.equal(result.unplanned.meets_floor, true, 'warning before the first allocation teaches people to ignore it');
  assert.equal(result.unplanned.shortfall, 0);
  assert.ok(result.commitments.every((c) => c.share === 0), 'an empty month is an empty ladder, not NaN');
});

test('money spent without a category is counted, not dropped', () => {
  // Found by reading a real month back out of Postgres rather than by reasoning
  // about it: ₪75 left the account on an uncategorised row and appeared in no
  // figure on the screen — not in «הוצא», not in any envelope, not in the flow.
  // The headline says income minus spending; it was quietly income minus
  // *filed* spending, too kind by exactly what the household had not got round
  // to categorising.
  const cat = (id: number, name: string): Category => ({
    id, group_id: 1, group_name: 'ג', name, kind: 'spending', commitment: 'flexible',
    monthly_target: null, icon: null, sort_order: 0, archived_at: null,
  });
  const result = buildBudgetMonth({
    month: '2026-09-01',
    categories: [cat(1, 'סופר'), cat(9, 'משכורת')],
    allocations: [{ month: '2026-09-01', category_id: 1, allocated: 2500 }],
    spends: [
      { month: '2026-09-01', category_id: null, amount: 14_000 },  // income, unfiled
      { month: '2026-09-01', category_id: 1, amount: -1200 },
      { month: '2026-09-01', category_id: null, amount: -75 },     // spend, unfiled
    ],
  });

  assert.equal(result.unfiled, 75, 'the unfiled spend is not reported');
  assert.equal(result.spent, 1200, 'envelope spending stays envelope spending');
  assert.equal(result.flow.spent, 1275, 'the flow must count every shekel that left');
  assert.equal(result.flow.monthly, 12_725, '14,000 in, 1,275 out');

  // An uncategorised *deposit* is still income — that half was already right.
  assert.equal(result.income, 14_000);
});

test('a month with everything filed reports no unfiled spending', () => {
  const cat = (id: number, name: string): Category => ({
    id, group_id: 1, group_name: 'ג', name, kind: 'spending', commitment: 'flexible',
    monthly_target: null, icon: null, sort_order: 0, archived_at: null,
  });
  const result = buildBudgetMonth({
    month: '2026-09-01',
    categories: [cat(1, 'סופר')],
    allocations: [{ month: '2026-09-01', category_id: 1, allocated: 500 }],
    spends: [{ month: '2026-09-01', category_id: 1, amount: -120 }],
  });
  assert.equal(result.unfiled, 0);
  assert.equal(result.flow.spent, 120);
});
