import type { Ctx } from '../_lib/router.js';
import { query, one } from '../_lib/db.js';
import { badRequest, conflict } from '../_lib/http.js';
import { date, int, num, oneOf, optionalInt, optionalNum, optionalStr, str } from '../_lib/validate.js';
import { keyFor } from '../_lib/pantry-service.js';
import { learnPayee } from '../money/_payees.js';
import { nameKey } from '../../shared/budget-workbook.js';
import {
  itemKey, jsonShape, matchLine, parseReceipt, parseReceiptJson, planListClear, receiptFingerprint, receiptLink,
  type ItemRule, type ListItem, type MatchProduct, type ParsedReceipt,
} from '../../shared/receipts.js';

/**
 * A supermarket receipt, in two steps: read it, then apply what the person
 * agreed to.
 *
 * Two requests rather than one because the person has to see the lines
 * before anything is written. The parser reads layouts it was never shown,
 * and a wrong line in the pantry is found weeks later, if ever — so what the
 * second request receives is the reviewed lines, not the original text.
 */

const MAX_TEXT = 200_000;
const MAX_LINES = 300;

async function lookups() {
  const [products, rules] = await Promise.all([
    query<MatchProduct & { unit: string }>(
      `SELECT id, name, name_key, barcode, unit FROM products WHERE archived_at IS NULL ORDER BY name`,
    ),
    query<ItemRule>(`SELECT item_key, product_id, ignored FROM receipt_item_rules`),
  ]);
  return { products, rules };
}

/**
 * Opens the receipt a link points at, from here.
 *
 * The browser tries first (ReceiptSheet), because the phone is where the
 * chain expects the receipt to be opened. This is the fallback for when the
 * browser is refused. The URL is never the one that was pasted: receiptLink
 * rebuilds it from the id, for a host it knows.
 */
