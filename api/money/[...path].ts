import { randomUUID } from 'node:crypto';
import { router, type Ctx } from '../_lib/router.js';
import { query, one, transaction } from '../_lib/db.js';
import { badRequest, conflict, notFound } from '../_lib/http.js';
import { bool, date, int, num, oneOf, optionalDate, optionalInt, optionalNum, optionalStr, str } from '../_lib/validate.js';
import { advanceDue, buildBudgetMonth, computeBalance, monthKey } from '../../shared/money.js';
import type { Account, Category, Transaction } from '../../shared/types.js';

const ACCOUNT_KINDS = ['bank', 'cash', 'credit', 'savings'] as const;
const CATEGORY_KINDS = ['spending', 'income', 'saving'] as const;
const CADENCES = ['monthly', 'bimonthly', 'quarterly', 'yearly'] as const;
const SPLITS = ['shared', 'personal'] as const;

// ── Accounts ─────────────────────────────────────────────────────────────

async function listAccounts(): Promise<Account[]> {
  // The balance is computed here and nowhere else. Storing it would mean two
  // sources of truth for the same number, and the day they disagree is the day
  // neither can be trusted.
  return query<Account>(
    `SELECT a.*,
            (a.opening_balance + COALESCE(t.total, 0))::numeric AS balance
       FROM accounts a
       LEFT JOIN (
         SELECT account_id, SUM(amount) AS total
           FROM transactions WHERE deleted_at IS NULL GROUP BY account_id
       ) t ON t.account_id = a.id
      ORDER BY a.archived_at NULLS FIRST, a.sort_order, a.id`,
  );
}

async function createAccount(ctx: Ctx): Promise<Account | null> {
  const { body } = ctx;
  return one<Account>(
    `INSERT INTO accounts (name, kind, opening_balance, color, sort_order)
     VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(sort_order) + 1 FROM accounts), 0))
     RETURNING *, opening_balance AS balance`,
    [
      str(body['name'], 'שם החשבון', { max: 80 }),
      oneOf(body['kind'], 'סוג', ACCOUNT_KINDS, 'bank'),
      optionalNum(body['opening_balance'], 'יתרת פתיחה') ?? 0,
      optionalStr(body['color'], 'צבע', 20),
    ],
  );
}

// ── Categories ───────────────────────────────────────────────────────────

async function listCategories(): Promise<Category[]> {
  return query<Category>(
    `SELECT c.*, g.name AS group_name
       FROM categories c
       LEFT JOIN category_groups g ON g.id = c.group_id
      ORDER BY g.sort_order NULLS LAST, g.id NULLS LAST, c.sort_order, c.id`,
  );
}

// ── The budget ───────────────────────────────────────────────────────────

/**
 * Everything the budget screen needs for one month, in three queries.
 *
 * All three reach back through history rather than filtering to the month,
 * because `available` is a running total (see buildBudgetMonth). Reading only
 * the month would produce a screen that is right in January and wrong in every
 * month after it.
 */
async function getBudget(ctx: Ctx) {
  const month = monthKey(ctx.query['month'] || new Date());
  const [categories, allocations, spends] = await Promise.all([
    listCategories(),
    query<{ month: string; category_id: number; allocated: number }>(
      `SELECT to_char(month, 'YYYY-MM-DD') AS month, category_id, allocated
         FROM budget_allocations WHERE month <= $1::date`,
      [month],
    ),
    query<{ month: string; category_id: number | null; amount: number }>(
      `SELECT to_char(date_trunc('month', occurred_on), 'YYYY-MM-DD') AS month,
              category_id,
              SUM(amount)::numeric AS amount
         FROM transactions
        WHERE deleted_at IS NULL
          AND transfer_id IS NULL
          AND occurred_on < ($1::date + INTERVAL '1 month')
        GROUP BY 1, 2`,
      [month],
    ),
  ]);
  return buildBudgetMonth({ month, categories, allocations, spends });
}

/** Put money in one envelope for one month. Idempotent — it sets, never adds. */
async function setAllocation(ctx: Ctx) {
  const month = monthKey(str(ctx.body['month'], 'חודש', { max: 10 }));
  const categoryId = Number(ctx.params['categoryId']);
  const allocated = num(ctx.body['allocated'], 'סכום', { min: -1_000_000, max: 1_000_000 });
  const row = await one(
    `INSERT INTO budget_allocations (month, category_id, allocated, updated_by, updated_at)
     VALUES ($1::date, $2, $3, $4, NOW())
     ON CONFLICT (month, category_id)
     DO UPDATE SET allocated = EXCLUDED.allocated, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING to_char(month, 'YYYY-MM-DD') AS month, category_id, allocated`,
    [month, categoryId, allocated, ctx.user.email],
  );
  if (!row) throw notFound('הקטגוריה לא נמצאה');
  return row;
}

