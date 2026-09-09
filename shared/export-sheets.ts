/**
 * What an export contains, as data.
 *
 * The definitions live in shared/ rather than beside the handler for the reason
 * this project has settled on twice already: files under api/ import each other
 * with `.js` specifiers that Node's type-stripping cannot resolve, so anything
 * a test needs to see has to be reachable without them. The export is exactly
 * that — its column names and its joins are the part worth asserting, and the
 * part that quietly rots when a column is renamed.
 *
 * Note what is absent from every query: `WHERE household_id`. These run inside
 * the request's household scope, and row-level security supplies the filter.
 * Adding one by hand would read as though the isolation were this file's
 * responsibility, which is the belief the schema was rebuilt to remove.
 */

export interface Sheet {
  /** Filename stem and the key the client asks for. */
  name: string;
  label: string;
  columns: string[];
  sql: string;
}

export const SHEETS: Sheet[] = [
  {
    name: 'transactions',
    label: 'תנועות',
    // Names, not ids. The person opening this in Excel cannot join.
    columns: ['תאריך', 'סכום', 'בית עסק', 'קטגוריה', 'חשבון', 'שילם', 'שיוך', 'הערה', 'נמחק'],
    sql: `SELECT to_char(t.occurred_on, 'YYYY-MM-DD') AS "תאריך",
              t.amount                              AS "סכום",
              t.payee                               AS "בית עסק",
              c.name                                AS "קטגוריה",
              a.name                                AS "חשבון",
              COALESCE(pb.display_name, pb.name, t.paid_by) AS "שילם",
              CASE t.split WHEN 'shared' THEN 'משותף' ELSE 'אישי' END AS "שיוך",
              t.note                                AS "הערה",
              CASE WHEN t.deleted_at IS NULL THEN '' ELSE 'כן' END AS "נמחק"
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN accounts a   ON a.id = t.account_id
         LEFT JOIN users pb     ON pb.email = t.paid_by
        ORDER BY t.occurred_on DESC, t.id DESC`,
  },
  {
    name: 'budget',
    label: 'תקציב',
    columns: ['חודש', 'קבוצה', 'קטגוריה', 'סוג', 'מחויבות', 'הוקצה', 'הוצא'],
    sql: `SELECT to_char(b.month, 'YYYY-MM')  AS "חודש",
              g.name                        AS "קבוצה",
              c.name                        AS "קטגוריה",
              c.kind                        AS "סוג",
              c.commitment                  AS "מחויבות",
              b.allocated                   AS "הוקצה",
              COALESCE((
                SELECT -SUM(t.amount) FROM transactions t
                 WHERE t.category_id = c.id AND t.deleted_at IS NULL
                   AND t.occurred_on >= b.month
                   AND t.occurred_on < (b.month + INTERVAL '1 month')
              ), 0)                         AS "הוצא"
         FROM budget_allocations b
         JOIN categories c ON c.id = b.category_id
         LEFT JOIN category_groups g ON g.id = c.group_id
        ORDER BY b.month DESC, g.sort_order, c.sort_order`,
  },
  {
    name: 'accounts',
    label: 'חשבונות',
    columns: ['שם', 'סוג', 'יתרת פתיחה', 'יתרה', 'הועבר לארכיון'],
    sql: `SELECT a.name AS "שם",
              a.kind AS "סוג",
              a.opening_balance AS "יתרת פתיחה",
              a.opening_balance + COALESCE((
                SELECT SUM(t.amount) FROM transactions t
                 WHERE t.account_id = a.id AND t.deleted_at IS NULL
              ), 0) AS "יתרה",
              CASE WHEN a.archived_at IS NULL THEN '' ELSE 'כן' END AS "הועבר לארכיון"
         FROM accounts a ORDER BY a.sort_order, a.id`,
  },
  {
    name: 'pantry',
    label: 'מזווה',
    columns: ['מוצר', 'מדף', 'יחידה', 'כמות', 'מינימום', 'מיקום', 'תפוגה קרובה'],
    sql: `SELECT p.name AS "מוצר", p.category AS "מדף", p.unit AS "יחידה",
              COALESCE((SELECT SUM(e.qty) FROM stock_entries e
                         WHERE e.product_id = p.id AND e.qty > 0), 0) AS "כמות",
              p.min_qty AS "מינימום",
              p.default_location AS "מיקום",
              to_char((SELECT MIN(e.expires_on) FROM stock_entries e
                        WHERE e.product_id = p.id AND e.qty > 0), 'YYYY-MM-DD') AS "תפוגה קרובה"
         FROM products p
        WHERE p.archived_at IS NULL
        ORDER BY p.category, p.name`,
  },
  {
    name: 'shopping',
    label: 'קניות',
    columns: ['פריט', 'כמות', 'יחידה', 'מדף', 'מקור', 'מצב', 'נוסף', 'נקנה'],
    sql: `SELECT s.name AS "פריט", s.qty AS "כמות", s.unit AS "יחידה", s.category AS "מדף",
              CASE s.source WHEN 'auto_min_stock' THEN 'נגמר במזווה'
                            WHEN 'recipe' THEN 'מתכון' ELSE 'ידני' END AS "מקור",
              CASE s.status WHEN 'open' THEN 'פתוח'
                            WHEN 'bought' THEN 'נקנה' ELSE 'הוסר' END AS "מצב",
              to_char(s.created_at, 'YYYY-MM-DD') AS "נוסף",
              to_char(s.bought_at, 'YYYY-MM-DD')  AS "נקנה"
         FROM shopping_items s ORDER BY s.created_at DESC`,
  },
  {
    name: 'bills',
    label: 'חשבונות קבועים',
    columns: ['שם', 'קטגוריה', 'הערכה', 'תדירות', 'חיוב הבא', 'הוראת קבע', 'פעיל'],
    sql: `SELECT r.name AS "שם", c.name AS "קטגוריה", r.amount_estimate AS "הערכה",
              r.cadence AS "תדירות", to_char(r.next_due, 'YYYY-MM-DD') AS "חיוב הבא",
              CASE WHEN r.autopay THEN 'כן' ELSE '' END AS "הוראת קבע",
              CASE WHEN r.active THEN 'כן' ELSE '' END AS "פעיל"
         FROM recurring_bills r
         LEFT JOIN categories c ON c.id = r.category_id
        ORDER BY r.next_due`,
  },
];

export const SHEET_NAMES = SHEETS.map((s) => ({ name: s.name, label: s.label }));

export function findSheet(name: string): Sheet | undefined {
  return SHEETS.find((s) => s.name === name);
}

/** The tables the full backup keeps verbatim, for restoring rather than reading. */
export const BACKUP_TABLES = [
  'accounts', 'category_groups', 'categories', 'budget_allocations', 'transactions',
  'recurring_bills', 'settlements', 'products', 'stock_entries', 'stock_log', 'shopping_items',
] as const;
