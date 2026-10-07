import type {
  BudgetMonth, EnvelopeRow, Category, BalanceBetweenUs, CashFlow,
  Commitment, CommitmentSlice, FutureCommitments, InstallmentSeries, UnplannedCheck,
} from './types.js';

/**
 * The ladder, from least control to most. Order matters — it is how it reads.
 *
 * This is a *classification*, not a figure: it says what could be done about a
 * category, and it changes no amount anywhere. That distinction is why it came
 * back after the clear-out — «בלי הזרקות חיצוניות» was about numbers the app
 * invented and put in the household's budget, and this invents nothing. It
 * reads what they typed and groups it.
 *
 * What it answers is the only question worth asking when a month does not
 * work: «לצמצם הוצאות» is not advice, and «מתוך ₪9,700 — ₪3,570 קשיחות ו-₪1,450
 * נזילות» is, because it points at the part that can actually move.
 */
export const COMMITMENTS: readonly Commitment[] = ['rigid', 'flexible', 'liquid', 'unplanned'];

export const COMMITMENT_LABELS: Record<Commitment, string> = {
  rigid: 'קשיחות',
  flexible: 'גמישות',
  liquid: 'נזילות',
  unplanned: 'לא צפויות',
};

export const COMMITMENT_NOTES: Record<Commitment, string> = {
  rigid: 'קבועות, או כאלה שקשה לשנות',
  flexible: 'חייבים לשלם משהו — כמה, זה חלקית בידינו',
  liquid: 'החלטה מלאה שלנו. כאן נחסך חודש',
  unplanned: 'מה שלא רואים מראש, ודווקא לכן מתקצבים',
};

/**
 * The share of the month to set aside for the unforeseen: 5%.
 *
 * Also a reading rather than an injection. It never writes a shekel into any
 * envelope and never fills a box — it looks at what the household allocated and
 * says whether the part they set aside for what they cannot see coming clears
 * the floor, and by how much it misses.
 */
export const UNPLANNED_FLOOR = 0.05;

/*
 * ═════════════════════════════════════════════════════════════════════════
 *  One month at a time.
 * ═════════════════════════════════════════════════════════════════════════
 *
 * This module used to carry a method: envelopes that rolled over, a ladder of
 * rigid/flexible/liquid/unplanned, a 5% floor for the unforeseen, three-month
 * averages, a projection of the deficit over one year and three. Every one of
 * those put a number on the screen that nobody in the household had typed.
 *
 * The complaint that removed them was the right one: a budget you cannot
 * recompute in your head is a budget you cannot trust or argue with. Rollover
 * was the worst of it — «נשאר» was everything ever allocated minus everything
 * ever spent, so a category could read ₪800 remaining in a month it had been
 * given ₪200, and the explanation lived eleven months back.
 *
 * What is left is the arithmetic a person does on paper:
 *
 *     נשאר = תקצבתם החודש − הוצאתם החודש
 *
 * Nothing crosses a month boundary. Nothing is filled in for you. Every figure
 * on the budget screen is a subtraction between two numbers that are also on
 * the screen.
 */

/**
 * Shekels, to the agora, without float dust.
 *
 * Every amount in this app is a NUMERIC(12,2) in the database and a JS number
 * in memory. That is exactly representable up to far beyond any household
 * budget — but the *arithmetic* still drifts (0.1 + 0.2), and a budget that
 * shows ₪‑0.00 remaining looks broken even when it is off by a billionth.
 * Every computed amount goes through here.
 */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 'YYYY-MM-01' — the canonical key for a budget month. */
export function monthKey(input: Date | string): string {
  if (typeof input === 'string') {
    // Already a date string: take the year and month, force day 01.
    const m = /^(\d{4})-(\d{2})/.exec(input);
    if (!m) throw new Error(`not a date: ${input}`);
    return `${m[1]}-${m[2]}-01`;
  }
  const y = input.getFullYear();
  const mo = String(input.getMonth() + 1).padStart(2, '0');
  return `${y}-${mo}-01`;
}

/** The month before `month`, same format. */
export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
}

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

const CADENCE_MONTHS: Record<string, number> = { monthly: 1, bimonthly: 2, quarterly: 3, yearly: 12 };

/**
 * The next date a recurring bill falls due.
 *
 * Clamps to the end of the month rather than rolling over: a bill charged on
 * the 31st is due on the 28th in February, not on the 3rd of March. Rolling
 * over would silently move a bill past its own reminder window once a year.
 */
