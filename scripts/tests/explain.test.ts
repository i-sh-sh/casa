import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBudgetMonth, futureCommitments } from '../../shared/money.ts';
import {
  explainAhead, explainAllocated, explainCommitment, explainEnvelopeSpent, explainFlow,
  explainGroup, explainIncome, explainSpent, explainUnbudgeted, explainUnfiled, explainUnplanned,
  type Explanation,
} from '../../shared/explain.ts';
import type { Category, Commitment, Transaction } from '../../shared/types.ts';

const MONTH = '2026-09-01';

const cat = (id: number, name: string, group: string, kind: Category['kind'] = 'spending', commitment: Commitment = 'flexible'): Category => ({
  id, group_id: 1, group_name: group, name, kind, commitment,
  monthly_target: null, icon: null, sort_order: 0, archived_at: null,
});

let nextId = 1;
const tx = (occurred_on: string, amount: number, category_id: number | null, payee: string, extra: Partial<Transaction> = {}): Transaction => ({
  id: nextId++, occurred_on, account_id: 1, account_name: 'אשראי', category_id, category_name: null,
  amount, payee, note: null, paid_by: null, split: 'shared', transfer_id: null,
  installment_no: null, installments_total: null, created_by: null, created_at: occurred_on,
  ...extra,
});

const categories = [
  cat(1, 'שכירות', 'דיור', 'spending', 'rigid'),
  cat(2, 'מזון', 'מכולת', 'spending', 'flexible'),
  cat(3, 'בלתי מתוכננות', 'לא צפויות', 'spending', 'unplanned'),
  cat(9, 'משכורת', 'הכנסות', 'income'),
];

const txs: Transaction[] = [
  tx('2026-09-01', 8000, 9, 'משכורת'),
  tx('2026-09-03', -3500, 1, 'בעל הבית'),
  tx('2026-09-14', -158.26, 2, 'רמי לוי'),
  tx('2026-09-20', -412.5, 2, 'שופרסל'),
  tx('2026-09-21', 40, 2, 'שופרסל', { note: 'החזר' }),
  tx('2026-09-22', -75, null, 'קיוסק'),
  tx('2026-09-23', 120, null, 'החזר ביט'),
  tx('2026-09-10', -211.33, 2, 'סאני תקשורת', { installment_no: 2, installments_total: 3 }),
  // Neither of these is in the month's budget, and neither may appear in a breakdown.
  tx('2026-09-05', -1000, null, 'לחיסכון', { transfer_id: 'x' }),
  tx('2026-08-30', -999, 2, 'אוגוסט'),
];

function budget() {
  const inMonth = txs.filter((t) => !t.transfer_id && t.occurred_on >= MONTH && t.occurred_on < '2026-10-01');
  const b = buildBudgetMonth({
    month: MONTH,
    categories,
    allocations: [
      { month: MONTH, category_id: 1, allocated: 3500 },
      { month: MONTH, category_id: 2, allocated: 1200 },
      { month: MONTH, category_id: 3, allocated: 100 },
    ],
    spends: inMonth.map((t) => ({ month: MONTH, category_id: t.category_id, amount: t.amount })),
  });
  return {
    ...b,
    ahead: futureCommitments(
      inMonth.filter((t) => t.installment_no).map((t) => ({
        occurred_on: t.occurred_on, payee: t.payee, amount: t.amount, category_name: 'מזון',
        installment_no: t.installment_no!, installments_total: t.installments_total!,
      })),
      MONTH,
    ),
  };
}

const sum = (e: Explanation) => Math.round(e.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;

test('every explanation adds up to the figure it explains', () => {
  const b = budget();
  const food = b.envelopes.find((e) => e.category_id === 2)!;
  const all = [
    explainIncome(b, txs, [9]),
    explainSpent(b),
    explainFlow(b),
    explainAllocated(b),
    explainUnbudgeted(b),
    ...(['rigid', 'flexible', 'liquid', 'unplanned'] as const).map((c) => explainCommitment(b, c)),
    explainUnplanned(b),
    explainGroup('מכולת', b.envelopes.filter((e) => e.group_name === 'מכולת')),
    explainEnvelopeSpent(b, food, txs),
    explainUnfiled(b, txs, [9]),
    explainAhead(b),
  ];
  for (const e of all) {
    assert.equal(e.missing, 0, `${e.title}: lines ${sum(e)} ≠ total ${e.total}`);
    assert.equal(sum(e), e.total, e.title);
  }
});

test('income is the rows themselves, filed or not, and never a transfer', () => {
  const e = explainIncome(budget(), txs, [9]);
  assert.deepEqual(e.lines.map((l) => l.label), ['משכורת', 'החזר ביט']);
  assert.equal(e.total, 8120);
});

test('a refund inside an envelope is shown as a negative spend', () => {
  const b = budget();
  const e = explainEnvelopeSpent(b, b.envelopes.find((x) => x.category_id === 2)!, txs);
  assert.ok(e.lines.some((l) => l.label === 'שופרסל' && l.amount === -40));
  assert.ok(!e.lines.some((l) => l.label === 'אוגוסט'), 'last month is not in this month');
  assert.match(e.lines.find((l) => l.label === 'סאני תקשורת')!.meta!, /תשלום 2\/3/);
});

test('the ladder rung lists only its own categories', () => {
  const e = explainCommitment(budget(), 'rigid');
  assert.deepEqual(e.lines.map((l) => l.label), ['שכירות']);
  assert.equal(e.total, 3500);
});

test('differences are signed terms, so the same sum checks them', () => {
  const e = explainUnbudgeted(budget());
  assert.ok(e.signed);
  assert.deepEqual(e.lines.map((l) => l.amount), [8120, -4800]);
  assert.equal(e.total, 3320);
});

test('a capped list says how much it could not show', () => {
  const b = budget();
  const e = explainIncome(b, txs.filter((t) => t.payee !== 'החזר ביט'), [9]);
  assert.equal(e.missing, 120);
});