/**
 * Fills a month from each category's usual target, in one press.
 *
 * Only touches envelopes that have no row yet for that month. Overwriting an
 * allocation somebody typed by hand — because they moved ₪200 into groceries
 * on the 14th — would undo a deliberate decision with a convenience button.
 */
async function autofillMonth(ctx: Ctx) {
  const month = monthKey(str(ctx.body['month'], 'חודש', { max: 10 }));
  const rows = await query(
    `INSERT INTO budget_allocations (month, category_id, allocated, updated_by)
     SELECT $1::date, c.id, c.monthly_target, $2
       FROM categories c
      WHERE c.monthly_target IS NOT NULL
        AND c.archived_at IS NULL
        AND c.kind <> 'income'
     ON CONFLICT (month, category_id) DO NOTHING
     RETURNING category_id, allocated`,
    [month, ctx.user.email],
  );
  return { filled: rows.length, rows };
}

// ── Transactions ─────────────────────────────────────────────────────────

const TX_SELECT = `
  SELECT t.id, to_char(t.occurred_on, 'YYYY-MM-DD') AS occurred_on,
         t.account_id, a.name AS account_name,
         t.category_id, c.name AS category_name,
         t.amount, t.payee, t.note, t.paid_by, t.split, t.transfer_id,
         t.created_by, t.created_at
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
   WHERE t.deleted_at IS NULL`;

async function listTransactions(ctx: Ctx): Promise<Transaction[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const { query: q } = ctx;

  if (q['month']) {
    params.push(monthKey(q['month']));
    clauses.push(`AND t.occurred_on >= $${params.length}::date AND t.occurred_on < ($${params.length}::date + INTERVAL '1 month')`);
  }
  if (q['category_id']) {
    params.push(int(q['category_id'], 'category_id'));
    clauses.push(`AND t.category_id = $${params.length}`);
  }
  if (q['account_id']) {
    params.push(int(q['account_id'], 'account_id'));
    clauses.push(`AND t.account_id = $${params.length}`);
  }
  if (q['search']) {
    params.push(`%${q['search']}%`);
    clauses.push(`AND (t.payee ILIKE $${params.length} OR t.note ILIKE $${params.length})`);
  }
  // Capped, always. An unbounded list is fine for the first year and then one
  // day is four thousand rows over a phone connection.
  const limit = Math.min(Number(q['limit'] ?? 200) || 200, 500);
  params.push(limit);

  return query<Transaction>(
    `${TX_SELECT} ${clauses.join(' ')} ORDER BY t.occurred_on DESC, t.id DESC LIMIT $${params.length}`,
    params,
  );
}

function readTxBody(ctx: Ctx) {
  const { body } = ctx;
  const amount = num(body['amount'], 'סכום', { min: -1_000_000, max: 1_000_000 });
  if (amount === 0) throw badRequest('סכום 0 אינו תנועה');
  return {
    occurred_on: date(body['occurred_on'] ?? new Date().toISOString().slice(0, 10), 'תאריך'),
    account_id: int(body['account_id'], 'חשבון'),
    category_id: optionalInt(body['category_id'], 'קטגוריה'),
    amount,
    payee: optionalStr(body['payee'], 'למי', 120) ?? '',
    note: optionalStr(body['note'], 'הערה', 1000),
    paid_by: optionalStr(body['paid_by'], 'מי שילם', 200) ?? ctx.user.email,
    split: oneOf(body['split'], 'שיוך', SPLITS, 'shared'),
  };
}

