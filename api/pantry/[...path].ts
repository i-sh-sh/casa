import { router, type Ctx } from '../_lib/router.js';
import { query, one, transaction } from '../_lib/db.js';
import { badRequest, conflict, notFound } from '../_lib/http.js';
import { date, int, num, oneOf, optionalDate, optionalInt, optionalNum, optionalStr, str } from '../_lib/validate.js';
import { PRODUCT_SELECT, getProduct, keyFor, syncShoppingListFromStock } from '../_lib/pantry-service.js';
import { applyConsumption } from '../../shared/pantry.js';
import type { Product, StockEntry } from '../../shared/types.js';

const LOCATIONS = ['מזווה', 'מקרר', 'מקפיא', 'אמבטיה', 'ניקיון', 'אחר'] as const;

// ── Products ─────────────────────────────────────────────────────────────

async function listProducts(ctx: Ctx): Promise<Product[]> {
  const clauses: string[] = ['WHERE TRUE'];
  const params: unknown[] = [];
  if (ctx.query['include_archived'] !== '1') clauses.push('AND p.archived_at IS NULL');
  if (ctx.query['category']) {
    params.push(ctx.query['category']);
    clauses.push(`AND p.category = $${params.length}`);
  }
  if (ctx.query['location']) {
    params.push(ctx.query['location']);
    clauses.push(`AND p.default_location = $${params.length}`);
  }
  if (ctx.query['below_min'] === '1') clauses.push('AND p.min_qty > 0 AND COALESCE(s.in_stock, 0) < p.min_qty');
  if (ctx.query['search']) {
    params.push(`%${ctx.query['search']}%`);
    clauses.push(`AND p.name ILIKE $${params.length}`);
  }
  return query<Product>(`${PRODUCT_SELECT} ${clauses.join(' ')} ORDER BY p.category, p.name`, params);
}

function readProductBody(ctx: Ctx) {
  const { body } = ctx;
  const name = str(body['name'], 'שם המוצר', { max: 100 });
  return {
    name,
    name_key: keyFor(name),
    unit: optionalStr(body['unit'], 'יחידה', 20) ?? 'יח׳',
    category: optionalStr(body['category'], 'מדף', 40) ?? 'כללי',
    min_qty: optionalNum(body['min_qty'], 'כמות מינימלית', { min: 0, max: 10_000 }) ?? 0,
    default_location: oneOf(body['default_location'], 'מיקום', LOCATIONS, 'מזווה'),
    shelf_life_days: optionalInt(body['shelf_life_days'], 'ימי מדף'),
    barcode: optionalStr(body['barcode'], 'ברקוד', 40),
    note: optionalStr(body['note'], 'הערה', 500),
  };
}

async function createProduct(ctx: Ctx): Promise<Product | null> {
  const p = readProductBody(ctx);
  const row = await one<{ id: number }>(
    `INSERT INTO products (name, name_key, unit, category, min_qty, default_location, shelf_life_days, barcode, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (name_key) DO NOTHING RETURNING id`,
    [p.name, p.name_key, p.unit, p.category, p.min_qty, p.default_location, p.shelf_life_days, p.barcode, p.note],
  );
  if (!row) throw conflict(`כבר יש מוצר בשם «${p.name}»`);
  // A new product with a minimum and nothing on the shelf belongs on the list
  // immediately — that is usually exactly why it was just created.
  await syncShoppingListFromStock(ctx.user.email);
  return getProduct(row.id);
}

async function updateProduct(ctx: Ctx): Promise<Product | null> {
  const id = Number(ctx.params['id']);
  const p = readProductBody(ctx);
  const row = await one<{ id: number }>(
    `UPDATE products SET name=$2, name_key=$3, unit=$4, category=$5, min_qty=$6,
            default_location=$7, shelf_life_days=$8, barcode=$9, note=$10,
            archived_at = CASE WHEN $11::boolean IS TRUE THEN NOW() WHEN $11::boolean IS FALSE THEN NULL ELSE archived_at END
      WHERE id=$1 RETURNING id`,
    [id, p.name, p.name_key, p.unit, p.category, p.min_qty, p.default_location, p.shelf_life_days, p.barcode, p.note,
      ctx.body['archived'] === undefined ? null : ctx.body['archived'] === true],
  );
  if (!row) throw notFound('המוצר לא נמצא');
  // Raising the minimum is the other way an item lands on the list.
  await syncShoppingListFromStock(ctx.user.email);
  return getProduct(id);
}

// ── Stock ────────────────────────────────────────────────────────────────

