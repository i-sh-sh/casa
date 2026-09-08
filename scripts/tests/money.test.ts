import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceDue, buildBudgetMonth, computeBalance, formatILS,
  monthKey, nextMonth, previousMonth, round2,
} from '../../shared/money.ts';
import type { Category } from '../../shared/types.ts';

const cat = (id: number, name: string, kind: Category['kind'] = 'spending'): Category => ({
  id, group_id: 1, group_name: 'קבוצה', name, kind,
  monthly_target: null, icon: null, sort_order: 0, archived_at: null,
});

// ── Arithmetic ───────────────────────────────────────────────────────────

test('round2 kills float dust', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(-0.1 - 0.2), -0.3);
  assert.equal(round2(1234.567), 1234.57);
});

test('month keys always land on the first', () => {
  assert.equal(monthKey('2026-09-17'), '2026-09-01');
  assert.equal(monthKey(new Date(2026, 0, 31)), '2026-01-01');
  assert.equal(previousMonth('2026-01-01'), '2025-12-01');
  assert.equal(nextMonth('2026-12-01'), '2027-01-01');
});

test('a bill due on the 31st does not roll into the next month', () => {
  // The whole reason advanceDue clamps: rolling over would push a January
  // bill past its own reminder window every February.
  assert.equal(advanceDue('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(advanceDue('2028-01-31', 'monthly'), '2028-02-29');
  assert.equal(advanceDue('2026-03-31', 'monthly'), '2026-04-30');
  assert.equal(advanceDue('2026-01-15', 'quarterly'), '2026-04-15');
  assert.equal(advanceDue('2026-11-10', 'quarterly'), '2027-02-10');
  assert.equal(advanceDue('2026-06-01', 'yearly'), '2027-06-01');
  assert.equal(advanceDue('2026-06-01', 'bimonthly'), '2026-08-01');
});

// ── Envelopes ────────────────────────────────────────────────────────────

test('an untouched envelope is empty, not missing', () => {
  const result = buildBudgetMonth({
    month: '2026-03-01',
    categories: [cat(1, 'סופר')],
    allocations: [],
    spends: [],
  });
  assert.equal(result.envelopes.length, 1);
  assert.deepEqual(
    { allocated: result.envelopes[0]!.allocated, spent: result.envelopes[0]!.spent, available: result.envelopes[0]!.available },
    { allocated: 0, spent: 0, available: 0 },
  );
});

test('available rolls forward — the reason the model is worth having', () => {
  // ביטוח רכב: ₪250 a month for two months, nothing spent. In month three the
  // envelope holds ₪750, not ₪250. A per-month view would call the ₪700 bill a
  // disaster; it is exactly the plan working.
  const categories = [cat(1, 'ביטוח רכב')];
  const allocations = [
    { month: '2026-01-01', category_id: 1, allocated: 250 },
    { month: '2026-02-01', category_id: 1, allocated: 250 },
    { month: '2026-03-01', category_id: 1, allocated: 250 },
  ];
  const march = buildBudgetMonth({ month: '2026-03-01', categories, allocations, spends: [] });
  assert.equal(march.envelopes[0]!.available, 750);
  assert.equal(march.envelopes[0]!.allocated, 250, 'this month allocated stays this month');

  const afterBill = buildBudgetMonth({
    month: '2026-03-01', categories, allocations,
    spends: [{ month: '2026-03-01', category_id: 1, amount: -700 }],
  });
  assert.equal(afterBill.envelopes[0]!.available, 50);
  assert.equal(afterBill.envelopes[0]!.spent, 700, 'spent is reported positive');
});

test('a future month never leaks into the present', () => {
  const result = buildBudgetMonth({
    month: '2026-03-01',
    categories: [cat(1, 'סופר')],
    allocations: [
      { month: '2026-03-01', category_id: 1, allocated: 100 },
      { month: '2026-04-01', category_id: 1, allocated: 900 },
    ],
    spends: [{ month: '2026-04-01', category_id: 1, amount: -400 }],
  });
  assert.equal(result.envelopes[0]!.available, 100);
  assert.equal(result.envelopes[0]!.spent, 0);
});

test('overspending carries as a debt, it does not reset', () => {
  // YNAB quietly zeroes an overspent envelope next month. Kinder, less honest:
  // the money still has to come from somewhere, and here it keeps saying so.
  const categories = [cat(1, 'מסעדות')];
  const allocations = [
    { month: '2026-01-01', category_id: 1, allocated: 300 },
    { month: '2026-02-01', category_id: 1, allocated: 300 },
  ];
  const result = buildBudgetMonth({
    month: '2026-02-01', categories, allocations,
    spends: [{ month: '2026-01-01', category_id: 1, amount: -800 }],
  });
  assert.equal(result.envelopes[0]!.available, -200);
});

test('a refund gives the money back to its envelope, it is not a payday', () => {
  const result = buildBudgetMonth({
    month: '2026-03-01',
    categories: [cat(1, 'ביגוד')],
    allocations: [{ month: '2026-03-01', category_id: 1, allocated: 300 }],
    spends: [{ month: '2026-03-01', category_id: 1, amount: 120 }],
  });
  assert.equal(result.envelopes[0]!.available, 420, 'the refund lands back in the envelope');
  assert.equal(result.income, 0, 'and never counts as income');
});

test('income fills the pool rather than an envelope', () => {
  const result = buildBudgetMonth({
    month: '2026-03-01',
    categories: [cat(1, 'סופר'), cat(9, 'משכורת', 'income')],
    allocations: [{ month: '2026-03-01', category_id: 1, allocated: 2000 }],
    spends: [
      { month: '2026-03-01', category_id: 9, amount: 12000 },
      { month: '2026-03-01', category_id: 1, amount: -1500 },
    ],
  });
  assert.equal(result.envelopes.length, 1, 'income categories are not envelopes');
  assert.equal(result.income, 12000);
  assert.equal(result.to_be_budgeted, 10000, '12,000 in, 2,000 given a job');
  assert.equal(result.spent, 1500);
});

test('an uncategorised deposit is income; an uncategorised spend is in no envelope', () => {
  const result = buildBudgetMonth({
    month: '2026-03-01',
    categories: [cat(1, 'סופר')],
    allocations: [],
    spends: [
      { month: '2026-03-01', category_id: null, amount: 500 },
      { month: '2026-03-01', category_id: null, amount: -80 },
    ],
  });
  assert.equal(result.income, 500);
  assert.equal(result.spent, 0);
  assert.equal(result.to_be_budgeted, 500);
});

test('archived categories drop out of the month', () => {
  const archived: Category = { ...cat(2, 'חדר כושר'), archived_at: '2026-02-01T00:00:00Z' };
  const result = buildBudgetMonth({
    month: '2026-03-01',
    categories: [cat(1, 'סופר'), archived],
    allocations: [],
    spends: [],
  });
  assert.deepEqual(result.envelopes.map((e) => e.category_name), ['סופר']);
});

// ── Who owes whom ────────────────────────────────────────────────────────

const us = [
  { email: 'a@x.com', display_name: 'א' },
  { email: 'b@x.com', display_name: 'ב' },
];

test('one person pays for everything: the other owes half', () => {
  const balance = computeBalance({
    members: us,
    spends: [{ amount: -400, paid_by: 'a@x.com', split: 'shared' }],
    settlements: [],
  });
  assert.equal(balance.amount, 200);
  assert.equal(balance.from_email, 'b@x.com');
  assert.equal(balance.to_email, 'a@x.com');
});

test('personal spending never enters the balance', () => {
  const balance = computeBalance({
    members: us,
    spends: [
      { amount: -400, paid_by: 'a@x.com', split: 'shared' },
      { amount: -1000, paid_by: 'b@x.com', split: 'personal' },
    ],
    settlements: [],
  });
  assert.equal(balance.amount, 200);
  assert.equal(balance.from_email, 'b@x.com', 'the personal ₪1,000 buys no credit');
});

test('paying each other back squares the account without inventing a purchase', () => {
  const balance = computeBalance({
    members: us,
    spends: [{ amount: -400, paid_by: 'a@x.com', split: 'shared' }],
    settlements: [{ from_email: 'b@x.com', to_email: 'a@x.com', amount: 200 }],
  });
  assert.equal(balance.amount, 0);
  assert.equal(balance.from_email, null);
  const perPerson = Object.fromEntries(balance.per_person.map((p) => [p.email, p.net]));
  assert.equal(perPerson['a@x.com'], 0);
  assert.equal(perPerson['b@x.com'], 0);
});

test('an even split of an odd amount does not leave a phantom debt', () => {
  const balance = computeBalance({
    members: us,
    spends: [
      { amount: -100.01, paid_by: 'a@x.com', split: 'shared' },
      { amount: -100.01, paid_by: 'b@x.com', split: 'shared' },
    ],
    settlements: [],
  });
  assert.equal(balance.amount, 0);
});

test('a spend nobody fronted is household money, not a debt to anyone', () => {
  const balance = computeBalance({
    members: us,
    spends: [{ amount: -300, paid_by: null, split: 'shared' }],
    settlements: [],
  });
  // Both owe 150 and neither paid, so they are equally out of pocket.
  assert.equal(balance.amount, 0);
  assert.equal(balance.per_person.every((p) => p.net === -150), true);
});

test('income is not a shared cost', () => {
  const balance = computeBalance({
    members: us,
    spends: [{ amount: 9000, paid_by: 'a@x.com', split: 'shared' }],
    settlements: [],
  });
  assert.equal(balance.amount, 0);
});

// ── Presentation ─────────────────────────────────────────────────────────

test('amounts read as shekels, with a real minus sign', () => {
  assert.equal(formatILS(1234), '₪1,234');
  assert.equal(formatILS(-50), '−₪50');
  assert.match(formatILS(-50), /^−/, 'U+2212, not a hyphen — it aligns with digits');
  assert.equal(formatILS(80, { sign: true }), '+₪80');
});

test('agorot are suppressed unless the exact figure is the point', () => {
  // A column of ₪1,240.00 scans worse than a column of ₪1,240, and the
  // trailing zeros carry no information. Detail views opt back in.
  assert.equal(formatILS(12.5), '₪13', 'rounded in an overview');
  assert.equal(formatILS(12.5, { agorot: true }), '₪12.50', 'exact on a transaction');
  assert.equal(formatILS(12, { agorot: true }), '₪12', 'a whole amount never grows .00');
});

test('the symbol can be dropped, because a column head carries it once', () => {
  assert.equal(formatILS(1234, { symbol: false }), '1,234');
  assert.equal(formatILS(-1234, { symbol: false }), '−1,234');
});
