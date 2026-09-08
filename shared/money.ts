import type {
  BudgetMonth, EnvelopeRow, Category, BalanceBetweenUs,
  CashFlow, Commitment, CommitmentSlice, UnplannedCheck, CategoryAverage,
} from './types.js';

/** The ladder, from least control to most. Order matters — it is how it reads. */
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
 * The share of the month the method says to set aside for the unforeseen.
 *
 * 5% is the floor stated in the material; its worked template widens it to
 * 5–10%. We hold the floor, because a rule that is checked is worth more than
 * a range that is admired.
 */
export const UNPLANNED_FLOOR = 0.05;

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
 * Turns raw allocations and transactions into the month's envelopes.
 *
 * The one rule worth stating out loud is **rollover**: an envelope's
 * `available` is not this month's allocation minus this month's spending. It
 * is *everything ever put in* minus *everything ever taken out*, up to and
 * including this month. That is what makes the model work for the categories
 * that matter — ביטוח רכב is ₪250 a month for eleven months and ₪2,750 in the
 * twelfth, and a per-month view calls that a disaster instead of a plan.
 *
 * Overspending carries too, deliberately. YNAB hides an overspent envelope by
 * resetting it to zero next month and quietly taking the difference out of the
 * next month's income; that is kinder and less honest. Here a negative
 * envelope stays negative until somebody moves money into it, which is the
 * thing that actually has to happen.
 */
export function buildBudgetMonth(params: {
  month: string;
  categories: Category[];
  allocations: AllocationInput[];
  spends: SpendInput[];
}): BudgetMonth {
  const { month, categories, allocations, spends } = params;

  const allocThisMonth = new Map<number, number>();
  const allocToDate = new Map<number, number>();
  for (const a of allocations) {
    if (a.month > month) continue;
    allocToDate.set(a.category_id, (allocToDate.get(a.category_id) ?? 0) + a.allocated);
    if (a.month === month) allocThisMonth.set(a.category_id, (allocThisMonth.get(a.category_id) ?? 0) + a.allocated);
  }

  // `spent` is reported positive because "הוצאנו 1,200" is how it is read,
  // while the stored amount is negative. The two never meet: the sign flip
  // happens once, here.
  const spentThisMonth = new Map<number, number>();
  const spentToDate = new Map<number, number>();
  let incomeThisMonth = 0;
  let incomeToDate = 0;

  const incomeCategoryIds = new Set(categories.filter((c) => c.kind === 'income').map((c) => c.id));

  for (const s of spends) {
    if (s.month > month) continue;
    // What counts as income is the category's *kind*, not the sign. A grocery
    // month with more refunds than purchases is not a payday; it is a spending
    // envelope with a negative spend, which correctly gives the money back.
    // Only an uncategorised row has to be judged by its sign, and there a
    // positive amount really is money arriving that nobody has filed yet.
    const isIncome = s.category_id != null
      ? incomeCategoryIds.has(s.category_id)
      : s.amount > 0;
    if (isIncome) {
      incomeToDate += s.amount;
      if (s.month === month) incomeThisMonth += s.amount;
      continue;
    }
    if (s.category_id == null) continue; // an unfiled spend: real, but in no envelope yet
    const magnitude = -s.amount;
    spentToDate.set(s.category_id, (spentToDate.get(s.category_id) ?? 0) + magnitude);
    if (s.month === month) spentThisMonth.set(s.category_id, (spentThisMonth.get(s.category_id) ?? 0) + magnitude);
  }

  const envelopes: EnvelopeRow[] = categories
    .filter((c) => c.kind !== 'income' && !c.archived_at)
    .map((c) => ({
      category_id: c.id,
      category_name: c.name,
      group_id: c.group_id,
      group_name: c.group_name,
      kind: c.kind,
      commitment: c.commitment,
      icon: c.icon,
      allocated: round2(allocThisMonth.get(c.id) ?? 0),
      spent: round2(spentThisMonth.get(c.id) ?? 0),
      available: round2((allocToDate.get(c.id) ?? 0) - (spentToDate.get(c.id) ?? 0)),
      monthly_target: c.monthly_target,
    }));

  const allocatedThisMonthTotal = envelopes.reduce((sum, e) => sum + e.allocated, 0);
  const spentThisMonthTotal = envelopes.reduce((sum, e) => sum + e.spent, 0);
  const allocatedEverTotal = [...allocToDate.values()].reduce((sum, v) => sum + v, 0);

  return {
    month,
    envelopes,
    income: round2(incomeThisMonth),
    allocated: round2(allocatedThisMonthTotal),
    spent: round2(spentThisMonthTotal),
    to_be_budgeted: round2(incomeToDate - allocatedEverTotal),
    // Flow is measured against what actually happened this month, not against
    // what was planned. A budget that balances on paper while the month runs a
    // deficit is the exact situation the projection exists to expose.
    flow: cashFlow(incomeThisMonth, spentThisMonthTotal),
    commitments: commitmentBreakdown(envelopes),
    unplanned: unplannedCheck(envelopes),
  };
}

