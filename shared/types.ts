// The shapes the API returns and the UI renders. One definition, imported by
// both sides — so a column rename breaks the build instead of a screen.

export type Role = 'owner' | 'member' | 'viewer' | 'pending';

export interface User {
  email: string;
  name: string | null;
  picture: string | null;
  role: Role;
  display_name: string | null;
  color: string | null;
}

// ── Money ────────────────────────────────────────────────────────────────

export type AccountKind = 'bank' | 'cash' | 'credit' | 'savings';
export type CategoryKind = 'spending' | 'income' | 'saving';
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
