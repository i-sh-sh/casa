// The shapes the API returns and the UI renders. One definition, imported by
// both sides — so a column rename breaks the build instead of a screen.

export type Role = 'owner' | 'member' | 'viewer' | 'pending';

export interface User {
  email: string;
  name: string | null;
  picture: string | null;
  display_name: string | null;
  color: string | null;
  /**
   * The home this session is acting in, and the role held *there*.
   *
   * `null` means signed in but belonging to nowhere yet — a real state, not an
   * error: a person who just accepted a Google prompt and has neither opened a
   * home nor followed an invitation. The app shows them the door, not a budget.
   */
  household_id: number | null;
  household_name?: string;
  role?: Role;
}

/** One of the homes a person belongs to. */
export interface Household {
  household_id: number;
  household_name: string;
  role: Role;
}

// ── Money ────────────────────────────────────────────────────────────────

export type AccountKind = 'bank' | 'cash' | 'credit' | 'savings';
export type CategoryKind = 'spending' | 'income' | 'saving';

/**
 * How much control we have over an expense — the ladder, from least to most.
 *
 * This is a different axis from `kind`, and the more useful one. `kind` says
 * what an amount is; `commitment` says what could be done about it, which is
 * the only question worth asking when a month does not add up. "Cut spending"
 * is not advice; "of your ₪9,700, ₪3,570 is rigid and ₪1,450 is liquid" is.
 *
 *   rigid     קשיחות     — rent, ארנונה, insurance, loan repayments.
 *                          Fixed, or hard enough to change that this month
 *                          they may as well be.
 *   flexible  גמישות     — electricity, water, groceries, fuel. You must pay
 *                          something; how much is partly yours to decide.
 *   liquid    נזילות     — clothes, restaurants, culture, gifts. Entirely a
 *                          decision. This is where a month is actually saved.
 *   unplanned לא צפויות  — a wedding, a dentist, a broken phone. Not knowing
 *                          what it will be is not a reason to budget nothing
 *                          for it; it is the reason to budget for it.
 */
export type Commitment = 'rigid' | 'flexible' | 'liquid' | 'unplanned';
export type Split = 'shared' | 'personal';
export type Cadence = 'monthly' | 'bimonthly' | 'quarterly' | 'yearly';

export interface Account {
  id: number;
  name: string;
  kind: AccountKind;
  currency: string;
  opening_balance: number;
  color: string | null;
  sort_order: number;
  archived_at: string | null;
  /** opening_balance + every transaction on the account. Computed, never stored. */
  balance: number;
}

export interface CategoryGroup {
  id: number;
  name: string;
  sort_order: number;
}

export interface Category {
  id: number;
  group_id: number | null;
  group_name: string | null;
  name: string;
  kind: CategoryKind;
  commitment: Commitment;
  monthly_target: number | null;
  icon: string | null;
  sort_order: number;
  archived_at: string | null;
}

export interface Transaction {
  id: number;
  occurred_on: string;
  account_id: number;
  account_name: string;
  category_id: number | null;
  category_name: string | null;
  /** Negative = money left. Positive = money arrived. Always. */
  amount: number;
  payee: string;
  note: string | null;
  paid_by: string | null;
  split: Split;
  transfer_id: string | null;
  created_by: string | null;
  created_at: string;
}

/** One envelope, for one month, with the rollover already folded in. */
export interface EnvelopeRow {
  category_id: number;
  category_name: string;
  group_id: number | null;
  group_name: string | null;
  kind: CategoryKind;
  commitment: Commitment;
  icon: string | null;
  /** What we put in this envelope this month. */
  allocated: number;
  /** What left it this month, as a positive number. */
  spent: number;
  /** Everything allocated up to and including this month, minus everything spent. */
  available: number;
  monthly_target: number | null;
}

