import { query, one } from './db.js';
import { badRequest, conflict, notFound } from './http.js';
import { bool, int, oneOf, optionalInt, optionalNum, optionalStr, str } from './validate.js';
import { PRODUCT_SELECT, keyFor } from './pantry-service.js';
import { applyConsumption, normalizeName } from '../../shared/pantry.js';
import {
  EFFORTS, RECIPE_KINDS, cookConsumption, guessAisle, listChanges, nameCandidates, normalizeUnit, shoppingNeeds,
  type PlannedMeal, type StockFact,
} from '../../shared/meals.js';
import type { Ingredient, MealEntry, Product, Recipe, ShoppingItem } from '../../shared/types.js';

// Reads and writes for the cookbook and the week's dinners. Every decision —
// what to plan, what the week needs, what cooking takes off the shelf — is in
// shared/meals.ts; this file only fetches its inputs and stores its answers.

// ── Recipes ──────────────────────────────────────────────────────────────

export async function loadRecipes(opts: { includeArchived?: boolean; id?: number } = {}): Promise<Recipe[]> {
  const where: string[] = ['TRUE'];
  const params: unknown[] = [];
  if (!opts.includeArchived) where.push('r.archived_at IS NULL');
  if (opts.id !== undefined) { params.push(opts.id); where.push(`r.id = $${params.length}`); }

  const recipes = await query<Omit<Recipe, 'ingredients'>>(
    `SELECT r.id, r.name, r.kind, r.effort, r.liking, r.servings, r.source, r.note,
            r.archived_at, c.last_cooked, COALESCE(c.times, 0)::int AS times_cooked
       FROM recipes r
       LEFT JOIN (
         SELECT recipe_id, MAX(day) AS last_cooked, COUNT(*) AS times
           FROM meal_plan WHERE status = 'cooked' GROUP BY recipe_id
       ) c ON c.recipe_id = r.id
      WHERE ${where.join(' AND ')}
      ORDER BY r.liking DESC, r.name`,
    params,
  );
  if (recipes.length === 0) return [];

  const ingredients = await query<Ingredient & { recipe_id: number }>(
    `SELECT id, recipe_id, product_id, name, qty, unit, always_have
       FROM recipe_ingredients WHERE recipe_id = ANY($1::int[]) ORDER BY recipe_id, position, id`,
    [recipes.map((r) => r.id)],
  );
  const byRecipe = new Map<number, Ingredient[]>();
  for (const { recipe_id, ...ing } of ingredients) {
    const list = byRecipe.get(recipe_id) ?? [];
    list.push(ing);
    byRecipe.set(recipe_id, list);
  }
  return recipes.map((r) => ({ ...r, ingredients: byRecipe.get(r.id) ?? [] }));
}

/** The product an ingredient name already means here, if there is one. */
async function findProduct(name: string): Promise<number | null> {
  const candidates = nameCandidates(name);
  const row = await one<{ id: number }>(
    `SELECT id FROM products
      WHERE archived_at IS NULL AND name_key = ANY($1::text[])
      ORDER BY array_position($1::text[], name_key) LIMIT 1`,
    [candidates],
  );
  return row?.id ?? null;
}