async function listStock(ctx: Ctx): Promise<StockEntry[]> {
  const params: unknown[] = [];
  const clauses = ['WHERE e.qty > 0'];
  if (ctx.params['id']) {
    params.push(Number(ctx.params['id']));
    clauses.push(`AND e.product_id = $${params.length}`);
  }
  if (ctx.query['expiring_days']) {
    params.push(int(ctx.query['expiring_days'], 'expiring_days', { min: 0, max: 365 }));
    clauses.push(`AND e.expires_on IS NOT NULL AND e.expires_on <= CURRENT_DATE + ($${params.length} || ' days')::interval`);
  }
  return query<StockEntry>(
    `SELECT e.id, e.product_id, p.name AS product_name, e.qty, e.location,
            to_char(e.expires_on, 'YYYY-MM-DD') AS expires_on,
            to_char(e.opened_on, 'YYYY-MM-DD') AS opened_on,
            e.price, to_char(e.purchased_on, 'YYYY-MM-DD') AS purchased_on, e.created_by
       FROM stock_entries e JOIN products p ON p.id = e.product_id
       ${clauses.join(' ')}
      ORDER BY e.expires_on NULLS LAST, p.name`,
    params,
  );
}

/**
 * Puts a batch on the shelf.
 *
 * The expiry date is pre-filled from `shelf_life_days` when the caller does
 * not give one, because the moment somebody has to compute "today plus nine
 * days" by hand is the moment they stop entering expiry dates at all.
 */
