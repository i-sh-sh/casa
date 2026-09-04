import { query, one } from './db.js';
import { normalizeName, restockQty } from '../../shared/pantry.js';
import type { Product } from '../../shared/types.js';

// The product row plus the two numbers nobody can read off the table itself:
// what is actually on the shelf, and when the oldest of it turns.
export const PRODUCT_SELECT = `
  SELECT p.*,
         COALESCE(s.in_stock, 0)::numeric AS in_stock,
         to_char(s.next_expiry, 'YYYY-MM-DD') AS next_expiry,
         (p.min_qty > 0 AND COALESCE(s.in_stock, 0) < p.min_qty) AS below_min
    FROM products p
    LEFT JOIN (
      SELECT product_id, SUM(qty) AS in_stock, MIN(expires_on) FILTER (WHERE expires_on IS NOT NULL) AS next_expiry
        FROM stock_entries WHERE qty > 0 GROUP BY product_id
    ) s ON s.product_id = p.id`;

export async function getProduct(id: number): Promise<Product | null> {
  return one<Product>(`${PRODUCT_SELECT} WHERE p.id = $1`, [id]);
}

/**
 * The rule the whole pantry exists for: what dropped below its minimum gets
 * put on the list, once.
 *
 * Runs after every stock change and again from the daily cron, so it has to be
 * safe to run constantly. It is: the partial unique index on
 * `shopping_items (product_id) WHERE status = 'open'` means the INSERT can
 * only ever add a product that is not already waiting to be bought, and
 * `ON CONFLICT DO NOTHING` turns the second attempt into a no-op instead of an
 * error. Without that index this function would re-add milk every night.
 *
 * It never removes anything. An item put on the list by hand, or one that is
 * back in stock because somebody shopped, is a decision — and a list that
 * deletes your rows while you are standing in the aisle is a list you stop
 * trusting.
 */
export async function syncShoppingListFromStock(actor: string | null = null): Promise<{ added: Product[] }> {
  const below = await query<Product>(`${PRODUCT_SELECT} WHERE p.archived_at IS NULL AND p.min_qty > 0 AND COALESCE(s.in_stock, 0) < p.min_qty`);
  if (below.length === 0) return { added: [] };

  const added: Product[] = [];
  for (const product of below) {
    const row = await one<{ id: number }>(
      `INSERT INTO shopping_items (name, name_key, product_id, qty, unit, category, source, added_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'auto_min_stock', $7)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        product.name,
        product.name_key,
        product.id,
        restockQty(product),
        product.unit,
        product.category,
        actor,
      ],
    );
    if (row) added.push(product);
  }
  return { added };
}

/** The name two spellings collapse onto, and the guard against writing an empty key. */
export function keyFor(name: string): string {
  const key = normalizeName(name);
  if (!key) throw new Error('empty product name');
  return key;
}