function readIngredients(value: unknown): Ingredient[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw badRequest('המצרכים חייבים להיות רשימה');
  if (value.length > 60) throw badRequest('יותר מדי מצרכים במתכון אחד');
  return value
    .map((raw) => (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>)
    .filter((raw) => typeof raw['name'] === 'string' && raw['name'].trim() !== '')
    .map((raw) => ({
      product_id: optionalInt(raw['product_id'], 'מוצר'),
      name: str(raw['name'], 'שם המצרך', { max: 100 }),
      qty: optionalNum(raw['qty'], 'כמות', { min: 0.01, max: 100_000 }),
      unit: normalizeUnit(optionalStr(raw['unit'], 'יחידה', 20)),
      always_have: bool(raw['always_have']),
    }));
}

export async function saveRecipe(id: number | null, body: Record<string, unknown>, actor: string): Promise<Recipe> {
  const name = str(body['name'], 'שם המתכון', { max: 120 });
  const fields = [
    name,
    keyFor(name),
    oneOf(body['kind'], 'סוג', RECIPE_KINDS, 'צמחוני'),
    oneOf(body['effort'], 'זמן הכנה', EFFORTS, 'רגיל'),
    int(body['liking'] ?? 2, 'כמה אוהבים', { min: 1, max: 3 }),
    optionalInt(body['servings'], 'מנות'),
    optionalStr(body['source'], 'מקור', 500),
    optionalStr(body['note'], 'הערה', 4000),
  ];
  const ingredients = readIngredients(body['ingredients']);

  let recipeId: number;
  if (id === null) {
    const row = await one<{ id: number }>(
      `INSERT INTO recipes (name, name_key, kind, effort, liking, servings, source, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (household_id, name_key) WHERE archived_at IS NULL DO NOTHING
       RETURNING id`,
      [...fields, actor],
    );
    if (!row) throw conflict(`כבר יש מתכון בשם «${name}»`);
    recipeId = row.id;
  } else {
    const clash = await one(
      `SELECT 1 FROM recipes WHERE name_key = $1 AND id <> $2 AND archived_at IS NULL`, [fields[1], id]);
    if (clash) throw conflict(`כבר יש מתכון בשם «${name}»`);
    const row = await one<{ id: number }>(
      `UPDATE recipes SET name=$2, name_key=$3, kind=$4, effort=$5, liking=$6, servings=$7, source=$8, note=$9
        WHERE id = $1 RETURNING id`,
      [id, ...fields],
    );
    if (!row) throw notFound('המתכון לא נמצא');
    recipeId = id;
    // Replaced wholesale. An ingredient line has no history worth keeping —
    // the history is in meal_plan and stock_log — and diffing a reordered,
    // re-pasted list line by line would be all risk and no benefit.
    await query(`DELETE FROM recipe_ingredients WHERE recipe_id = $1`, [recipeId]);
  }

  for (const [position, ing] of ingredients.entries()) {
    const productId = ing.product_id ?? (ing.always_have ? null : await findProduct(ing.name));
    await query(
      `INSERT INTO recipe_ingredients (recipe_id, product_id, name, name_key, qty, unit, always_have, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [recipeId, productId, ing.name, normalizeName(ing.name), ing.qty, ing.unit, ing.always_have, position],
    );
  }

  const [saved] = await loadRecipes({ id: recipeId, includeArchived: true });
  return saved!;
}

// ── Stock, as the planner sees it ────────────────────────────────────────

export async function stockFacts(): Promise<Map<number, StockFact>> {
  const products = await query<Product>(`${PRODUCT_SELECT} WHERE p.archived_at IS NULL`);
  return new Map(products.map((p) => [p.id, { in_stock: p.in_stock, next_expiry: p.next_expiry, name: p.name, unit: p.unit }]));
}

// Units a shop sells in. A recipe's «כף» or «כוס» is a measure, not
// something on a shelf label, so a product created from one is counted in
// units and compared with «is there any at all».
const PURCHASE_UNITS = new Set(['יח׳', 'גרם', 'ק״ג', 'ליטר', 'מ״ל', 'חבילה', 'פחית', 'קופסה', 'צרור']);

/**
 * Makes sure every ingredient the coming meals need to buy is a product.
 *
 * Done here, at the moment something has to be bought, rather than when the
 * recipe is saved: a cookbook of forty recipes would otherwise fill the
 * pantry with a hundred products nobody has ever bought. Once it exists,
 * buying it puts it on the shelf, «בישלנו» takes it off, and next week the
 * planner knows whether we have it — none of which works for a bare name.
 * `min_qty` stays 0, so it never lands on the list by itself.
 */
async function linkUnlinked(recipeIds: number[]): Promise<void> {
  if (recipeIds.length === 0) return;
  const loose = await query<{ id: number; name: string; unit: string | null }>(
    `SELECT id, name, unit FROM recipe_ingredients
      WHERE recipe_id = ANY($1::int[]) AND product_id IS NULL AND NOT always_have`,
    [recipeIds],
  );
  for (const ing of loose) {
    let productId = await findProduct(ing.name);
    if (!productId) {
      const unit = ing.unit && PURCHASE_UNITS.has(ing.unit) ? ing.unit : 'יח׳';
      const created = await one<{ id: number }>(
        `INSERT INTO products (name, name_key, unit, category) VALUES ($1, $2, $3, $4)
         ON CONFLICT (household_id, name_key) DO NOTHING RETURNING id`,
        [ing.name, keyFor(ing.name), unit, guessAisle(ing.name)],
      );
      productId = created?.id ?? await findProduct(ing.name);
    }
    if (productId) await query(`UPDATE recipe_ingredients SET product_id = $2 WHERE id = $1`, [ing.id, productId]);
  }
}

/**
 * Brings the shopping list in line with the dinners still ahead.
 *
 * Called after every change to the plan, and safe to call any time: it
 * computes the whole answer from the plan and the shelf, and writes only the
 * difference. The rules about whose line may be changed are in
 * listChanges (shared/meals.ts); the short version is that the plan only
 * ever touches lines the plan wrote.
 *
 * «Ahead» is today and the next two weeks. A meal planned for next month is
 * not a reason to buy cream today.
 */
export async function syncMealsToList(actor: string | null): Promise<{ added: string[]; updated: number; removed: number }> {
  const upcoming = await query<{ day: string; recipe_id: number; recipe_name: string }>(
    `SELECT m.day, m.recipe_id, r.name AS recipe_name
       FROM meal_plan m JOIN recipes r ON r.id = m.recipe_id
      WHERE m.status = 'planned' AND m.day >= CURRENT_DATE AND m.day < CURRENT_DATE + 14
      ORDER BY m.day`,
  );
  const recipeIds = [...new Set(upcoming.map((m) => m.recipe_id))];
  await linkUnlinked(recipeIds);

  const recipes = recipeIds.length ? await loadRecipes({ includeArchived: true }) : [];
  const ingredientsOf = new Map(recipes.map((r) => [r.id, r.ingredients]));
  const meals: PlannedMeal[] = upcoming.map((m) => ({
    day: m.day, recipe_name: m.recipe_name, ingredients: ingredientsOf.get(m.recipe_id) ?? [],
  }));

  const needs = shoppingNeeds(meals, await stockFacts());
  const open = await query<ShoppingItem>(`SELECT * FROM shopping_items WHERE status = 'open'`);
  const changes = listChanges(needs, open);

  const added: string[] = [];
  for (const need of changes.add) {
    const product = await one<{ category: string }>(`SELECT category FROM products WHERE id = $1`, [need.product_id]);
    const row = await one<{ id: number }>(
      `INSERT INTO shopping_items (name, name_key, product_id, qty, unit, category, note, source, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'recipe',$8)
       ON CONFLICT DO NOTHING RETURNING id`,
      [need.name, need.name_key, need.product_id, need.qty, need.unit, product?.category ?? 'כללי', need.note, actor],
    );
    if (row) added.push(need.name);
  }
  for (const u of changes.update) {
    await query(`UPDATE shopping_items SET qty = $2, note = $3 WHERE id = $1 AND status = 'open'`, [u.id, u.qty, u.note]);
  }
  if (changes.remove.length) {
    // 'removed', like every other line that leaves the list: the row is history.
    await query(`UPDATE shopping_items SET status = 'removed' WHERE id = ANY($1::int[]) AND status = 'open'`, [changes.remove]);
  }
  return { added, updated: changes.update.length, removed: changes.remove.length };
}

// ── The plan ─────────────────────────────────────────────────────────────

export async function weekEntries(week: string): Promise<MealEntry[]> {
  return query<MealEntry>(
    `SELECT m.id, m.day, m.recipe_id, r.name AS recipe_name, r.kind, r.effort, m.status
       FROM meal_plan m JOIN recipes r ON r.id = m.recipe_id
      WHERE m.day >= $1::date AND m.day < $1::date + 7
      ORDER BY m.day`,
    [week],
  );
}

/**
 * Sets one day's dinner, or clears it. A cooked day is history and stays —
 * swapping Tuesday on Thursday must not rewrite what we actually ate.
 */
export async function setDay(day: string, recipeId: number | null, actor: string): Promise<void> {
  if (recipeId === null) {
    await query(`DELETE FROM meal_plan WHERE day = $1 AND status = 'planned'`, [day]);
    return;
  }
  const recipe = await one(`SELECT 1 FROM recipes WHERE id = $1 AND archived_at IS NULL`, [recipeId]);
  if (!recipe) throw notFound('המתכון לא נמצא');
  await query(
    `INSERT INTO meal_plan (day, recipe_id, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (household_id, day) DO UPDATE SET recipe_id = EXCLUDED.recipe_id
       WHERE meal_plan.status = 'planned'`,
    [day, recipeId, actor],
  );
}

/**
 * «בישלנו»: the day becomes history, and what went into the pot comes off
 * the shelf, oldest expiry first — the same rule as the pantry's minus button.
 */
export async function cook(recipeId: number, day: string, actor: string): Promise<{ taken: string[] }> {
  const [recipe] = await loadRecipes({ id: recipeId, includeArchived: true });
  if (!recipe) throw notFound('המתכון לא נמצא');

  const existing = await one<{ status: string }>(`SELECT status FROM meal_plan WHERE day = $1`, [day]);
  if (existing?.status === 'cooked') throw conflict('הארוחה של היום הזה כבר סומנה כמבושלת');
  await query(
    `INSERT INTO meal_plan (day, recipe_id, status, cooked_at, created_by) VALUES ($1, $2, 'cooked', NOW(), $3)
     ON CONFLICT (household_id, day) DO UPDATE SET recipe_id = EXCLUDED.recipe_id, status = 'cooked', cooked_at = NOW()`,
    [day, recipeId, actor],
  );

  const stock = await stockFacts();
  const taken: string[] = [];
  for (const { product_id, qty } of cookConsumption(recipe.ingredients, stock)) {
    const entries = await query<{ id: number; qty: number; expires_on: string | null; purchased_on: string }>(
      `SELECT id, qty, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, to_char(purchased_on, 'YYYY-MM-DD') AS purchased_on
         FROM stock_entries WHERE product_id = $1 AND qty > 0 FOR UPDATE`,
      [product_id],
    );
    const { updates } = applyConsumption(entries, qty);
    for (const u of updates) {
      await query(`UPDATE stock_entries SET qty = $2 WHERE id = $1`, [u.id, u.qty]);
      await query(
        `INSERT INTO stock_log (product_id, entry_id, action, qty_delta, note, actor) VALUES ($1, $2, 'consume', $3, $4, $5)`,
        [product_id, u.id, -u.taken, recipe.name, actor],
      );
    }
    if (updates.length) taken.push(stock.get(product_id)!.name);
  }
  return { taken };
}
