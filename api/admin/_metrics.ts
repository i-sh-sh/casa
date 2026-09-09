import { one, query, withHousehold } from '../_lib/db.js';

/**
 * What the pilot looks like from the outside, without looking inside.
 *
 * The operator running a pilot needs to answer three questions: is anybody
 * actually using this, who has gone quiet, and where did it break. None of
 * those questions requires knowing what a couple spent — and the difference
 * between the version that answers them with counts and the version that
 * answers them by reading transactions is the difference between a promise
 * kept and a promise broken. The privacy policy at public/privacy.html says
 * we do not read the data. This file is what makes that sentence survive the
 * existence of an admin screen.
 *
 * ## The rule
 *
 * **Every column returned from a household's own tables is an aggregate.**
 * `count(*)`, `max(created_at)` — a number and a date, never a row. There is no
 * amount here, no payee, no category name, no product, no note. A test in
 * scripts/tests/metrics.test.ts reads this file and fails on any select from a
 * tenant table that is not wrapped in count/max/min, because a rule enforced by
 * a comment is a rule until the day somebody is in a hurry.
 *
 * ## Why it loops instead of grouping
 *
 * The obvious query is `SELECT household_id, count(*) FROM transactions GROUP
 * BY household_id`. It returns nothing. Row-level security compares every row
 * against `casa.household_id`, and outside a scope that setting is NULL, so the
 * policy hides everything — fail-closed, exactly as designed.
 *
 * The tempting fix is a policy exception for operators. That would be a hole in
 * the one mechanism that keeps two couples apart, open on every table, for the
 * benefit of one screen. So instead this opens a legitimate scope per household
 * and asks inside it, reusing `withHousehold` unchanged. The isolation is not
 * weakened at all; the only new privilege is that an operator may open a scope
 * for a home they are not a member of.
 *
 * One query per household, and a pilot has a dozen. If that ever stops being
 * true, the answer is a materialised summary refreshed by the cron — not a
 * policy exception.
 */

export interface HouseholdMetrics {
  household_id: number;
  name: string;
  owner_email: string | null;
  created_at: string;
  members: number;
  pending: number;
  /** The most recent sign-in by anyone in the home. The quiet-household signal. */
  last_seen_at: string | null;
  accounts: number;
  categories: number;
  transactions: number;
  transactions_7d: number;
  products: number;
  shopping_open: number;
  /** The most recent write of any kind. "Signed in" and "used it" are different. */
  last_activity_at: string | null;
}

interface Registry {
  household_id: number;
  name: string;
  owner_email: string | null;
  created_at: string;
  members: number;
  pending: number;
  last_seen_at: string | null;
}

/**
 * The registry half, read unscoped.
 *
 * `households`, `household_members` and `users` are not under RLS — answering
 * "which homes exist and who belongs to them" is the question asked *before* a
 * household is known, so it cannot itself be scoped to one. That is stated in
 * db/schema.sql and is why this half needs no loop.
 *
 * The owner's address is here because a pilot operator has to be able to turn
 * "we can't sign in" into a household. It is the account that agreed to the
 * terms, and it is the only address listed: the rest of a home's members are
 * that home's business.
 */
async function registry(): Promise<Registry[]> {
  return await query<Registry>(
    `SELECT h.id                                              AS household_id,
            h.name,
            min(m.email) FILTER (WHERE m.role = 'owner')      AS owner_email,
            h.created_at,
            count(m.email) FILTER (WHERE m.role <> 'pending') AS members,
            count(m.email) FILTER (WHERE m.role = 'pending')  AS pending,
            max(u.last_seen_at)                               AS last_seen_at
       FROM households h
       LEFT JOIN household_members m ON m.household_id = h.id
       LEFT JOIN users u             ON u.email = m.email
      GROUP BY h.id, h.name, h.created_at
      ORDER BY h.id`,
  );
}

/** Counts and dates for one home, from inside its own scope. */
async function activity(householdId: number) {
  return await withHousehold(householdId, async () => await one<{
    accounts: number; categories: number; transactions: number;
    transactions_7d: number; products: number; shopping_open: number;
    last_activity_at: string | null;
  }>(
    `SELECT (SELECT count(*) FROM accounts)                       AS accounts,
            (SELECT count(*) FROM categories)                     AS categories,
            (SELECT count(*) FROM transactions
              WHERE deleted_at IS NULL)                           AS transactions,
            (SELECT count(*) FROM transactions
              WHERE deleted_at IS NULL
                AND created_at > now() - interval '7 days')       AS transactions_7d,
            (SELECT count(*) FROM products)                       AS products,
            (SELECT count(*) FROM shopping_items
              WHERE status = 'open')                              AS shopping_open,
            GREATEST(
              (SELECT max(created_at) FROM transactions),
              (SELECT max(created_at) FROM shopping_items),
              (SELECT max(created_at) FROM stock_log)
            )                                                     AS last_activity_at`,
  ));
}

export async function pilotMetrics(): Promise<HouseholdMetrics[]> {
  const homes = await registry();
  const out: HouseholdMetrics[] = [];

  for (const home of homes) {
    // A home whose activity query fails must not take the whole screen with it:
    // the reason to open this page is usually that something is already broken.
    let counts: Awaited<ReturnType<typeof activity>> = null;
    try {
      counts = await activity(home.household_id);
    } catch (err) {
      console.error('metrics failed for household', home.household_id, err);
    }

    out.push({
      ...home,
      members: Number(home.members),
      pending: Number(home.pending),
      accounts: Number(counts?.accounts ?? 0),
      categories: Number(counts?.categories ?? 0),
      transactions: Number(counts?.transactions ?? 0),
      transactions_7d: Number(counts?.transactions_7d ?? 0),
      products: Number(counts?.products ?? 0),
      shopping_open: Number(counts?.shopping_open ?? 0),
      last_activity_at: counts?.last_activity_at ?? null,
    });
  }

  return out;
}