async function createTransaction(ctx: Ctx): Promise<Transaction | null> {
  const t = readTxBody(ctx);
  const created = await one<{ id: number }>(
    `INSERT INTO transactions (occurred_on, account_id, category_id, amount, payee, note, paid_by, split, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [t.occurred_on, t.account_id, t.category_id, t.amount, t.payee, t.note, t.paid_by, t.split, ctx.user.email],
  );
  if (!created) throw new Error('insert returned no row');
  return one<Transaction>(`${TX_SELECT} AND t.id = $1`, [created.id]);
}

async function updateTransaction(ctx: Ctx): Promise<Transaction | null> {
  const id = Number(ctx.params['id']);
  const t = readTxBody(ctx);
  const updated = await one<{ id: number }>(
    `UPDATE transactions
        SET occurred_on = $2, account_id = $3, category_id = $4, amount = $5,
            payee = $6, note = $7, paid_by = $8, split = $9, updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id`,
    [id, t.occurred_on, t.account_id, t.category_id, t.amount, t.payee, t.note, t.paid_by, t.split],
  );
  if (!updated) throw notFound('התנועה לא נמצאה');
  return one<Transaction>(`${TX_SELECT} AND t.id = $1`, [id]);
}

async function deleteTransaction(ctx: Ctx) {
  const id = Number(ctx.params['id']);
  // Soft delete: next month, when an envelope does not add up, "מה נמחק כאן"
  // has to have an answer.
  const row = await one(`UPDATE transactions SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id]);
  if (!row) throw notFound('התנועה לא נמצאה');
  return { ok: true, id };
}

/** Money moving between our own accounts: two rows, one `transfer_id`, no category. */
async function createTransfer(ctx: Ctx) {
  const from = int(ctx.body['from_account_id'], 'מחשבון');
  const to = int(ctx.body['to_account_id'], 'לחשבון');
  if (from === to) throw badRequest('אי אפשר להעביר מחשבון לעצמו');
  const amount = num(ctx.body['amount'], 'סכום', { min: 0.01, max: 1_000_000 });
  const on = date(ctx.body['occurred_on'] ?? new Date().toISOString().slice(0, 10), 'תאריך');
  const note = optionalStr(ctx.body['note'], 'הערה', 500);
  const transferId = randomUUID();

  return transaction(async (client) => {
    await client.query(
      `INSERT INTO transactions (occurred_on, account_id, amount, payee, note, transfer_id, created_by, split)
       VALUES ($1, $2, $3, 'העברה', $4, $5, $6, 'personal'),
              ($1, $7, $8, 'העברה', $4, $5, $6, 'personal')`,
      [on, from, -amount, note, transferId, ctx.user.email, to, amount],
    );
    return { ok: true, transfer_id: transferId };
  });
}

// ── Who owes whom ────────────────────────────────────────────────────────

async function getBalance() {
  const [members, spends, settlements] = await Promise.all([
    query<{ email: string; display_name: string }>(
      `SELECT email, COALESCE(display_name, name, split_part(email, '@', 1)) AS display_name
         FROM users WHERE role IN ('owner', 'member') ORDER BY created_at`,
    ),
    query<{ amount: number; paid_by: string | null; split: 'shared' | 'personal' }>(
      `SELECT amount, paid_by, split FROM transactions
        WHERE deleted_at IS NULL AND transfer_id IS NULL AND split = 'shared'`,
    ),
    query<{ from_email: string; to_email: string; amount: number }>(
      `SELECT from_email, to_email, amount FROM settlements`,
    ),
  ]);
  return computeBalance({ members, spends, settlements });
}

async function createSettlement(ctx: Ctx) {
  const from = str(ctx.body['from_email'], 'מי מעביר', { max: 200 }).toLowerCase();
  const to = str(ctx.body['to_email'], 'למי', { max: 200 }).toLowerCase();
  if (from === to) throw badRequest('אי אפשר להחזיר לעצמך');
  return one(
    `INSERT INTO settlements (occurred_on, from_email, to_email, amount, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, to_char(occurred_on, 'YYYY-MM-DD') AS occurred_on, from_email, to_email, amount, note`,
    [
      date(ctx.body['occurred_on'] ?? new Date().toISOString().slice(0, 10), 'תאריך'),
      from, to,
      num(ctx.body['amount'], 'סכום', { min: 0.01, max: 1_000_000 }),
      optionalStr(ctx.body['note'], 'הערה', 500),
      ctx.user.email,
    ],
  );
}

// ── Recurring bills ──────────────────────────────────────────────────────

async function listBills() {
  return query(
    `SELECT b.*, to_char(b.next_due, 'YYYY-MM-DD') AS next_due, c.name AS category_name
       FROM recurring_bills b
       LEFT JOIN categories c ON c.id = b.category_id
      ORDER BY b.active DESC, b.next_due`,
  );
}

