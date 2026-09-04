import { router, type Ctx } from '../_lib/router.js';
import { query, one, transaction } from '../_lib/db.js';
import { badRequest, notFound } from '../_lib/http.js';
import { date, int, num, oneOf, optionalDate, optionalInt, optionalNum, optionalStr, str } from '../_lib/validate.js';
import { keyFor, syncShoppingListFromStock } from '../_lib/pantry-service.js';
import { sortForShopping } from '../../shared/pantry.js';
import type { ShoppingItem } from '../../shared/types.js';

const STATUSES = ['open', 'bought', 'removed'] as const;

async function listItems(ctx: Ctx): Promise<ShoppingItem[]> {
  const status = oneOf(ctx.query['status'], 'status', STATUSES, 'open');
  const rows = await query<ShoppingItem>(
    `SELECT * FROM shopping_items WHERE status = $1 ORDER BY created_at`,
    [status],
  );
  // Sorted into supermarket walking order rather than by when it was typed.
  // The list is read once, standing up, moving — the order it was written in
  // is the one order that guarantees walking the shop twice.
  return sortForShopping(rows);
}

/**
 * Adds a line to the list.
 *
 * If the name matches a product we track, the item is linked to it — which is
 * what makes buying it later put it back in the pantry. If it does not, the
 * item is still added: forcing every "סוללות AA" to first become a tracked
 * product is how a shared list becomes slower than a note app, and then unused.
 */
async function addItem(ctx: Ctx): Promise<ShoppingItem | null> {
  const name = str(ctx.body['name'], 'שם הפריט', { max: 100 });
  const nameKey = keyFor(name);
  const explicitProduct = optionalInt(ctx.body['product_id'], 'מוצר');
  const product = explicitProduct
    ? await one<{ id: number; unit: string; category: string }>(`SELECT id, unit, category FROM products WHERE id = $1`, [explicitProduct])
    : await one<{ id: number; unit: string; category: string }>(`SELECT id, unit, category FROM products WHERE name_key = $1 AND archived_at IS NULL`, [nameKey]);

  const existing = await one<ShoppingItem>(
    product
      ? `SELECT * FROM shopping_items WHERE status = 'open' AND product_id = $1`
      : `SELECT * FROM shopping_items WHERE status = 'open' AND product_id IS NULL AND name_key = $1`,
    [product ? product.id : nameKey],
  );
  if (existing) {
    // Already on the list: bump the quantity instead of adding a second line.
    // Two rows of "חלב" is how a list stops being scannable.
    const bumped = optionalNum(ctx.body['qty'], 'כמות', { min: 0.01, max: 1000 });
    if (!bumped) return existing;
    return one<ShoppingItem>(`UPDATE shopping_items SET qty = qty + $2 WHERE id = $1 RETURNING *`, [existing.id, bumped]);
  }

  return one<ShoppingItem>(
    `INSERT INTO shopping_items (name, name_key, product_id, qty, unit, category, note, source, added_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8) RETURNING *`,
    [
      name, nameKey, product?.id ?? null,
      optionalNum(ctx.body['qty'], 'כמות', { min: 0.01, max: 1000 }) ?? 1,
      optionalStr(ctx.body['unit'], 'יחידה', 20) ?? 'יח׳',
      optionalStr(ctx.body['category'], 'מדף', 40) ?? product?.category ?? 'כללי',
      optionalStr(ctx.body['note'], 'הערה', 300),
      ctx.user.email,
    ],
  );
}

/**
 * Marks one line bought — and, if it is a tracked product, puts it away.
 *
 * This is the join between the two halves of the module. Without it the pantry
 * is a second data-entry job done after the shopping, which nobody does twice,
 * and the min-stock rule that generated the line in the first place never
 * clears.
 */