// ── Cash flow, said out loud ─────────────────────────────────────────────

/**
 * Income minus spending, and what that becomes if nothing changes.
 *
 * The projection is not a forecast and does not pretend to be one — it is the
 * same subtraction multiplied by 12 and 36. That is the whole trick, and it
 * works: a household shrugs at "₪1,200 short this month" and does not shrug
 * at "₪43,200 over three years". Stating it is the intervention.
 *
 * It is only computed forward for a deficit. Multiplying a good month by 36 to
 * promise ₪43,200 of savings would be the same arithmetic used dishonestly.
 */
export function cashFlow(income: number, spent: number): CashFlow {
  const monthly = round2(income - spent);
  const projecting = monthly < 0 ? monthly : 0;
  return {
    income: round2(income),
    spent: round2(spent),
    monthly,
    yearly: round2(projecting * 12),
    three_year: round2(projecting * 36),
  };
}

/**
 * The month split by how much control we have over it.
 *
 * This is what turns "spend less" into something actionable: it names the
 * portion of the month that is genuinely available to move. A household whose
 * rigid share is most of its income has a different problem — and a different
 * remedy — from one whose liquid share is.
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
 * What each category actually costs, from the months we have.
 *
 * The method's first stage is to map three real months before budgeting a
 * shekel, because a target invented from nothing is a wish. We hold every
 * transaction already, so this is arithmetic rather than homework.
 *
 * The divisor is the number of months that actually carried activity, not a
 * flat three. A household two months into using this would otherwise see every
 * average understated by a third and quietly under-budget on the strength of
 * it — so a one-month average is reported as a one-month average.
 */
export function categoryAverages(params: {
  month: string;
  categories: Category[];
  spends: SpendInput[];
  lookback?: number;
}): CategoryAverage[] {
  const { month, categories, spends, lookback = 3 } = params;

  const window: string[] = [];
  let cursor = month;
  for (let i = 0; i < lookback; i++) {
    cursor = previousMonth(cursor);
    window.push(cursor);
  }

  const active = new Set(spends.filter((s) => window.includes(s.month) && s.amount !== 0).map((s) => s.month));
  const divisor = Math.max(1, active.size);

  const incomeIds = new Set(categories.filter((c) => c.kind === 'income').map((c) => c.id));
  const totals = new Map<number, number>();
  for (const s of spends) {
    if (s.category_id == null || incomeIds.has(s.category_id)) continue;
    if (!window.includes(s.month)) continue;
    totals.set(s.category_id, (totals.get(s.category_id) ?? 0) + -s.amount);
  }

  return categories
    .filter((c) => c.kind !== 'income' && !c.archived_at)
    .map((c) => ({
      category_id: c.id,
      category_name: c.name,
      average: round2((totals.get(c.id) ?? 0) / divisor),
      months_observed: active.size,
    }));
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