function readBillBody(ctx: Ctx) {
  const { body } = ctx;
  return {
    name: str(body['name'], 'שם החשבון', { max: 100 }),
    category_id: optionalInt(body['category_id'], 'קטגוריה'),
    account_id: optionalInt(body['account_id'], 'חשבון'),
    amount_estimate: optionalNum(body['amount_estimate'], 'סכום משוער') ?? 0,
    cadence: oneOf(body['cadence'], 'תדירות', CADENCES, 'monthly'),
    next_due: date(body['next_due'], 'תאריך חיוב הבא'),
    autopay: bool(body['autopay']),
    remind_days: optionalInt(body['remind_days'], 'תזכורת') ?? 3,
    note: optionalStr(body['note'], 'הערה', 500),
    active: bool(body['active'], true),
  };
}

/**
 * Marking a bill paid does two things at once, and both are the point:
 * it writes the actual transaction, and it moves the bill to its next date.
 * Doing only the first leaves the bill overdue forever; only the second loses
 * the money.
 */
async function payBill(ctx: Ctx) {
  const id = Number(ctx.params['id']);
  const bill = await one<{ id: number; name: string; category_id: number | null; account_id: number | null; amount_estimate: number; cadence: string; next_due: string }>(
    `SELECT id, name, category_id, account_id, amount_estimate, cadence, to_char(next_due, 'YYYY-MM-DD') AS next_due
       FROM recurring_bills WHERE id = $1`,
    [id],
  );
  if (!bill) throw notFound('החשבון לא נמצא');

  const amount = optionalNum(ctx.body['amount'], 'סכום') ?? bill.amount_estimate;
  if (!amount) throw badRequest('אין סכום לחיוב — הזינו כמה שולם');
  const accountId = optionalInt(ctx.body['account_id'], 'חשבון') ?? bill.account_id;
  if (!accountId) throw badRequest('אין חשבון לחייב — בחרו חשבון');
  const on = date(ctx.body['occurred_on'] ?? bill.next_due, 'תאריך');

  return transaction(async (client) => {
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO transactions (occurred_on, account_id, category_id, amount, payee, paid_by, recurring_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $6) RETURNING id`,
      [on, accountId, bill.category_id, -Math.abs(amount), bill.name, ctx.user.email, bill.id],
    );
    const nextDue = advanceDue(bill.next_due, bill.cadence);
    await client.query(`UPDATE recurring_bills SET next_due = $2 WHERE id = $1`, [id, nextDue]);
    return { ok: true, transaction_id: rows[0]?.id ?? null, next_due: nextDue };
  });
}

// ── Routes ───────────────────────────────────────────────────────────────

export default router([
  { method: 'GET', path: 'accounts', role: 'viewer', handle: listAccounts },
  { method: 'POST', path: 'accounts', handle: createAccount },
  {
    method: 'PATCH', path: 'accounts/:id',
    handle: async (ctx) => {
      const row = await one<Account>(
        `UPDATE accounts SET name = COALESCE($2, name), kind = COALESCE($3, kind),
                opening_balance = COALESCE($4, opening_balance), color = COALESCE($5, color),
                archived_at = CASE WHEN $6::boolean IS TRUE THEN NOW() WHEN $6::boolean IS FALSE THEN NULL ELSE archived_at END
          WHERE id = $1 RETURNING *, opening_balance AS balance`,
        [
          Number(ctx.params['id']),
          optionalStr(ctx.body['name'], 'שם', 80),
          ctx.body['kind'] ? oneOf(ctx.body['kind'], 'סוג', ACCOUNT_KINDS) : null,
          optionalNum(ctx.body['opening_balance'], 'יתרת פתיחה'),
          optionalStr(ctx.body['color'], 'צבע', 20),
          ctx.body['archived'] === undefined ? null : bool(ctx.body['archived']),
        ],
      );
      if (!row) throw notFound('החשבון לא נמצא');
      return row;
    },
  },

  { method: 'GET', path: 'categories', role: 'viewer', handle: listCategories },
  {
    method: 'POST', path: 'categories',
    handle: async (ctx) => one<Category>(
      `INSERT INTO categories (group_id, name, kind, monthly_target, icon, sort_order)
       VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT MAX(sort_order) + 1 FROM categories WHERE group_id IS NOT DISTINCT FROM $1), 0))
       RETURNING *, (SELECT name FROM category_groups WHERE id = $1) AS group_name`,
      [
        optionalInt(ctx.body['group_id'], 'קבוצה'),
        str(ctx.body['name'], 'שם הקטגוריה', { max: 80 }),
        oneOf(ctx.body['kind'], 'סוג', CATEGORY_KINDS, 'spending'),
        optionalNum(ctx.body['monthly_target'], 'יעד חודשי'),
        optionalStr(ctx.body['icon'], 'אייקון', 20),
      ],
    ),
  },
  {
    method: 'PATCH', path: 'categories/:id',
    handle: async (ctx) => {
      const row = await one<Category>(
        `UPDATE categories
            SET name = COALESCE($2, name), group_id = COALESCE($3, group_id),
                monthly_target = CASE WHEN $4::text = 'clear' THEN NULL ELSE COALESCE($5, monthly_target) END,
                icon = COALESCE($6, icon),
                archived_at = CASE WHEN $7::boolean IS TRUE THEN NOW() WHEN $7::boolean IS FALSE THEN NULL ELSE archived_at END
          WHERE id = $1 RETURNING *, (SELECT name FROM category_groups g WHERE g.id = categories.group_id) AS group_name`,
        [
          Number(ctx.params['id']),
          optionalStr(ctx.body['name'], 'שם', 80),
          optionalInt(ctx.body['group_id'], 'קבוצה'),
          ctx.body['monthly_target'] === null ? 'clear' : '',
          optionalNum(ctx.body['monthly_target'], 'יעד חודשי'),
          optionalStr(ctx.body['icon'], 'אייקון', 20),
          ctx.body['archived'] === undefined ? null : bool(ctx.body['archived']),
        ],
      );
      if (!row) throw notFound('הקטגוריה לא נמצאה');
      return row;
    },
  },
  {
    method: 'POST', path: 'groups',
    handle: async (ctx) => {
      const name = str(ctx.body['name'], 'שם הקבוצה', { max: 80 });
      const row = await one(
        `INSERT INTO category_groups (name, sort_order)
         VALUES ($1, COALESCE((SELECT MAX(sort_order) + 1 FROM category_groups), 0))
         ON CONFLICT (name) DO NOTHING RETURNING *`,
        [name],
      );
      if (!row) throw conflict('כבר יש קבוצה בשם הזה');
      return row;
    },
  },

  { method: 'GET', path: 'budget', role: 'viewer', handle: getBudget },
  { method: 'PUT', path: 'budget/:categoryId', handle: setAllocation },
  { method: 'POST', path: 'budget/autofill', handle: autofillMonth },

  { method: 'GET', path: 'transactions', role: 'viewer', handle: listTransactions },
  { method: 'POST', path: 'transactions', handle: createTransaction },
  { method: 'PATCH', path: 'transactions/:id', handle: updateTransaction },
  { method: 'DELETE', path: 'transactions/:id', handle: deleteTransaction },
  { method: 'POST', path: 'transfers', handle: createTransfer },

  { method: 'GET', path: 'balance', role: 'viewer', handle: getBalance },
  { method: 'POST', path: 'settlements', handle: createSettlement },

  { method: 'GET', path: 'bills', role: 'viewer', handle: listBills },
  {
    method: 'POST', path: 'bills',
    handle: async (ctx) => {
      const b = readBillBody(ctx);
      return one(
        `INSERT INTO recurring_bills (name, category_id, account_id, amount_estimate, cadence, next_due, autopay, remind_days, note, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *, to_char(next_due, 'YYYY-MM-DD') AS next_due`,
        [b.name, b.category_id, b.account_id, b.amount_estimate, b.cadence, b.next_due, b.autopay, b.remind_days, b.note, b.active],
      );
    },
  },
  {
    method: 'PATCH', path: 'bills/:id',
    handle: async (ctx) => {
      const b = readBillBody(ctx);
      const row = await one(
        `UPDATE recurring_bills
            SET name=$2, category_id=$3, account_id=$4, amount_estimate=$5, cadence=$6,
                next_due=$7, autopay=$8, remind_days=$9, note=$10, active=$11
          WHERE id=$1 RETURNING *, to_char(next_due, 'YYYY-MM-DD') AS next_due`,
        [Number(ctx.params['id']), b.name, b.category_id, b.account_id, b.amount_estimate, b.cadence, b.next_due, b.autopay, b.remind_days, b.note, b.active],
      );
      if (!row) throw notFound('החשבון לא נמצא');
      return row;
    },
  },
  {
    method: 'DELETE', path: 'bills/:id',
    handle: async (ctx) => {
      const row = await one(`DELETE FROM recurring_bills WHERE id = $1 RETURNING id`, [Number(ctx.params['id'])]);
      if (!row) throw notFound('החשבון לא נמצא');
      return { ok: true };
    },
  },
  { method: 'POST', path: 'bills/:id/pay', handle: payBill },
]);
