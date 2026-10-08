import { one, query, transaction, withHousehold } from '../_lib/db.js';
import { createHousehold } from '../_lib/auth.js';
import { syncShoppingListFromStock } from '../_lib/pantry-service.js';
import { nameKey } from '../../shared/budget-workbook.js';
import { normalizeName } from '../../shared/pantry.js';
import {
  COUPLE_HOME_NAME, PERSONAS, TEST_DOMAIN, coupleFixture, daysBefore, israelToday,
  type PersonaKey,
} from '../../shared/testing.js';

/**
 * The test homes, written and wiped. The people themselves are shared/testing.ts.
 *
 * ## What a reset deletes, and why it is a real DELETE
 *
 * Everything else in casa that holds money is soft-deleted, so that «מה נמחק
 * כאן» has an answer next month. Test homes are the exception on purpose: the
 * point of a reset is to test the next release from zero, and a home that is
 * archived rather than gone is still in the operator's metrics, still in a
 * test persona's memberships, and still the first thing they land in.
 *
 * What it may delete is fenced by address, not by choice: only households
 * *opened by* a `.invalid` person, and only memberships *of* one. A real
 * person's home is never in either set — not even one a test persona was
 * invited into, from which only the persona is removed.
 */

const TEST_ADDRESSES = `%@${TEST_DOMAIN}`;

export interface TestingPersonaState {
  key: PersonaKey;
  display_name: string;
  purpose: string;
  /** The homes this persona is in right now, by name. Empty for one who has none. */
  homes: string[];
}

export interface TestingState {
  built: boolean;
  personas: TestingPersonaState[];
}

export async function testingState(): Promise<TestingState> {
  const rows = await query<{ email: string; household_name: string | null }>(
    `SELECT u.email, h.name AS household_name
       FROM users u
       LEFT JOIN household_members m ON m.email = u.email
       LEFT JOIN households h        ON h.id = m.household_id
      WHERE u.email LIKE $1
      ORDER BY m.joined_at`,
    [TEST_ADDRESSES],
  );
  const known = new Set(rows.map((r) => r.email));
  return {
    built: PERSONAS.every((p) => known.has(p.email)),
    personas: PERSONAS.map((p) => ({
      key: p.key,
      display_name: p.display_name,
      purpose: p.purpose,
      homes: rows.filter((r) => r.email === p.email && r.household_name).map((r) => r.household_name!),
    })),
  };
}

/** Wipes every test home and builds them again, as of today. */
export async function rebuildTestHomes(): Promise<TestingState> {
  await transaction(async (client) => {
    // Cascades to every tenant row of those homes (see db/schema.sql), and to
    // their members and invitations.
    await client.query(`DELETE FROM households WHERE created_by LIKE $1`, [TEST_ADDRESSES]);
    await client.query(`DELETE FROM household_members WHERE email LIKE $1`, [TEST_ADDRESSES]);
    // A push subscription made while stepped in is the operator's own phone,
    // filed under a test person. It goes with the reset so a stale one does not
    // keep buzzing about a home that no longer exists.
    await client.query(`DELETE FROM push_subscriptions WHERE user_email LIKE $1`, [TEST_ADDRESSES]);

    for (const p of PERSONAS) {
      // `name` is what Google would have said; display_name is cleared so that
      // «איך לקרוא לך» is asked again, the way a new person is asked.
      await client.query(
        `INSERT INTO users (email, name, display_name, last_seen_at)
         VALUES ($1, $2, $3, NULL)
         ON CONFLICT (email) DO UPDATE
           SET name = EXCLUDED.name, display_name = EXCLUDED.display_name, last_seen_at = NULL`,
        [p.email, p.display_name, p.home ? p.display_name : null],
      );
    }
  });

  const owner = PERSONAS.find((p) => p.home === 'couple' && p.role === 'owner')!;
  const home = await createHousehold(COUPLE_HOME_NAME, owner.email);
  for (const p of PERSONAS.filter((x) => x.home === 'couple' && x.role === 'member')) {
    await query(
      `INSERT INTO household_members (household_id, email, role) VALUES ($1, $2, 'member')`,
      [home.household_id, p.email],
    );
  }

  // Its own scope, for the same reason createHousehold furnishes in one: the
  // operator pressing the button is not a member of this home, and is not
  // meant to become one.
  await withHousehold(home.household_id, () => populateCouple(israelToday()));
  return testingState();
}

