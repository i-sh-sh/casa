import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceDue, buildBudgetMonth, cashFlow, computeBalance,
  formatILS, monthKey, nextMonth, previousMonth, round2,
} from '../../shared/money.ts';
import type { Category } from '../../shared/types.ts';

const cat = (id: number, name: string, kind: Category['kind'] = 'spending'): Category => ({
  id, group_id: 1, group_name: 'קבוצה', name, kind, commitment: 'flexible',
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

test('nothing carries: a month is only itself', () => {
  // The rule the whole model now rests on, and the one that replaced rollover.
  // Three months at ₪250 with nothing spent used to leave ₪750 sitting in
  // March. It now leaves ₪250 — the figure somebody typed for March, minus
  // what March spent, and nothing else.
  const categories = [cat(1, 'ביטוח רכב')];
  const allocations = [
    { month: '2026-01-01', category_id: 1, allocated: 250 },
    { month: '2026-02-01', category_id: 1, allocated: 250 },
    { month: '2026-03-01', category_id: 1, allocated: 250 },
  ];
  const march = buildBudgetMonth({ month: '2026-03-01', categories, allocations, spends: [] });
  assert.equal(march.envelopes[0]!.available, 250, 'January and February are not in March');
  assert.equal(march.envelopes[0]!.allocated, 250);

  const afterBill = buildBudgetMonth({
    month: '2026-03-01', categories, allocations,
    spends: [{ month: '2026-03-01', category_id: 1, amount: -700 }],
  });
  assert.equal(afterBill.envelopes[0]!.available, -450, '250 budgeted, 700 spent');
  assert.equal(afterBill.envelopes[0]!.spent, 700, 'spent is reported positive');
});

test('every figure is a subtraction of two figures on the same screen', () => {
  // What makes the model arguable: available is allocated − spent, always, for
  // every envelope. If that ever stops holding, somebody is being shown a
  // number they cannot reconstruct.
  const result = buildBudgetMonth({
    month: '2026-03-01',
    categories: [cat(1, 'סופר'), cat(2, 'דלק'), cat(3, 'מסעדות')],
    allocations: [
      { month: '2026-03-01', category_id: 1, allocated: 2000 },
      { month: '2026-03-01', category_id: 2, allocated: 600 },
    ],
    spends: [
      { month: '2026-03-01', category_id: 1, amount: -1750.5 },
      { month: '2026-03-01', category_id: 3, amount: -80 },
    ],
  });
  for (const e of result.envelopes) {
    assert.equal(e.available, round2(e.allocated - e.spent), `${e.category_name} does not add up`);
  }
  assert.equal(result.allocated, 2600);
  assert.equal(result.spent, 1830.5);
});

test('no other month leaks into this one, in either direction', () => {
  const result = buildBudgetMonth({
    month: '2026-03-01',
    categories: [cat(1, 'סופר')],
    allocations: [
      { month: '2026-02-01', category_id: 1, allocated: 500 },
      { month: '2026-03-01', category_id: 1, allocated: 100 },
      { month: '2026-04-01', category_id: 1, allocated: 900 },
    ],
    spends: [
      { month: '2026-02-01', category_id: 1, amount: -250 },
      { month: '2026-04-01', category_id: 1, amount: -400 },
    ],
  });
  assert.equal(result.envelopes[0]!.available, 100, 'February and April are not March');
  assert.equal(result.envelopes[0]!.spent, 0);
});

test('last month\'s overspend does not follow the category into this one', () => {
  // It used to. The argument was honesty — the money really did have to come
  // from somewhere — and the cost was a category that read ₪200 short in a
  // month it had not overspent, for a reason five weeks in the past.
  const categories = [cat(1, 'מסעדות')];
  const allocations = [
    { month: '2026-01-01', category_id: 1, allocated: 300 },
    { month: '2026-02-01', category_id: 1, allocated: 300 },
  ];
  const result = buildBudgetMonth({
    month: '2026-02-01', categories, allocations,
    spends: [{ month: '2026-01-01', category_id: 1, amount: -800 }],
  });
  assert.equal(result.envelopes[0]!.available, 300, 'February starts at what February was given');
});

test('a refund gives the money back to its envelope, it is not a payday', () => {
  const result = buildBudgetMonth({
    month: '2026-03-01',
    categories: [cat(1, 'ביגוד')],
    allocations: [{ month: '2026-03-01', category_id: 1, allocated: 300 }],
    spends: [{ month: '2026-03-01', category_id: 1, amount: 120 }],
  });
  assert.equal(result.envelopes[0]!.available, 420, 'the refund lands back in the envelope');
  assert.equal(result.envelopes[0]!.spent, -120, 'a refund is a negative spend, not income');
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

// ── Cash flow, said out loud ─────────────────────────────────────────────

test('cash flow is income minus spending, and stops there', () => {
  // It used to also carry monthly × 12 and × 36. That was a rhetorical device
  // — «₪1,200 short» is shrugged at, «₪43,200 over three years» is not — and
  // it sat on the screen in the same typeface as figures the household had
  // typed, which is what made it the wrong thing for this app to say.
  const short = cashFlow(12_000, 13_200);
  assert.equal(short.monthly, -1200);
  assert.deepEqual(Object.keys(short).sort(), ['income', 'monthly', 'spent']);

  const good = cashFlow(14_000, 11_000);
  assert.equal(good.monthly, 3000);
});

test('a month reports what went in, what went out, and what was not budgeted', () => {
  const result = buildBudgetMonth({
    month: '2026-03-01',
    categories: [cat(1, 'סופר'), cat(2, 'דלק'), cat(9, 'משכורת', 'income')],
    allocations: [
      { month: '2026-03-01', category_id: 1, allocated: 2000 },
      { month: '2026-03-01', category_id: 2, allocated: 600 },
    ],
    spends: [
      { month: '2026-03-01', category_id: 9, amount: 14_000 },
      { month: '2026-03-01', category_id: 1, amount: -1800 },
      { month: '2026-03-01', category_id: 2, amount: -720 },
    ],
  });

  assert.equal(result.income, 14_000);
  assert.equal(result.allocated, 2600);
  assert.equal(result.spent, 2520);
  // Income this month, minus what this month's budget claims. Not a running
  // account of every month since the household started.
  assert.equal(result.to_be_budgeted, 11_400);
  assert.equal(result.flow.monthly, 11_480);

  const fuel = result.envelopes.find((e) => e.category_id === 2)!;
  assert.equal(fuel.available, -120, 'over by 120, this month, for this month\'s reason');
});

test('an earlier month\'s income does not inflate what is left to budget', () => {
  const result = buildBudgetMonth({
    month: '2026-03-01',
    categories: [cat(1, 'סופר'), cat(9, 'משכורת', 'income')],
    allocations: [{ month: '2026-03-01', category_id: 1, allocated: 500 }],
    spends: [
      { month: '2026-01-01', category_id: 9, amount: 14_000 },
      { month: '2026-02-01', category_id: 9, amount: 14_000 },
      { month: '2026-03-01', category_id: 9, amount: 14_000 },
    ],
  });
  assert.equal(result.income, 14_000, 'one month of income, not three');
  assert.equal(result.to_be_budgeted, 13_500);
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
