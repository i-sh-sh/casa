import type { BudgetMonth, Commitment, EnvelopeRow, Transaction } from './types.js';

/**
 * What a figure on the budget screen is made of.
 *
 * Every total on that screen is a sum or a difference of things the household
 * typed or recorded. Tapping it should show those things — not a restatement
 * of the figure, but the rows themselves, so the sum can be redone by eye and
 * argued with. A number that cannot be checked is one people stop trusting,
 * and then stop opening.
 *
 * One invariant holds for every explanation here, and the tests enforce it:
 * **the lines add up to the total.** Subtractions are written as signed lines
 * («נכנס +X», «הוצא −Y») rather than as a formula, so there is only one
 * arithmetic to check. When the rows on hand cannot reach the total — the
 * transaction list is capped — `missing` says by how much, instead of the
 * bubble quietly showing a sum that disagrees with the number tapped.
 */
export interface ExplainLine {
  key: string;
  label: string;
  meta?: string;
  amount: number;
}

export interface Explanation {
  title: string;
  /** One sentence: how these lines become the figure. */
  how: string;
  lines: ExplainLine[];
  totalLabel: string;
  total: number;
  /** Lines are signed terms of a difference, so each shows its sign. */
  signed: boolean;
  /** total − Σ lines, after rounding. Zero when the lines are the whole story. */
  missing: number;
}