const emailOf = (key: PersonaKey): string => PERSONAS.find((p) => p.key === key)!.email;

async function populateCouple(today: string): Promise<void> {
  const f = coupleFixture(today);

  const accounts = new Map<string, number>();
  for (const a of f.accounts) {
    // The seed already opened the bank account and the wallet.
    const row = await one<{ id: number }>(
      `UPDATE accounts SET opening_balance = $2, kind = $3 WHERE name = $1 RETURNING id`,
      [a.name, a.opening_balance, a.kind],
    ) ?? await one<{ id: number }>(
      `INSERT INTO accounts (name, kind, opening_balance, sort_order)
       VALUES ($1, $2, $3, (SELECT count(*) FROM accounts)) RETURNING id`,
      [a.name, a.kind, a.opening_balance],
    );
    accounts.set(a.name, row!.id);
  }

  const categories = new Map(
    (await query<{ id: number; name: string }>(`SELECT id, name FROM categories`)).map((c) => [c.name, c.id]),
  );
  const category = (name: string): number => {
    const id = categories.get(name);
    // A seed rename that the fixture did not follow. Loud, because a test home
    // with silently unfiled lines is testing the wrong thing.
    if (id === undefined) throw new Error(`test fixture names a category the seed no longer has: ${name}`);
    return id;
  };

  for (const a of f.allocations) {
    await query(
      `INSERT INTO budget_allocations (month, category_id, allocated, updated_by) VALUES ($1, $2, $3, $4)`,
      [a.month, category(a.category), a.allocated, emailOf('dana')],
    );
  }

  for (const t of f.transactions) {
    // created_at in the evening of the day it happened, which is when a couple
    // would actually have typed it in — so the operator's «ימים עם תנועה»
    // reads like a real home rather than one that did two months in a second.
    await query(
      `INSERT INTO transactions (occurred_on, account_id, category_id, amount, payee, paid_by, split,
                                 installment_no, installments_total, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6,
               ($1::date + time '20:30') AT TIME ZONE 'Asia/Jerusalem')`,
      [t.occurred_on, accounts.get(t.account), t.category ? category(t.category) : null, t.amount,
       t.payee, emailOf(t.paid_by), t.split, t.installment_no ?? null, t.installments_total ?? null],
    );
  }

  for (const r of f.recurring) {
    await query(
      `INSERT INTO recurring_bills (name, category_id, account_id, amount_estimate, cadence, next_due)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [r.name, category(r.category), accounts.get(r.account), r.amount_estimate, r.cadence, r.next_due],
    );
  }

  for (const rule of f.payee_rules) {
    await query(
      `INSERT INTO payee_rules (payee_key, payee, category_id) VALUES ($1, $2, $3)`,
      [nameKey(rule.payee), rule.payee, category(rule.category)],
    );
  }

  await query(
    `INSERT INTO settlements (occurred_on, from_email, to_email, amount, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $2)`,
    [f.settlement.occurred_on, emailOf(f.settlement.from), emailOf(f.settlement.to), f.settlement.amount, f.settlement.note],
  );

  for (const [key, min] of Object.entries(f.minimums)) {
    await query(`UPDATE products SET min_qty = $2 WHERE name_key = $1`, [key, min]);
  }

  for (const s of f.stock) {
    const product = await one<{ id: number; shelf_life_days: number | null }>(
      `SELECT id, shelf_life_days FROM products WHERE name_key = $1`, [s.product],
    );
    if (!product) throw new Error(`test fixture names a product the seed no longer has: ${s.product}`);
    const entry = await one<{ id: number }>(
      `INSERT INTO stock_entries (product_id, qty, location, expires_on, purchased_on, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [product.id, s.qty, s.location,
       s.expires_in_days === null ? null : daysBefore(today, -s.expires_in_days),
       daysBefore(today, 3), emailOf('dana')],
    );
    await query(
      `INSERT INTO stock_log (product_id, entry_id, action, qty_delta, actor) VALUES ($1, $2, 'add', $3, $4)`,
      [product.id, entry!.id, s.qty, emailOf('dana')],
    );
  }

  for (const item of f.shopping) {
    await query(
      `INSERT INTO shopping_items (name, name_key, qty, unit, category, added_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [item.name, normalizeName(item.name), item.qty, item.unit, item.category, emailOf(item.added_by)],
    );
  }

  // What the nightly job would have added by now: the staples below minimum.
  await syncShoppingListFromStock(null);
}