async function fetchLinked(text: string): Promise<ParsedReceipt | null> {
  const link = receiptLink(text);
  if (!link) return null;
  let res: Response;
  try {
    res = await fetch(link.data, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  } catch {
    throw badRequest('לא הצלחתי לפתוח את הקבלה מהקישור. נסו שוב, או הדביקו את טקסט הקבלה.');
  }
  if (!res.ok) {
    throw badRequest(`${link.store} לא נתנו לפתוח את הקבלה מכאן (${res.status}). פתחו את הקישור, העתיקו את הטקסט והדביקו אותו כאן.`);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw badRequest('הקישור לא החזיר קבלה שאפשר לקרוא. הדביקו את טקסט הקבלה במקום.');
  }
  const parsed = parseReceiptJson(data);
  if (!parsed.store) parsed.store = link.store;
  // Keys only, never values: enough to fix the parser, nothing personal.
  if (parsed.lines.length === 0) console.warn('receipt link: no items found', jsonShape(data));
  return parsed;
}

/** Reads pasted receipt text, the receipt's JSON, or a link to it, and proposes a product for each line. */
export async function previewReceipt(ctx: Ctx) {
  const text = str(ctx.body['text'], 'הקבלה', { max: MAX_TEXT });
  let parsed: ParsedReceipt = parseReceipt(text);
  // A pasted SMS has a link and nothing to read in itself.
  if (parsed.lines.length === 0) parsed = (await fetchLinked(text)) ?? parsed;
  if (parsed.lines.length === 0) throw badRequest(parsed.warnings.join(' · ') || 'לא מצאתי פריטים');
  if (parsed.lines.length > MAX_LINES) throw badRequest(`יותר מ-${MAX_LINES} שורות בקבלה`);

  const { products, rules } = await lookups();
  const purchasedOn = parsed.purchased_on ?? new Date().toISOString().slice(0, 10);

  const [duplicate, accounts, categories, rule] = await Promise.all([
    one<{ id: number; created_at: string }>(
      `SELECT id, created_at FROM receipts WHERE deleted_at IS NULL AND fingerprint = $1`,
      [receiptFingerprint({ ...parsed, purchased_on: purchasedOn })],
    ),
    query<{ id: number; name: string; kind: string }>(
      `SELECT id, name, kind FROM accounts WHERE archived_at IS NULL ORDER BY sort_order, id`,
    ),
    query<{ id: number; name: string; group_name: string | null }>(
      `SELECT c.id, c.name, g.name AS group_name
         FROM categories c LEFT JOIN category_groups g ON g.id = c.group_id
        WHERE c.archived_at IS NULL AND c.kind = 'spending'
        ORDER BY g.sort_order NULLS LAST, c.sort_order, c.id`,
    ),
    parsed.store
      ? one<{ category_id: number }>(`SELECT category_id FROM payee_rules WHERE payee_key = $1`, [nameKey(parsed.store)])
      : Promise.resolve(null),
  ]);

  // Without a rule, the category a supermarket most likely is.
  const guessed = rule?.category_id
    ?? categories.find((c) => /סופר|מזון|מכולת/.test(c.name))?.id
    ?? null;

  return {
    store: parsed.store,
    purchased_on: purchasedOn,
    dated: parsed.purchased_on != null,
    total: parsed.total,
    warnings: parsed.warnings,
    duplicate: duplicate != null,
    lines: parsed.lines.map((line) => ({ ...line, ...matchLine(line, products, rules) })),
    products: products.map((p) => ({ id: p.id, name: p.name, unit: p.unit })),
    accounts,
    categories,
    suggested: {
      account_id: accounts.find((a) => a.kind === 'credit')?.id ?? accounts[0]?.id ?? null,
      category_id: guessed,
    },
  };
}

interface AppliedLine {
  name: string;
  barcode: string | null;
  qty: number;
  total: number | null;
  action: 'product' | 'new' | 'skip';
  product_id: number | null;
}

function readLines(raw: unknown): AppliedLine[] {
  if (!Array.isArray(raw) || raw.length === 0) throw badRequest('אין שורות בקבלה');
  if (raw.length > MAX_LINES) throw badRequest(`יותר מ-${MAX_LINES} שורות בקבלה`);
  return raw.map((r) => {
    const l = (r ?? {}) as Record<string, unknown>;
    const barcode = optionalStr(l['barcode'], 'ברקוד', 20);
    return {
      name: str(l['name'], 'שם פריט', { max: 120 }),
      barcode: barcode && /^\d{4,14}$/.test(barcode) ? barcode : null,
      qty: num(l['qty'] ?? 1, 'כמות', { min: 0.001, max: 10_000 }),
      total: optionalNum(l['total'], 'מחיר', { min: -100_000, max: 100_000 }),
      action: oneOf(l['action'], 'פעולה', ['product', 'new', 'skip'] as const),
      product_id: optionalInt(l['product_id'], 'מוצר'),
    };
  });
}

/**
 * Applies a reviewed receipt: pantry, list, expense, and what to remember.
 *
 * All of it in the request's one transaction, so a failure halfway leaves no
 * half-stocked pantry with no receipt to explain it.
 */
export async function applyReceipt(ctx: Ctx) {
  const store = optionalStr(ctx.body['store'], 'חנות', 80) ?? '';
  const purchasedOn = date(ctx.body['purchased_on'], 'תאריך');
  const total = optionalNum(ctx.body['total'], 'סכום', { min: 0, max: 1_000_000 });
  const lines = readLines(ctx.body['lines']);
  const recordExpense = ctx.body['record_expense'] === true && total != null && total > 0;
  const accountId = recordExpense ? int(ctx.body['account_id'], 'חשבון') : null;
  const categoryId = recordExpense ? optionalInt(ctx.body['category_id'], 'קטגוריה') : null;
  const actor = ctx.user.email;

  const fingerprint = receiptFingerprint({ store, purchased_on: purchasedOn, total, lines });
  const receipt = await one<{ id: number }>(
    `INSERT INTO receipts (store, purchased_on, total, fingerprint, line_count, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (household_id, fingerprint) WHERE deleted_at IS NULL DO NOTHING
     RETURNING id`,
    [store, purchasedOn, total, fingerprint, lines.length, actor],
  );
  if (!receipt) throw conflict('הקבלה הזאת כבר נקלטה');

  const { products } = await lookups();
  const known = new Set(products.map((p) => p.id));

  // New products first, so every later step sees one kind of line.
  for (const line of lines) {
    if (line.action === 'new') {
      const name = line.name.trim();
      const created = await one<{ id: number }>(
        `INSERT INTO products (name, name_key, barcode)
         VALUES ($1, $2, $3)
         ON CONFLICT (household_id, name_key) DO UPDATE SET barcode = COALESCE(products.barcode, EXCLUDED.barcode)
         RETURNING id`,
        [name, keyFor(name), line.barcode],
      );
      line.product_id = created?.id ?? null;
      line.action = 'product';
      if (line.product_id != null) known.add(line.product_id);
    } else if (line.action === 'product' && (line.product_id == null || !known.has(line.product_id))) {
      throw badRequest(`המוצר שנבחר ל«${line.name}» לא נמצא`);
    }
  }

  const items = await query<ListItem>(
    `SELECT id, product_id, name_key, status FROM shopping_items WHERE status IN ('open', 'bought')`,
  );
  const stocked = lines.filter((l) => l.action === 'product');
  const { clear, alreadyStocked } = planListClear(stocked, items);

  let added = 0;
  for (const line of lines) {
    await query(
      `INSERT INTO receipt_lines (receipt_id, name, barcode, qty, total, product_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [receipt.id, line.name, line.barcode, line.qty, line.total, line.action === 'product' ? line.product_id : null],
    );

    // Remember the answer, including «not for the pantry».
    await query(
      `INSERT INTO receipt_item_rules (item_key, product_id, ignored)
       VALUES ($1, $2, $3)
       ON CONFLICT (household_id, item_key)
       DO UPDATE SET product_id = EXCLUDED.product_id, ignored = EXCLUDED.ignored,
                     hits = receipt_item_rules.hits + 1, updated_at = NOW()`,
      [itemKey(line.name), line.action === 'product' ? line.product_id : null, line.action === 'skip'],
    );

    if (line.action !== 'product' || line.product_id == null) continue;
    if (line.barcode) {
      await query(`UPDATE products SET barcode = $2 WHERE id = $1 AND barcode IS NULL`, [line.product_id, line.barcode]);
    }
    if (alreadyStocked.has(line.product_id)) continue;

    const unitPrice = line.total != null && line.qty > 0 ? Math.round((line.total / line.qty) * 100) / 100 : null;
    const entry = await one<{ id: number }>(
      `INSERT INTO stock_entries (product_id, qty, location, expires_on, price, purchased_on, created_by)
       SELECT id, $2, default_location,
              CASE WHEN shelf_life_days IS NULL THEN NULL ELSE $4::date + (shelf_life_days || ' days')::interval END,
              $3, $4, $5
         FROM products WHERE id = $1
       RETURNING id`,
      [line.product_id, Math.round(line.qty * 100) / 100 || 0.01, unitPrice != null && unitPrice >= 0 ? unitPrice : null, purchasedOn, actor],
    );
    await query(
      `INSERT INTO stock_log (product_id, entry_id, action, qty_delta, note, actor) VALUES ($1, $2, 'add', $3, $4, $5)`,
      [line.product_id, entry?.id ?? null, line.qty, store ? `קבלה · ${store}` : 'קבלה', actor],
    );
    added++;
  }

  // Off the list, as bought and done — not 'bought', which would wait for a
  // checkout that writes a second expense for the same trip.
  if (clear.length) {
    await query(
      `UPDATE shopping_items SET status = 'removed', bought_at = COALESCE(bought_at, NOW()), bought_by = COALESCE(bought_by, $2)
        WHERE id = ANY($1::int[])`,
      [clear, actor],
    );
  }

  let transactionId: number | null = null;
  if (recordExpense && accountId != null && total != null) {
    const tx = await one<{ id: number }>(
      `INSERT INTO transactions (occurred_on, account_id, category_id, amount, payee, note, paid_by, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
      [purchasedOn, accountId, categoryId, -Math.abs(total), store || 'סופר', `קבלה · ${lines.length} פריטים`, actor],
    );
    transactionId = tx?.id ?? null;
    await query(`UPDATE receipts SET transaction_id = $2 WHERE id = $1`, [receipt.id, transactionId]);
    if (store) await learnPayee(store, categoryId);
  }

  return { ok: true, receipt_id: receipt.id, stocked: added, cleared: clear.length, transaction_id: transactionId };
}

/** The last receipts, for the screen to say what already came in. */
export async function listReceipts() {
  return query(
    `SELECT r.id, r.store, to_char(r.purchased_on, 'YYYY-MM-DD') AS purchased_on, r.total, r.line_count,
            r.transaction_id IS NOT NULL AS has_expense, r.created_at
       FROM receipts r WHERE r.deleted_at IS NULL
      ORDER BY r.purchased_on DESC, r.id DESC LIMIT 20`,
  );
}