export function advanceDue(due: string, cadence: string): string {
  const [y, m, d] = due.split('-').map(Number) as [number, number, number];
  const step = CADENCE_MONTHS[cadence] ?? 1;
  const totalMonths = (y * 12) + (m - 1) + step;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface AllocationInput {
  month: string;
  category_id: number;
  allocated: number;
}

export interface SpendInput {
  /** The month the transaction fell in, as a month key. */
  month: string;
  category_id: number | null;
  /** Signed: negative is a spend, positive is income or a refund. */
  amount: number;
}

/**
 * Turns this month's allocations and this month's transactions into envelopes.
 *
 * The whole rule: **nothing crosses a month boundary.** An allocation belongs
 * to the month it was made for, a spend to the month it happened in, and
 * `available` is the difference between the two. September knows nothing about
 * August.
 *
 * The version this replaces carried balances forward, which is the stronger
 * model on paper and the one that made the screen unreadable: «נשאר» was every
 * allocation ever minus every spend ever, so a category funded ₪200 this month
 * could show ₪800 remaining, and the reason was somewhere in the spring. An
 * overspend behaved worse — it followed the category around until somebody
 * found it.
 *
 * The cost of dropping it is real and worth naming: a category that is ₪250 a
 * month for eleven months and ₪2,750 in the twelfth now reads as a disaster in
 * December. That is a saving, and savings belong in an account, not in an
 * envelope that quietly remembers.
 */
export function buildBudgetMonth(params: {
  month: string;
  categories: Category[];
  allocations: AllocationInput[];
  spends: SpendInput[];
}): BudgetMonth {
  const { month, categories, allocations, spends } = params;

  const allocated = new Map<number, number>();
  for (const a of allocations) {
    if (a.month !== month) continue;
    allocated.set(a.category_id, (allocated.get(a.category_id) ?? 0) + a.allocated);
  }

  // `spent` is reported positive because "הוצאנו 1,200" is how it is read,
  // while the stored amount is negative. The two never meet: the sign flip
  // happens once, here.
  const spent = new Map<number, number>();
  let income = 0;
  // Money that left the account without a category. It belongs to no envelope,
  // and it is still spent — see `unfiled` below for why that distinction was
  // costing the month its honesty.
  let unfiled = 0;

  const incomeCategoryIds = new Set(categories.filter((c) => c.kind === 'income').map((c) => c.id));

  for (const s of spends) {
    if (s.month !== month) continue;
    // What counts as income is the category's *kind*, not the sign. A grocery
    // month with more refunds than purchases is not a payday; it is a spending
    // envelope with a negative spend, which correctly gives the money back.
    // Only an uncategorised row has to be judged by its sign, and there a
    // positive amount really is money arriving that nobody has filed yet.
    const isIncome = s.category_id != null
      ? incomeCategoryIds.has(s.category_id)
      : s.amount > 0;
    if (isIncome) {
      income += s.amount;
      continue;
    }
    if (s.category_id == null) {
      unfiled += -s.amount;
      continue;
    }
    spent.set(s.category_id, (spent.get(s.category_id) ?? 0) + -s.amount);
  }

  const envelopes: EnvelopeRow[] = categories
    .filter((c) => c.kind !== 'income' && !c.archived_at)
    .map((c) => {
      const put = round2(allocated.get(c.id) ?? 0);
      const took = round2(spent.get(c.id) ?? 0);
      return {
        category_id: c.id,
        category_name: c.name,
        group_id: c.group_id,
        group_name: c.group_name,
        kind: c.kind,
        commitment: c.commitment,
        allocated: put,
        spent: took,
        available: round2(put - took),
      };
    });

  const allocatedTotal = round2(envelopes.reduce((sum, e) => sum + e.allocated, 0));
  const spentTotal = round2(envelopes.reduce((sum, e) => sum + e.spent, 0));

  return {
    month,
    envelopes,
    income: round2(income),
    allocated: allocatedTotal,
    spent: spentTotal,
    // Spent, but in no envelope. A transaction saved without a category is the
    // easiest thing in the app to produce — the category field is optional, and
    // in a queue it gets skipped.
    //
    // It used to be dropped on the floor here, which made the month's headline
    // quietly false: «הכנסות פחות הוצאות» counted only the spending that had
    // been filed, so a household with a few unfiled rows was shown a flow that
    // was too kind by exactly the amount it had failed to categorise. Found by
    // reading a real month back out of Postgres rather than by reasoning about
    // it: ₪75 left the account and appeared in no figure on the screen.
    unfiled: round2(unfiled),
    to_be_budgeted: round2(round2(income) - allocatedTotal),
    // Every shekel that left, filed or not. This is the one figure on the
    // screen that claims to be about the account rather than about the budget.
    flow: cashFlow(round2(income), round2(spentTotal + unfiled)),
    // Two readings of the same allocations, neither of which changes one.
    commitments: commitmentBreakdown(envelopes),
    unplanned: unplannedCheck(envelopes),
  };
}

/**
 * The month split by how much control the household has over it.
 *
 * Computed from this month's allocations only, like everything else here.
 */
export function commitmentBreakdown(envelopes: EnvelopeRow[]): CommitmentSlice[] {
  const totalAllocated = envelopes.reduce((sum, e) => sum + e.allocated, 0);
  return COMMITMENTS.map((commitment) => {
    const mine = envelopes.filter((e) => e.commitment === commitment);
    const allocated = round2(mine.reduce((sum, e) => sum + e.allocated, 0));
    return {
      commitment,
      allocated,
      spent: round2(mine.reduce((sum, e) => sum + e.spent, 0)),
      // No allocation at all is 0%, not NaN — a month before anyone has
      // budgeted must render as an empty ladder, not as broken arithmetic.
      share: totalAllocated > 0 ? round2(allocated / totalAllocated) : 0,
    };
  });
}

/** Whether enough is set aside for the things nobody sees coming. */
export function unplannedCheck(envelopes: EnvelopeRow[]): UnplannedCheck {
  const totalAllocated = envelopes.reduce((sum, e) => sum + e.allocated, 0);
  const allocated = round2(
    envelopes.filter((e) => e.commitment === 'unplanned').reduce((sum, e) => sum + e.allocated, 0),
  );
  const share = totalAllocated > 0 ? allocated / totalAllocated : 0;
  const required = totalAllocated * UNPLANNED_FLOOR;
  return {
    allocated,
    share: round2(share),
    floor: UNPLANNED_FLOOR,
    // An empty month passes: there is nothing yet to be under-provisioned
    // against, and nagging before the first allocation teaches people to
    // ignore the warning that matters later.
    meets_floor: totalAllocated === 0 || allocated >= required,
    shortfall: totalAllocated === 0 ? 0 : round2(Math.max(0, required - allocated)),
  };
}

/**
 * Income minus spending. That is the entire function.
 *
 * It used to also multiply a deficit by 12 and 36 and put both on the screen.
 * The argument for it was that «₪1,200 short this month» is shrugged at and
 * «₪43,200 over three years» is not — which is true, and is exactly why it was
 * the wrong thing for this app to say: it is a rhetorical device wearing the
 * clothes of a measurement, and it appeared beside real figures the household
 * had typed themselves.
 */
export function cashFlow(income: number, spent: number): CashFlow {
  return {
    income: round2(income),
    spent: round2(spent),
    monthly: round2(income - spent),
  };
}

// ── Installments ─────────────────────────────────────────────────────────

export interface InstallmentInput {
  occurred_on: string;
  payee: string;
  category_name: string | null;
  /** Signed, as stored. */
  amount: number;
  installment_no: number;
  installments_total: number;
}

/**
 * What installment purchases have already spent of the months to come.
 *
 * docs/PLAN.md §5, from the course the budget method comes from: ₪400 of
 * groceries split into four is ₪100 a month that looks cheap, and done every
 * month it is ₪400 a month regardless — plus ₪600 owed forward that no screen
 * shows. This is that ₪600, and nothing more: a sum of rows the household
 * recorded, each one saying «2 of 3».
 *
 * One series is one payee, one amount and one count. Its latest recorded
 * installment says how many are left. A series counts only if that latest
 * installment fell in `month` or the month before: a card statement is
 * imported once a month, and a series whose next charge never arrived was
 * cancelled or refunded, not still owed.
 */
export function futureCommitments(rows: InstallmentInput[], month: string): FutureCommitments {
  const from = previousMonth(month);
  const until = nextMonth(month);
  const latest = new Map<string, InstallmentInput>();
  for (const r of rows) {
    if (r.occurred_on < from || r.occurred_on >= until) continue;
    const key = `${r.payee.trim().toLowerCase()}|${round2(Math.abs(r.amount))}|${r.installments_total}`;
    const seen = latest.get(key);
    if (!seen || r.installment_no > seen.installment_no) latest.set(key, r);
  }
  const series: InstallmentSeries[] = [];
  for (const r of latest.values()) {
    const remaining = r.installments_total - r.installment_no;
    if (remaining <= 0) continue;
    const per = round2(Math.abs(r.amount));
    series.push({
      payee: r.payee, category_name: r.category_name, per_month: per,
      installment_no: r.installment_no, installments_total: r.installments_total,
      remaining, remaining_total: round2(per * remaining),
    });
  }
  series.sort((a, b) => b.remaining_total - a.remaining_total);
  return {
    series,
    next_month: round2(series.reduce((s, x) => s + x.per_month, 0)),
    total: round2(series.reduce((s, x) => s + x.remaining_total, 0)),
  };
}

// ── Who owes whom ────────────────────────────────────────────────────────

export interface SharedSpendInput {
  amount: number;      // signed, as stored
  paid_by: string | null;
  split: 'shared' | 'personal';
}

export interface SettlementInput {
  from_email: string;
  to_email: string;
  amount: number;
}

/**
 * The Splitwise half: what the household spent is one question, who is out of
 * pocket for it is another.
 *
 * Shared spends are divided equally among `members` — not among whoever
 * happens to have paid for something, which would make the split depend on who
 * was at the till. A `personal` spend never enters the calculation at all, and
 * a spend with no `paid_by` is treated as household money nobody fronted.
 *
 * A settlement moves the needle without pretending to be a purchase: paying
 * someone back increases what you have paid, and decreases what they have.
 */
export function computeBalance(params: {
  members: { email: string; display_name: string }[];
  spends: SharedSpendInput[];
  settlements: SettlementInput[];
}): BalanceBetweenUs {
  const { members, spends, settlements } = params;
  const emails = members.map((m) => m.email);
  if (emails.length === 0) {
    return { amount: 0, from_email: null, to_email: null, per_person: [] };
  }

  const paid = new Map<string, number>(emails.map((e) => [e, 0]));
  let sharedTotal = 0;

  for (const s of spends) {
    if (s.split !== 'shared') continue;
    if (s.amount >= 0) continue;             // income is not a shared cost
    const magnitude = -s.amount;
    sharedTotal += magnitude;
    if (s.paid_by && paid.has(s.paid_by)) paid.set(s.paid_by, (paid.get(s.paid_by) ?? 0) + magnitude);
  }

  for (const t of settlements) {
    if (paid.has(t.from_email)) paid.set(t.from_email, (paid.get(t.from_email) ?? 0) + t.amount);
    if (paid.has(t.to_email)) paid.set(t.to_email, (paid.get(t.to_email) ?? 0) - t.amount);
  }

  const share = sharedTotal / emails.length;
  const per_person = members.map((m) => {
    const p = round2(paid.get(m.email) ?? 0);
    return { email: m.email, display_name: m.display_name, paid: p, owes: round2(share), net: round2(p - share) };
  });

  // One suggested transfer: the deepest debtor pays the largest creditor. For
  // two people that is the whole answer; for more it is the first step, and
  // repeating it settles any group.
  const sorted = [...per_person].sort((a, b) => a.net - b.net);
  const debtor = sorted[0];
  const creditor = sorted[sorted.length - 1];
  if (!debtor || !creditor || debtor.email === creditor.email) {
    return { amount: 0, from_email: null, to_email: null, per_person };
  }
  const amount = round2(Math.min(-debtor.net, creditor.net));
  if (amount <= 0.005) {
    return { amount: 0, from_email: null, to_email: null, per_person };
  }
  return { amount, from_email: debtor.email, to_email: creditor.email, per_person };
}

/**
 * The one place an amount becomes text.
 *
 * Three decisions worth stating, because they are all deliberate:
 *
 * **Agorot are off by default.** They are noise in every overview — trailing
 * decimals steal the eye from the digits that matter, and a column of
 * `₪1,240.00` scans worse than `₪1,240`. Pass `agorot: true` on a single
 * transaction, where the exact figure is the point.
 *
 * **The symbol is optional.** In a ledger column ₪ belongs once, in the
 * column head, not forty times down the page. Pass `symbol: false` there.
 *
 * **The minus is U+2212, not a hyphen.** A hyphen is a punctuation mark drawn
 * to sit between letters; the true minus is drawn to the width and height of
 * the digits, which is what keeps a column of negatives aligned.
 */
export function formatILS(
  amount: number,
  opts: { sign?: boolean; agorot?: boolean; symbol?: boolean } = {},
): string {
  const { sign = false, agorot = false, symbol = true } = opts;
  const fraction = agorot && !Number.isInteger(amount) ? 2 : 0;
  const digits = new Intl.NumberFormat('he-IL', {
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction,
    useGrouping: true,
  }).format(Math.abs(amount));

  const body = symbol ? `₪${digits}` : digits;
  if (amount < 0) return `−${body}`;
  if (sign && amount > 0) return `+${body}`;
  return body;
}