async function buyItem(ctx: Ctx) {
  const id = Number(ctx.params['id']);
  const item = await one<ShoppingItem>(`SELECT * FROM shopping_items WHERE id = $1 AND status = 'open'`, [id]);
  if (!item) throw notFound('הפריט לא נמצא ברשימה הפתוחה');

  const qty = optionalNum(ctx.body['qty'], 'כמות', { min: 0.01, max: 10_000 }) ?? item.qty;
  const price = optionalNum(ctx.body['price'], 'מחיר', { min: 0, max: 100_000 });
  const expiresOn = optionalDate(ctx.body['expires_on'], 'תפוגה');

  const result = await transaction(async (client) => {
    await client.query(
      `UPDATE shopping_items SET status = 'bought', bought_at = NOW(), bought_by = $2, qty = $3 WHERE id = $1`,
      [id, ctx.user.email, qty],
    );
    if (!item.product_id) return { stocked: false, entry_id: null as number | null };

    const { rows: products } = await client.query<{ default_location: string; shelf_life_days: number | null }>(
      `SELECT default_location, shelf_life_days FROM products WHERE id = $1`, [item.product_id],
    );
    const product = products[0];
    if (!product) return { stocked: false, entry_id: null as number | null };

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO stock_entries (product_id, qty, location, expires_on, price, purchased_on, created_by)
       VALUES ($1, $2, $3,
               COALESCE($4::date, CASE WHEN $5::int IS NULL THEN NULL ELSE CURRENT_DATE + ($5 || ' days')::interval END),
               $6, CURRENT_DATE, $7)
       RETURNING id`,
      [item.product_id, qty, product.default_location, expiresOn, product.shelf_life_days, price, ctx.user.email],
    );
    await client.query(
      `INSERT INTO stock_log (product_id, entry_id, action, qty_delta, note, actor) VALUES ($1,$2,'add',$3,'קנייה',$4)`,
      [item.product_id, rows[0]?.id ?? null, qty, ctx.user.email],
    );
    return { stocked: true, entry_id: rows[0]?.id ?? null };
  });

  return { ok: true, ...result };
}

/**
 * Ends a shopping trip: everything bought comes off the list, and the total
 * becomes one transaction in the budget.
 *
 * One transaction, not one per item. A supermarket run is a single ₪412 line
 * in the grocery envelope; forty lines of ₪3.90 would be a more precise budget
 * that nobody would ever read.
 */
async function checkout(ctx: Ctx) {
  const bought = await query<ShoppingItem>(`SELECT * FROM shopping_items WHERE status = 'bought'`);
  if (bought.length === 0) throw badRequest('אין פריטים מסומנים כנקנו');

  const total = optionalNum(ctx.body['total'], 'סכום', { min: 0, max: 1_000_000 });
  const accountId = optionalInt(ctx.body['account_id'], 'חשבון');
  const categoryId = optionalInt(ctx.body['category_id'], 'קטגוריה');

  return transaction(async (client) => {
    let transactionId: number | null = null;
    if (total && total > 0) {
      if (!accountId) throw badRequest('בחרו חשבון כדי לרשום את הקנייה בתקציב');
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO transactions (occurred_on, account_id, category_id, amount, payee, note, paid_by, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
        [
          date(ctx.body['occurred_on'] ?? new Date().toISOString().slice(0, 10), 'תאריך'),
          accountId, categoryId, -Math.abs(total),
          optionalStr(ctx.body['payee'], 'איפה', 120) ?? 'קניות',
          `${bought.length} פריטים`,
          optionalStr(ctx.body['paid_by'], 'מי שילם', 200) ?? ctx.user.email,
        ],
      );
      transactionId = rows[0]?.id ?? null;
    }
    // 'removed' and not deleted: the row is what lets the list learn what we
    // buy and how often, which is the next feature and needs the history.
    await client.query(`UPDATE shopping_items SET status = 'removed' WHERE status = 'bought'`);
    return { ok: true, cleared: bought.length, transaction_id: transactionId };
  });
}

export default router([
  { method: 'GET', path: 'items', role: 'viewer', handle: listItems },
  { method: 'POST', path: 'items', handle: addItem },
  {
    method: 'PATCH', path: 'items/:id',
    handle: async (ctx) => {
      const row = await one<ShoppingItem>(
        `UPDATE shopping_items
            SET qty = COALESCE($2, qty), note = COALESCE($3, note),
                category = COALESCE($4, category), status = COALESCE($5, status)
          WHERE id = $1 RETURNING *`,
        [
          Number(ctx.params['id']),
          optionalNum(ctx.body['qty'], 'כמות', { min: 0.01, max: 10_000 }),
          optionalStr(ctx.body['note'], 'הערה', 300),
          optionalStr(ctx.body['category'], 'מדף', 40),
          ctx.body['status'] ? oneOf(ctx.body['status'], 'סטטוס', STATUSES) : null,
        ],
      );
      if (!row) throw notFound('הפריט לא נמצא');
      return row;
    },
  },
  { method: 'POST', path: 'items/:id/buy', handle: buyItem },
  {
    method: 'POST', path: 'items/:id/unbuy',
    handle: async (ctx) => {
      const row = await one(`UPDATE shopping_items SET status='open', bought_at=NULL, bought_by=NULL WHERE id=$1 AND status='bought' RETURNING *`, [Number(ctx.params['id'])]);
      if (!row) throw notFound('הפריט לא מסומן כנקנה');
      return row;
    },
  },
  {
    method: 'DELETE', path: 'items/:id',
    handle: async (ctx) => {
      const row = await one(`UPDATE shopping_items SET status='removed' WHERE id=$1 RETURNING id`, [Number(ctx.params['id'])]);
      if (!row) throw notFound('הפריט לא נמצא');
      return { ok: true };
    },
  },
  { method: 'POST', path: 'checkout', handle: checkout },
  { method: 'POST', path: 'sync', handle: async (ctx) => syncShoppingListFromStock(ctx.user.email) },
]);