// Duplicated from money.ts on purpose: shared modules cannot import each other
// at runtime (Node's tests resolve .ts, Vercel resolves .js).
const COMMITMENT_NAMES: Record<Commitment, string> = {
  rigid: 'קשיחות',
  flexible: 'גמישות',
  liquid: 'נזילות',
  unplanned: 'לא צפויות',
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Shekels in running text: agorot are noise outside reconciliation (DESIGN.md §2). */
const whole = (n: number) => Math.round(n).toLocaleString('he-IL');

function finish(e: Omit<Explanation, 'missing'>): Explanation {
  const sum = e.lines.reduce((s, l) => s + l.amount, 0);
  return { ...e, missing: round2(e.total - sum) };
}

function shortDate(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)}.${Number(m)}`;
}

function byAmountDesc(a: ExplainLine, b: ExplainLine): number {
  return Math.abs(b.amount) - Math.abs(a.amount);
}

/** Rows the budget counts: this month, not a transfer between our own accounts. */
function counted(month: string, txs: Transaction[]): Transaction[] {
  const end = nextMonthKey(month);
  return txs.filter((t) => !t.transfer_id && t.occurred_on >= month && t.occurred_on < end);
}

function nextMonthKey(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

function txLine(t: Transaction, amount: number, withCategory: boolean): ExplainLine {
  const parts = [shortDate(t.occurred_on)];
  if (withCategory) parts.push(t.category_name ?? 'ללא קטגוריה');
  if (t.installment_no && t.installments_total) parts.push(`תשלום ${t.installment_no}/${t.installments_total}`);
  return { key: `t${t.id}`, label: t.payee || 'ללא שם', meta: parts.join(' · '), amount: round2(amount) };
}

function isIncome(t: Transaction, incomeIds: Set<number>): boolean {
  // The same rule as buildBudgetMonth: a category's kind decides, and only an
  // unfiled row is judged by its sign.
  return t.category_id != null ? incomeIds.has(t.category_id) : t.amount > 0;
}

export function explainIncome(budget: BudgetMonth, txs: Transaction[], incomeCategoryIds: number[]): Explanation {
  const ids = new Set(incomeCategoryIds);
  const lines = counted(budget.month, txs)
    .filter((t) => isIncome(t, ids))
    .map((t) => txLine(t, t.amount, true))
    .sort(byAmountDesc);
  return finish({
    title: 'נכנס',
    how: 'כל תנועה החודש בקטגוריית הכנסה, ותנועה חיובית שלא שויכה.',
    lines, totalLabel: 'סך נכנס', total: budget.income, signed: false,
  });
}

/** Everything that left this month: each envelope's spend, and what was filed nowhere. */
export function explainSpent(budget: BudgetMonth): Explanation {
  const lines: ExplainLine[] = budget.envelopes
    .filter((e) => e.spent !== 0)
    .map((e) => ({ key: `c${e.category_id}`, label: e.category_name, meta: e.group_name ?? undefined, amount: e.spent }))
    .sort(byAmountDesc);
  if (budget.unfiled) lines.push({ key: 'unfiled', label: 'ללא קטגוריה', amount: budget.unfiled });
  return finish({
    title: 'הוצא',
    how: 'מה שיצא החודש מכל קטגוריה, כולל מה שלא שויך לאף אחת.',
    lines, totalLabel: 'סך הוצא', total: budget.flow.spent, signed: false,
  });
}

export function explainFlow(budget: BudgetMonth): Explanation {
  return finish({
    title: 'תזרים חודשי',
    how: 'מה שנכנס פחות מה שיצא, באותו חודש.',
    lines: [
      { key: 'in', label: 'נכנס', amount: budget.flow.income },
      { key: 'out', label: 'הוצא', amount: round2(-budget.flow.spent) },
    ],
    totalLabel: 'תזרים', total: budget.flow.monthly, signed: true,
  });
}

export function explainAllocated(budget: BudgetMonth): Explanation {
  const lines = budget.envelopes
    .filter((e) => e.allocated !== 0)
    .map((e) => ({ key: `c${e.category_id}`, label: e.category_name, meta: e.group_name ?? undefined, amount: e.allocated }))
    .sort(byAmountDesc);
  return finish({
    title: 'תוקצב',
    how: 'הסכום שהוקצה החודש לכל קטגוריית הוצאה.',
    lines, totalLabel: 'סך תוקצב', total: budget.allocated, signed: false,
  });
}

export function explainUnbudgeted(budget: BudgetMonth): Explanation {
  return finish({
    title: 'לא תוקצב',
    how: 'מה שנכנס החודש פחות מה שהוקצה לקטגוריות. מספר שלילי אומר שהתקציב גדול מההכנסה.',
    lines: [
      { key: 'in', label: 'נכנס', amount: budget.income },
      { key: 'alloc', label: 'תוקצב', amount: round2(-budget.allocated) },
    ],
    totalLabel: 'לא תוקצב', total: budget.to_be_budgeted, signed: true,
  });
}

export function explainCommitment(budget: BudgetMonth, commitment: Commitment): Explanation {
  const slice = budget.commitments.find((c) => c.commitment === commitment);
  const lines = budget.envelopes
    .filter((e) => e.commitment === commitment && e.allocated !== 0)
    .map((e) => ({ key: `c${e.category_id}`, label: e.category_name, meta: e.group_name ?? undefined, amount: e.allocated }))
    .sort(byAmountDesc);
  const pct = Math.round((slice?.share ?? 0) * 100);
  return finish({
    title: COMMITMENT_NAMES[commitment],
    how: `הקטגוריות שסווגו «${COMMITMENT_NAMES[commitment]}», והסכום שהוקצה לכל אחת. ${pct}% הם החלק שלהן מתוך כל מה שתוקצב החודש.`,
    lines, totalLabel: `סך ${COMMITMENT_NAMES[commitment]}`, total: slice?.allocated ?? 0, signed: false,
  });
}

export function explainUnplanned(budget: BudgetMonth): Explanation {
  const { unplanned } = budget;
  const lines = budget.envelopes
    .filter((e) => e.commitment === 'unplanned' && e.allocated !== 0)
    .map((e) => ({ key: `c${e.category_id}`, label: e.category_name, amount: e.allocated }));
  const floor = round2(budget.allocated * unplanned.floor);
  return finish({
    title: 'לבלת״מ',
    how: `${Math.round(unplanned.floor * 100)}% מכל מה שתוקצב החודש הם ${whole(floor)} ש״ח. מה שהוקצה לקטגוריות «לא צפויות» מופיע כאן, וההפרש הוא מה שחסר.`,
    lines, totalLabel: 'הוקצה לבלת״מ', total: unplanned.allocated, signed: false,
  });
}

/** A group's «נשאר»: each envelope's own subtraction, then their sum. */
export function explainGroup(groupName: string, envelopes: EnvelopeRow[]): Explanation {
  const lines = envelopes.map((e) => ({
    key: `c${e.category_id}`,
    label: e.category_name,
    meta: `תוקצב ${whole(e.allocated)} פחות הוצא ${whole(e.spent)}`,
    amount: e.available,
  }));
  return finish({
    title: groupName,
    how: 'לכל קטגוריה בקבוצה: מה שתוקצב פחות מה שהוצא. סך הקבוצה הוא סכום השאריות.',
    lines, totalLabel: 'נשאר בקבוצה', total: round2(envelopes.reduce((s, e) => s + e.available, 0)), signed: true,
  });
}

/** The transactions behind one envelope's «הוצא». */
export function explainEnvelopeSpent(budget: BudgetMonth, env: EnvelopeRow, txs: Transaction[]): Explanation {
  const lines = counted(budget.month, txs)
    .filter((t) => t.category_id === env.category_id)
    .map((t) => txLine(t, -t.amount, false))
    .sort(byAmountDesc);
  return finish({
    title: `הוצא · ${env.category_name}`,
    how: 'כל תנועה החודש בקטגוריה הזאת. החזר נספר בחזרה, ולכן מופיע במינוס.',
    lines, totalLabel: 'סך הוצא', total: env.spent, signed: false,
  });
}

export function explainUnfiled(budget: BudgetMonth, txs: Transaction[], incomeCategoryIds: number[]): Explanation {
  const ids = new Set(incomeCategoryIds);
  const lines = counted(budget.month, txs)
    .filter((t) => t.category_id == null && !isIncome(t, ids))
    .map((t) => txLine(t, -t.amount, false))
    .sort(byAmountDesc);
  return finish({
    title: 'לא שויך לקטגוריה',
    how: 'תנועות שיצאו החודש בלי קטגוריה. הן בתזרים, אבל לא בשום מעטפה.',
    lines, totalLabel: 'סך לא שויך', total: budget.unfiled, signed: false,
  });
}

export function explainAhead(budget: BudgetMonth): Explanation {
  const ahead = budget.ahead;
  const lines = (ahead?.series ?? []).map((s) => ({
    key: `${s.payee}|${s.per_month}|${s.installments_total}`,
    label: s.payee,
    meta: `${s.remaining} תשלומים × ${whole(s.per_month)}`,
    amount: s.remaining_total,
  }));
  return finish({
    title: 'כבר מחויב לחודשים הבאים',
    how: 'לכל עסקה בתשלומים: התשלומים שנשארו כפול הסכום של תשלום אחד, לפי מה שנרשם.',
    lines, totalLabel: 'סך עוד לחייב', total: ahead?.total ?? 0, signed: false,
  });
}