export interface BudgetMonth {
  month: string;
  envelopes: EnvelopeRow[];
  income: number;
  allocated: number;
  spent: number;
  /** Income to date minus everything ever allocated. Negative = we over-promised. */
  to_be_budgeted: number;
  /** This month's income minus this month's spending, and what that becomes if nothing changes. */
  flow: CashFlow;
  /** The month split by how much control we have over it. */
  commitments: CommitmentSlice[];
  /** Whether enough is set aside for the things we cannot see coming. */
  unplanned: UnplannedCheck;
}

/**
 * The number the whole method turns on.
 *
 * A deficit stated per month is a number people shrug at; the same deficit
 * stated as what it becomes over a year and three years is the one that
 * changes behaviour. That projection is the point — not a forecast, just the
 * same arithmetic said out loud.
 */
export interface CashFlow {
  income: number;
  spent: number;
  /** income − spent. Negative means the month did not cover itself. */
  monthly: number;
  /** monthly × 12 and × 36, only meaningful while nothing changes. */
  yearly: number;
  three_year: number;
}

export interface CommitmentSlice {
  commitment: Commitment;
  allocated: number;
  spent: number;
  /** This slice's share of everything allocated, 0–1. */
  share: number;
}

export interface UnplannedCheck {
  allocated: number;
  /** Share of the month's allocation set aside for the unforeseen, 0–1. */
  share: number;
  /** The floor the method recommends: 5%. */
  floor: number;
  meets_floor: boolean;
  /** What would have to be added to reach the floor. 0 when it is already met. */
  shortfall: number;
}

/**
 * What a category actually costs, averaged over the months we have.
 *
 * The method's first stage is to map three real months before budgeting a
 * single shekel, because a target invented from nothing is a wish. We already
 * hold every transaction, so this is arithmetic rather than homework —
 * `months_observed` is carried so a one-month average can say so instead of
 * pretending to be three.
 */
export interface CategoryAverage {
  category_id: number;
  category_name: string;
  average: number;
  months_observed: number;
}

export interface RecurringBill {
  id: number;
  name: string;
  category_id: number | null;
  category_name: string | null;
  account_id: number | null;
  amount_estimate: number;
  cadence: Cadence;
  next_due: string;
  autopay: boolean;
  remind_days: number;
  note: string | null;
  active: boolean;
}

export interface BalanceBetweenUs {
  /** Positive: `from` owes `to`. Zero: we are square. */
  amount: number;
  from_email: string | null;
  to_email: string | null;
  per_person: { email: string; display_name: string; paid: number; owes: number; net: number }[];
}

// ── Pantry & shopping ────────────────────────────────────────────────────

export type Location = 'מזווה' | 'מקרר' | 'מקפיא' | 'אמבטיה' | 'ניקיון' | 'אחר';
export type ShoppingSource = 'manual' | 'auto_min_stock' | 'recipe';
export type ShoppingStatus = 'open' | 'bought' | 'removed';

export interface Product {
  id: number;
  name: string;
  name_key: string;
  unit: string;
  category: string;
  min_qty: number;
  default_location: Location;
  shelf_life_days: number | null;
  barcode: string | null;
  note: string | null;
  archived_at: string | null;
  /** Sum of every open batch. */
  in_stock: number;
  /** The soonest expiry among batches still on the shelf, or null. */
  next_expiry: string | null;
  /** in_stock < min_qty — the fact the shopping list is generated from. */
  below_min: boolean;
}

export interface StockEntry {
  id: number;
  product_id: number;
  product_name: string;
  qty: number;
  location: Location;
  expires_on: string | null;
  opened_on: string | null;
  price: number | null;
  purchased_on: string;
  created_by: string | null;
}

export interface ShoppingItem {
  id: number;
  name: string;
  name_key: string;
  product_id: number | null;
  qty: number;
  unit: string;
  category: string;
  note: string | null;
  source: ShoppingSource;
  status: ShoppingStatus;
  added_by: string | null;
  created_at: string;
  bought_at: string | null;
  bought_by: string | null;
}
