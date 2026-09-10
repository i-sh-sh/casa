import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBudgetMonth, round2 } from '../../shared/money.ts';
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
 * It used to do more: roll balances between months, split the month into a
 * ladder of rigid/flexible/liquid/unplanned, hold a 5% floor for the
 * unforeseen, offer a three-month average as a suggestion, and fill a whole
 * month from targets that shipped in the seed. Every one of those was a number
 * on the screen that nobody in the house had chosen, and the request that
 * removed them was «בלי הזרקות חיצוניות».
 *
 * These tests are what stops any of it coming back by accident.
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

test('the seed ships names, never amounts', () => {
  // A structure worth suggesting; figures that were only ever plausible.
  const seed = code(read('api/admin/_seed.ts'));
  const categories = seed.slice(seed.indexOf('INSERT INTO categories'), seed.indexOf('INSERT INTO accounts'));
  assert.ok(!/monthly_target/.test(categories), 'the seed sets a monthly target');
  assert.ok(!/\b(rigid|flexible|liquid|unplanned)\b/.test(categories), 'the seed sets a commitment rung');
  // Every VALUES row is (group, name, kind, order) — four fields, no figure.
  const rows = [...categories.matchAll(/\('[^']+',\s*'[^']+',\s*'(spending|income|saving)',\s*\d+\)/g)];
  assert.ok(rows.length >= 25, `expected the seeded categories, found ${rows.length}`);
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
  for (const gone of ['Ladder', 'Projection', 'autofill', 'average', 'monthly_target', 'COMMITMENT']) {
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
  for (const gone of ['categoryAverages', 'commitmentBreakdown', 'unplannedCheck', 'UNPLANNED_FLOOR']) {
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
  for (const claim of ['43,200', 'הסולם', 'קשיחות', 'רמת מחויבות', 'בפועל · ₪']) {
    assert.ok(!guide.includes(claim), `the guide still promises «${claim}»`);
  }
});
