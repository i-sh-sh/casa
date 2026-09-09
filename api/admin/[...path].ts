import { router, type Ctx } from '../_lib/router.js';
import { query, one, getPool } from '../_lib/db.js';
import { badRequest, forbidden, notFound, HttpError } from '../_lib/http.js';
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
    try {
      await client.query(SCHEMA_SQL);
    } catch (err) {
      // Say what Postgres said.
      //
      // This used to become a flat "שגיאת שרת", and that cost hours: one
      // statement in the middle of the file failed (an index expression that
      // was not IMMUTABLE), every table after it was silently skipped, and the
      // only clue anywhere was a list of missing tables on another card. The
      // owner pressing this button is the one person who can act on the real
      // message, and this route is owner-only, so they get it.
      const pg = err as { message?: string; code?: string; position?: string; hint?: string };
      const at = pg.position ? charContext(SCHEMA_SQL, Number(pg.position)) : null;
      throw new HttpError(500, [
        'המיגרציה נכשלה ועצרה באמצע. מה ש-Postgres אמר:',
        `${pg.code ? `[${pg.code}] ` : ''}${pg.message ?? String(err)}`,
        at ? `ליד: ${at}` : null,
        pg.hint ?? null,
        'הטבלאות שכן נוצרו נשארו. אחרי תיקון אפשר להריץ שוב בבטחה.',
      ].filter(Boolean).join('\n'));
    }
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    return { ok: true, tables: tables.rows.map((r) => r.table_name) };
  } finally {
    client.release();
  }
}

/** The line the failure points at — a character offset alone is unreadable. */
function charContext(sql: string, position: number): string {
  if (!Number.isFinite(position) || position < 1) return '';
  const upto = sql.slice(0, position);
  const lineStart = upto.lastIndexOf('\n') + 1;
  const lineEnd = sql.indexOf('\n', position);
  return sql.slice(lineStart, lineEnd === -1 ? position + 60 : lineEnd).trim().slice(0, 160);
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
  // Deliberately NOT its own connection. Taking one from the pool would land
  // on a connection with no `casa.household_id`, where household_id defaults to
  // NULL and every insert fails the NOT NULL — or, worse on a future schema,
  // succeeds into nobody's home. `query` uses the request's scoped client.
  await query(SEED_SQL);
  const [groups, categories, products] = await Promise.all([
    one<{ count: number }>(`SELECT COUNT(*)::int AS count FROM category_groups`),
    one<{ count: number }>(`SELECT COUNT(*)::int AS count FROM categories`),
    one<{ count: number }>(`SELECT COUNT(*)::int AS count FROM products`),
  ]);
  return { ok: true, groups: groups?.count ?? 0, categories: categories?.count ?? 0, products: products?.count ?? 0 };
}

/**
 * Who is in *this* home.
 *
 * Scoped by hand against `household_members`, which is one of the three tables
 * outside row-level security — so the `WHERE m.household_id` below is the only
 * thing standing between this and another couple's roster. It is here rather
 * than in a module router for that reason: the hand-scoped queries are meant to
 * be few and findable.
 */
async function listUsers(ctx: Ctx) {
  return query(
    `SELECT u.email, u.name, u.display_name, u.picture, u.color, m.role, m.joined_at
       FROM household_members m
       JOIN users u ON u.email = m.email
      WHERE m.household_id = $1
      ORDER BY CASE m.role WHEN 'pending' THEN 0 ELSE 1 END, m.joined_at`,
    [ctx.user.household_id],
  );
}

async function setUserRole(ctx: Ctx) {
  const email = str(ctx.body['email'] ?? ctx.params['email'], 'email', { max: 200 }).toLowerCase();
  const role = oneOf(ctx.body['role'], 'תפקיד', ROLES) as Role;

  if (email === ctx.user.email && role !== 'owner') {
    // Demoting yourself out of the only owner seat locks the household out of
    // its own budget with no way back in but a psql console.
    const owners = await one<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM household_members WHERE household_id = $1 AND role = 'owner'`,
      [ctx.user.household_id],
    );
    if ((owners?.count ?? 0) <= 1) throw forbidden('אתם בעל הבית היחיד — קדמו מישהו אחר לפני שתורידו את עצמכם');
  }

  // Two statements, because they change two different things: the role belongs
  // to this membership, the display name and colour belong to the person.
  const membership = await one(
    `UPDATE household_members SET role = $3
      WHERE household_id = $1 AND email = $2
      RETURNING email, role`,
    [ctx.user.household_id, email, role],
  );
  if (!membership) throw notFound('המשתמש לא נמצא בבית הזה');

  const row = await one(
    `UPDATE users SET display_name = COALESCE($2, display_name), color = COALESCE($3, color)
      WHERE email = $1 RETURNING email, name, display_name, color`,
    [email, optionalStr(ctx.body['display_name'], 'שם תצוגה', 60), optionalStr(ctx.body['color'], 'צבע', 20)],
  );
  return { ...row, role };
}

export default router([
  { method: 'POST', path: 'migrate', bootstrap: true, handle: migrate },
  { method: 'POST', path: 'seed', role: 'owner', handle: seed },
  { method: 'GET', path: 'users', role: 'owner', unscoped: true, handle: listUsers },
  { method: 'PATCH', path: 'users', role: 'owner', handle: setUserRole },
  { method: 'PATCH', path: 'users/:email', role: 'owner', handle: setUserRole },
  {
    method: 'GET', path: 'health', bootstrap: true,
    handle: async () => {
      const tables = await query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      const names = tables.map((t) => t.table_name);
      const expected = [
        'users', 'households', 'household_members', 'household_invites',
        'accounts', 'category_groups', 'categories', 'budget_allocations',
        'transactions', 'recurring_bills', 'settlements', 'products', 'stock_entries',
        'stock_log', 'shopping_items', 'push_subscriptions', 'sent_notifications',
      ];
      const missing = expected.filter((t) => !names.includes(t));

      // Whether the separation between homes is actually being enforced, as
      // opposed to merely configured. See proveIsolation in _lib/db.ts: for a
      // superuser or a BYPASSRLS role every policy is listed and none applies,
      // and the only symptom would be one household reading another's money.
      const isolation = await one<{ active: boolean; unsafe_role: boolean }>(
        `SELECT row_security_active('accounts') AS active,
                (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS unsafe_role`,
      ).catch(() => null);

      return {
        ok: missing.length === 0,
        missing,
        isolation: isolation
          ? { enforced: !!isolation.active && !isolation.unsafe_role, unsafe_role: !!isolation.unsafe_role }
          : null,
        hint: missing.length ? 'הריצו מיגרציה: «הגדרות» ← «מסד הנתונים»' : null,
      };
    },
  },
]);
