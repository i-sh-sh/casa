import { router, type Ctx } from '../_lib/router.js';
import { query, one, getPool } from '../_lib/db.js';
import { badRequest, forbidden, notFound } from '../_lib/http.js';
import { oneOf, optionalStr, str } from '../_lib/validate.js';
import { SCHEMA_SQL } from '../../db/schema.js';
import { SEED_SQL } from './_seed.js';
import type { Role } from '../_lib/auth.js';

const ROLES = ['owner', 'member', 'viewer', 'pending'] as const;

/**
 * Runs the whole schema, again.
 *
 * Every statement in it is `IF NOT EXISTS`, so this is safe to press at any
 * time and safe to press twice. That is the entire design: the person pressing
 * it after a deploy has no way to know which half already ran, and should not
 * have to.
 */
async function migrate() {
  const client = await getPool().connect();
  try {
    await client.query(SCHEMA_SQL);
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    return { ok: true, tables: tables.rows.map((r) => r.table_name) };
  } finally {
    client.release();
  }
}

/**
 * The starting categories and aisles, so the first screen is not empty.
 *
 * An empty budget is not a blank slate, it is a chore: nobody sets up
 * seventeen categories before they can record the first coffee. These are the
 * Israeli household defaults — ארנונה, ועד בית, סופר — and every one of them
 * can be renamed or archived.
 *
 * Refuses to run once there is anything to lose.
 */
async function seed() {
  const existing = await one<{ count: number }>(`SELECT COUNT(*)::int AS count FROM categories`);
  if ((existing?.count ?? 0) > 0) {
    throw badRequest('כבר יש קטגוריות במערכת — הזריעה רצה רק על מסד ריק');
  }
  const client = await getPool().connect();
  try {
    await client.query(SEED_SQL);
  } finally {
    client.release();
  }
  const [groups, categories, products] = await Promise.all([
    one<{ count: number }>(`SELECT COUNT(*)::int AS count FROM category_groups`),
    one<{ count: number }>(`SELECT COUNT(*)::int AS count FROM categories`),
    one<{ count: number }>(`SELECT COUNT(*)::int AS count FROM products`),
  ]);
  return { ok: true, groups: groups?.count ?? 0, categories: categories?.count ?? 0, products: products?.count ?? 0 };
}

async function listUsers() {
  return query(
    `SELECT email, name, display_name, picture, role, color, created_at, last_seen_at
       FROM users ORDER BY CASE role WHEN 'pending' THEN 0 ELSE 1 END, created_at`,
  );
}

async function setUserRole(ctx: Ctx) {
  const email = str(ctx.params['email'], 'email', { max: 200 }).toLowerCase();
  const role = oneOf(ctx.body['role'], 'תפקיד', ROLES) as Role;

  if (email === ctx.user.email && role !== 'owner') {
    // Demoting yourself out of the only owner seat locks the household out of
    // its own budget with no way back in but a psql console.
    const owners = await one<{ count: number }>(`SELECT COUNT(*)::int AS count FROM users WHERE role = 'owner'`);
    if ((owners?.count ?? 0) <= 1) throw forbidden('אתם בעל הבית היחיד — קדמו מישהו אחר לפני שתורידו את עצמכם');
  }

  const row = await one(
    `UPDATE users SET role = $2, display_name = COALESCE($3, display_name), color = COALESCE($4, color)
      WHERE email = $1 RETURNING email, name, display_name, role, color`,
    [email, role, optionalStr(ctx.body['display_name'], 'שם תצוגה', 60), optionalStr(ctx.body['color'], 'צבע', 20)],
  );
  if (!row) throw notFound('המשתמש לא נמצא');
  return row;
}

export default router([
  { method: 'POST', path: 'migrate', role: 'owner', handle: migrate },
  { method: 'POST', path: 'seed', role: 'owner', handle: seed },
  { method: 'GET', path: 'users', role: 'owner', handle: listUsers },
  { method: 'PATCH', path: 'users/:email', role: 'owner', handle: setUserRole },
  {
    method: 'GET', path: 'health', role: 'viewer',
    handle: async () => {
      const tables = await query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      const names = tables.map((t) => t.table_name);
      const expected = [
        'users', 'accounts', 'category_groups', 'categories', 'budget_allocations',
        'transactions', 'recurring_bills', 'settlements', 'products', 'stock_entries',
        'stock_log', 'shopping_items', 'push_subscriptions', 'sent_notifications',
      ];
      const missing = expected.filter((t) => !names.includes(t));
      return {
        ok: missing.length === 0,
        missing,
        hint: missing.length ? 'הריצו מיגרציה: «הגדרות» ← «מסד הנתונים»' : null,
      };
    },
  },
]);