async function addStock(ctx: Ctx) {
  const productId = int(ctx.body['product_id'] ?? ctx.params['id'], 'מוצר');
  const product = await getProduct(productId);
  if (!product) throw notFound('המוצר לא נמצא');

  const qty = num(ctx.body['qty'], 'כמות', { min: 0.01, max: 100_000 });
  const explicitExpiry = optionalDate(ctx.body['expires_on'], 'תפוגה');
  const purchasedOn = date(ctx.body['purchased_on'] ?? new Date().toISOString().slice(0, 10), 'תאריך קנייה');

  return transaction(async (client) => {
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO stock_entries (product_id, qty, location, expires_on, price, purchased_on, created_by)
       VALUES ($1, $2, $3,
               COALESCE($4::date, CASE WHEN $7::int IS NULL THEN NULL ELSE $6::date + ($7 || ' days')::interval END),
               $5, $6, $8)
       RETURNING id`,
      [
        productId, qty,
        oneOf(ctx.body['location'], 'מיקום', LOCATIONS, product.default_location),
        explicitExpiry,
        optionalNum(ctx.body['price'], 'מחיר', { min: 0, max: 100_000 }),
        purchasedOn,
        product.shelf_life_days,
        ctx.user.email,
      ],
    );
    await client.query(
      `INSERT INTO stock_log (product_id, entry_id, action, qty_delta, note, actor)
       VALUES ($1, $2, 'add', $3, $4, $5)`,
      [productId, rows[0]?.id ?? null, qty, optionalStr(ctx.body['note'], 'הערה', 300), ctx.user.email],
    );
    return { ok: true, entry_id: rows[0]?.id ?? null };
  });
}

/**
 * Takes some of a product off the shelf, oldest expiry first.
 *
 * Consuming more than the app thinks we have is allowed on purpose: the count
 * is often wrong, and a refusal here teaches us to stop recording rather than
 * to go and correct the count. The shortfall comes back in the response so the
 * screen can say so.
 */
async function consumeStock(ctx: Ctx) {
  const productId = int(ctx.body['product_id'] ?? ctx.params['id'], 'מוצר');
  const qty = num(ctx.body['qty'], 'כמות', { min: 0.01, max: 100_000 });
  const action = oneOf(ctx.body['action'], 'פעולה', ['consume', 'discard'] as const, 'consume');

  const result = await transaction(async (client) => {
    const { rows: entries } = await client.query<{ id: number; qty: number; expires_on: string | null; purchased_on: string }>(
      `SELECT id, qty, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, to_char(purchased_on, 'YYYY-MM-DD') AS purchased_on
         FROM stock_entries WHERE product_id = $1 AND qty > 0 FOR UPDATE`,
      [productId],
    );
    const { updates, shortfall } = applyConsumption(entries, qty);
    for (const u of updates) {
      await client.query(`UPDATE stock_entries SET qty = $2 WHERE id = $1`, [u.id, u.qty]);
      await client.query(
        `INSERT INTO stock_log (product_id, entry_id, action, qty_delta, note, actor) VALUES ($1, $2, $3, $4, $5, $6)`,
        [productId, u.id, action, -u.taken, optionalStr(ctx.body['note'], 'הערה', 300), ctx.user.email],
      );
    }
    return { taken: qty - shortfall, shortfall };
  });

  // Dropping under the minimum is the event the shopping list is waiting for.
  const { added } = await syncShoppingListFromStock(ctx.user.email);
  const product = await getProduct(productId);
  return { ...result, product, added_to_list: added.map((p) => p.name) };
}

/** Sets the count to what is actually there. Used after opening the fridge and counting. */
async function correctStock(ctx: Ctx) {
  const productId = int(ctx.body['product_id'] ?? ctx.params['id'], 'מוצר');
  const target = num(ctx.body['qty'], 'כמות', { min: 0, max: 100_000 });
  const product = await getProduct(productId);
  if (!product) throw notFound('המוצר לא נמצא');
  const delta = target - product.in_stock;
  if (delta === 0) return { ok: true, product, changed: false };

  await transaction(async (client) => {
    if (delta > 0) {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO stock_entries (product_id, qty, location, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [productId, delta, product.default_location, ctx.user.email],
      );
      await client.query(
        `INSERT INTO stock_log (product_id, entry_id, action, qty_delta, note, actor) VALUES ($1,$2,'correct',$3,'ספירת מלאי',$4)`,
        [productId, rows[0]?.id ?? null, delta, ctx.user.email],
      );
      return;
    }
    const { rows: entries } = await client.query<{ id: number; qty: number; expires_on: string | null; purchased_on: string }>(
      `SELECT id, qty, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, to_char(purchased_on, 'YYYY-MM-DD') AS purchased_on
         FROM stock_entries WHERE product_id = $1 AND qty > 0 FOR UPDATE`,
      [productId],
    );
    const { updates } = applyConsumption(entries, -delta);
    for (const u of updates) {
      await client.query(`UPDATE stock_entries SET qty = $2 WHERE id = $1`, [u.id, u.qty]);
    }
    await client.query(
      `INSERT INTO stock_log (product_id, action, qty_delta, note, actor) VALUES ($1,'correct',$2,'ספירת מלאי',$3)`,
      [productId, delta, ctx.user.email],
    );
  });

  await syncShoppingListFromStock(ctx.user.email);
  return { ok: true, product: await getProduct(productId), changed: true };
}

// ── Routes ───────────────────────────────────────────────────────────────

export default router([
  { method: 'GET', path: 'products', role: 'viewer', handle: listProducts },
  { method: 'POST', path: 'products', handle: createProduct },
  {
    method: 'GET', path: 'products/:id', role: 'viewer',
    handle: async (ctx) => {
      const product = await getProduct(Number(ctx.params['id']));
      if (!product) throw notFound('המוצר לא נמצא');
      const history = await query(
        `SELECT action, qty_delta, note, actor, created_at FROM stock_log
          WHERE product_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [product.id],
      );
      return { product, entries: await listStock(ctx), history };
    },
  },
  { method: 'PATCH', path: 'products/:id', handle: updateProduct },
  {
    method: 'DELETE', path: 'products/:id',
    handle: async (ctx) => {
      // Archive, never delete: the stock log is the only record of what this
      // household actually goes through, and a DELETE would cascade it away.
      const row = await one(`UPDATE products SET archived_at = NOW() WHERE id = $1 RETURNING id`, [Number(ctx.params['id'])]);
      if (!row) throw notFound('המוצר לא נמצא');
      return { ok: true };
    },
  },

  { method: 'GET', path: 'stock', role: 'viewer', handle: listStock },
  { method: 'POST', path: 'stock', handle: addStock },
  { method: 'POST', path: 'products/:id/stock', handle: addStock },
  { method: 'POST', path: 'products/:id/consume', handle: consumeStock },
  { method: 'POST', path: 'products/:id/correct', handle: correctStock },
  {
    method: 'DELETE', path: 'stock/:id',
    handle: async (ctx) => {
      const row = await one<{ product_id: number; qty: number }>(
        `UPDATE stock_entries SET qty = 0 WHERE id = $1 AND qty > 0 RETURNING product_id, qty`,
        [Number(ctx.params['id'])],
      );
      if (!row) throw notFound('האצווה לא נמצאה');
      await one(
        `INSERT INTO stock_log (product_id, entry_id, action, qty_delta, note, actor) VALUES ($1,$2,'discard',$3,'נזרק',$4) RETURNING id`,
        [row.product_id, Number(ctx.params['id']), -row.qty, ctx.user.email],
      );
      await syncShoppingListFromStock(ctx.user.email);
      return { ok: true };
    },
  },

  {
    method: 'GET', path: 'expiring', role: 'viewer',
    handle: async (ctx) => {
      const days = int(ctx.query['days'] ?? 7, 'days', { min: 0, max: 365 });
      return query(
        `SELECT e.id, e.product_id, p.name AS product_name, e.qty, e.location, p.unit,
                to_char(e.expires_on, 'YYYY-MM-DD') AS expires_on,
                (e.expires_on - CURRENT_DATE) AS days_left
           FROM stock_entries e JOIN products p ON p.id = e.product_id
          WHERE e.qty > 0 AND e.expires_on IS NOT NULL
            AND e.expires_on <= CURRENT_DATE + ($1 || ' days')::interval
          ORDER BY e.expires_on`,
        [days],
      );
    },
  },

  { method: 'POST', path: 'sync-list', handle: async (ctx) => syncShoppingListFromStock(ctx.user.email) },
]);
