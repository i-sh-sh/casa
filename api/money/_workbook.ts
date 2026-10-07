import type { Ctx } from '../_lib/router.js';
import { query } from '../_lib/db.js';
import { badRequest } from '../_lib/http.js';
import { date, num, oneOf, optionalDate, optionalInt, optionalStr, str } from '../_lib/validate.js';
import { learnPayee } from './_payees.js';
import { monthKey } from '../../shared/money.js';
import { writeXlsx } from '../../shared/xlsx.js';
import {
  ADJUSTMENT_PAYEE, BUDGET_STYLES_XML, buildBudgetWorkbook, nameKey, planImport, summarizePlan, workbookFilename,
  type ExistingCategory, type ExistingTransaction, type ImportPlan, type ImportSummary, type ParsedBudget, type ParsedLine,
  type WorkbookData,
} from '../../shared/budget-workbook.js';
import type { Commitment } from '../../shared/types.js';

/**
 * The budget workbook — the household's own Excel template, out and back in.
 *
 * The layout and the import rules live in shared/budget-workbook.ts, where the
 * tests can reach them. This file only gathers rows and writes them.
 */

const COMMITMENTS = ['rigid', 'flexible', 'liquid', 'unplanned'] as const;

/**
 * The whole year the month sits in, plus the two months before it — the
 * «שיקוף המצב» sheet looks back three months, and in January two of those are
 * last year.
 */
async function workbookData(month: string): Promise<WorkbookData> {
  const yearStart = `${month.slice(0, 4)}-01-01`;
  const [categories, allocations, actuals, transactions, opening] = await Promise.all([
    query<WorkbookData['categories'][number]>(
      `SELECT c.id, c.name, g.name AS group_name, c.kind, c.commitment
         FROM categories c
         LEFT JOIN category_groups g ON g.id = c.group_id
        WHERE c.archived_at IS NULL
        ORDER BY g.sort_order NULLS LAST, g.id NULLS LAST, c.sort_order, c.id`,
    ),
    query<WorkbookData['allocations'][number]>(
      `SELECT to_char(month, 'YYYY-MM-DD') AS month, category_id, allocated, note
         FROM budget_allocations
        WHERE month >= LEAST($1::date, $2::date - INTERVAL '2 months')
          AND month < ($1::date + INTERVAL '1 year')`,
      [yearStart, month],
    ),
    query<WorkbookData['actuals'][number]>(
      `SELECT to_char(date_trunc('month', occurred_on), 'YYYY-MM-DD') AS month,
              category_id,
              (category_id IS NULL AND amount > 0) AS incoming,
              SUM(amount)::numeric AS amount
         FROM transactions
        WHERE deleted_at IS NULL AND transfer_id IS NULL
          AND occurred_on >= LEAST($1::date, $2::date - INTERVAL '2 months')
          AND occurred_on < ($1::date + INTERVAL '1 year')
        GROUP BY 1, 2, 3`,
      [yearStart, month],
    ),
    query<WorkbookData['transactions'][number]>(
      `SELECT to_char(t.occurred_on, 'YYYY-MM-DD') AS occurred_on, t.payee, t.amount,
              c.name AS category_name, a.name AS account_name, t.note,
              t.installment_no, t.installments_total, to_char(t.charged_on, 'YYYY-MM-DD') AS charged_on
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.deleted_at IS NULL AND t.transfer_id IS NULL
          AND t.occurred_on >= $1::date AND t.occurred_on < ($1::date + INTERVAL '1 month')
        ORDER BY t.occurred_on, t.id`,
      [month],
    ),
    // Every account, as the bank row in the annual sheets is the household's
    // whole position, not one account's.
    query<{ balance: number }>(
      `SELECT (COALESCE((SELECT SUM(opening_balance) FROM accounts), 0)
             + COALESCE((SELECT SUM(amount) FROM transactions
                          WHERE deleted_at IS NULL AND occurred_on < $1::date), 0))::numeric AS balance`,
      [yearStart],
    ),
  ]);
  return { month, categories, allocations, actuals, transactions, opening_balance: opening[0]?.balance ?? 0 };
}

/** The workbook as a download — a plain link, like the CSV exports in settings. */
export async function downloadWorkbook(ctx: Ctx): Promise<void> {
  const month = monthKey(ctx.query['month'] || new Date());
  const bytes = writeXlsx(buildBudgetWorkbook(await workbookData(month)), BUDGET_STYLES_XML);
  ctx.res.status(200);
  ctx.res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  ctx.res.setHeader('content-disposition', `attachment; filename="${workbookFilename(month)}"`);
  ctx.res.setHeader('cache-control', 'no-store, private');
  ctx.res.send(Buffer.from(bytes));
}

// ── Import ───────────────────────────────────────────────────────────────

const MAX_LINES = 500;
const MAX_TRANSACTIONS = 3000;

function amountOrNull(value: unknown, field: string): number | null {
  return value == null || value === '' ? null : num(value, field, { min: -10_000_000, max: 10_000_000 });
}

/**
 * The file was read in the browser; what arrives here is its reading, and it
 * is checked like any other body. Nothing in it is trusted to be the shape the
 * client meant to send.
 */
function readParsed(body: unknown): ParsedBudget {
  if (!body || typeof body !== 'object') throw badRequest('חסר תוכן הקובץ');
  const b = body as Record<string, unknown>;
  const lines = Array.isArray(b['lines']) ? b['lines'] : [];
  const txs = Array.isArray(b['transactions']) ? b['transactions'] : [];
  if (lines.length > MAX_LINES) throw badRequest(`יותר מ-${MAX_LINES} סעיפים בקובץ`);
  if (txs.length > MAX_TRANSACTIONS) throw badRequest(`יותר מ-${MAX_TRANSACTIONS} עסקאות בקובץ`);

  return {
    month: b['month'] ? monthKey(str(b['month'], 'חודש', { max: 10 })) : null,
    lines: lines.map((raw): ParsedLine => {
      const l = (raw ?? {}) as Record<string, unknown>;
      return {
        section: oneOf(l['section'], 'סוג שורה', ['income', 'expense'] as const),
        group: optionalStr(l['group'], 'קטגוריה', 80),
        name: str(l['name'], 'שם סעיף', { max: 80 }),
        budget: amountOrNull(l['budget'], 'תקציב'),
        actual: amountOrNull(l['actual'], 'בפועל'),
        note: optionalStr(l['note'], 'הערה', 500),
        commitment: l['commitment'] ? oneOf(l['commitment'], 'סיווג', COMMITMENTS) as Commitment : null,
      };
    }),
    transactions: txs.map((raw) => {
      const t = (raw ?? {}) as Record<string, unknown>;
      const amount = num(t['amount'], 'סכום', { min: -1_000_000, max: 1_000_000 });
      if (amount === 0) throw badRequest('עסקה בסכום 0');
      const no = optionalInt(t['installment_no'], 'מספר תשלום');
      const total = optionalInt(t['installments_total'], 'מספר תשלומים');
      const installment = no != null && total != null && no >= 1 && total >= 2 && no <= total;
      return {
        date: date(t['date'], 'תאריך'),
        payee: optionalStr(t['payee'], 'בית עסק', 120) ?? '',
        amount,
        line: optionalStr(t['line'], 'סעיף', 80),
        note: optionalStr(t['note'], 'הערה', 1000),
        installment_no: installment ? no : null,
        installments_total: installment ? total : null,
        charged_on: optionalDate(t['charged_on'], 'תאריך חיוב'),
      };
    }),
    sources: [],
    warnings: (Array.isArray(b['warnings']) ? b['warnings'] : []).slice(0, 20).map((w) => String(w).slice(0, 300)),
  };
}

async function planFor(parsed: ParsedBudget, month: string): Promise<ImportPlan> {
  const [categories, groups, allocations, transactions, rules] = await Promise.all([
    query<ExistingCategory>(
      `SELECT c.id, c.name, g.name AS group_name, c.kind, c.commitment
         FROM categories c LEFT JOIN category_groups g ON g.id = c.group_id
        WHERE c.archived_at IS NULL
        ORDER BY c.id`,
    ),
    query<{ name: string }>(`SELECT name FROM category_groups`),
    query<{ category_id: number; allocated: number; note: string | null }>(
      `SELECT category_id, allocated, note FROM budget_allocations WHERE month = $1::date`,
      [month],
    ),
    query<ExistingTransaction>(
      `SELECT id, to_char(occurred_on, 'YYYY-MM-DD') AS occurred_on, amount, payee, category_id
         FROM transactions
        WHERE deleted_at IS NULL AND transfer_id IS NULL
          AND occurred_on >= $1::date AND occurred_on < ($1::date + INTERVAL '1 month')`,
      [month],
    ),
    query<{ payee_key: string; category_id: number }>(`SELECT payee_key, category_id FROM payee_rules`),
  ]);
  return planImport({ parsed, month, categories, groups: groups.map((g) => g.name), allocations, transactions, rules });
}

/**
 * Previews, or applies, a workbook import.
 *
 * One handler for both on purpose: the preview a person agrees to is computed
 * by the same planImport call that then writes, against the same rows, inside
 * the same request transaction. A preview that ran different code would be a
 * promise about an import nobody tested.
 */
export async function importWorkbook(ctx: Ctx): Promise<ImportSummary> {
  const parsed = readParsed(ctx.body['parsed']);
  const monthInput = ctx.body['month'] ?? parsed.month;
  if (!monthInput) throw badRequest('לא מצאתי בקובץ לאיזה חודש הוא שייך. בחרו חודש.');
  const month = monthKey(str(monthInput, 'חודש', { max: 10 }));
  const apply = ctx.body['apply'] === true;

  const accounts = await query<{ id: number; name: string; kind: string }>(
    `SELECT id, name, kind FROM accounts WHERE archived_at IS NULL ORDER BY sort_order, id`,
  );
  const requested = optionalInt(ctx.body['account_id'], 'חשבון');
  // A card statement belongs on a card. Without one, the first account —
  // the same default the add-transaction sheet would offer.
  const account = requested != null
    ? accounts.find((a) => a.id === requested)
    : accounts.find((a) => a.kind === 'credit') ?? accounts[0];
  if (requested != null && !account) throw badRequest('החשבון שנבחר לא נמצא');

  const plan = await planFor(parsed, month);
  const summary = summarizePlan(plan, account?.name ?? null);
  if (!apply) return summary;

  const needsAccount = plan.transactions.length > 0 || plan.adjustments.length > 0;
  if (needsAccount && !account) throw badRequest('אין חשבון לרשום אליו את העסקאות. הוסיפו חשבון בהגדרות.');

  // Groups first, then categories, then everything that points at them.
  for (const name of plan.newGroups) {
    await query(
      `INSERT INTO category_groups (name, sort_order)
       VALUES ($1, COALESCE((SELECT MAX(sort_order) + 1 FROM category_groups), 0))
       ON CONFLICT DO NOTHING`,
      [name],
    );
  }
  const groupIds = new Map(
    (await query<{ id: number; name: string }>(`SELECT id, name FROM category_groups`))
      .map((g) => [nameKey(g.name), g.id]),
  );

  const newIds: number[] = [];
  for (const c of plan.newCategories) {
    const groupId = groupIds.get(nameKey(c.group)) ?? null;
    const inserted = await query<{ id: number }>(
      `INSERT INTO categories (group_id, name, kind, commitment, sort_order)
       VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(sort_order) + 1 FROM categories WHERE group_id IS NOT DISTINCT FROM $1), 0))
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [groupId, c.name, c.kind, c.commitment],
    );
    // The only line that can already exist is an archived one with the same
    // name in the same group. The file names it, so it comes back.
    const id = inserted[0]?.id ?? (await query<{ id: number }>(
      `UPDATE categories SET archived_at = NULL
        WHERE group_id IS NOT DISTINCT FROM $1 AND lower(name) = lower($2)
        RETURNING id`,
      [groupId, c.name],
    ))[0]?.id;
    if (id == null) throw new Error(`could not create category ${c.name}`);
    newIds.push(id);
  }
  const idOf = (ref: { id: number } | { new: number }) => ('id' in ref ? ref.id : newIds[ref.new]!);

  for (const c of plan.commitments) {
    await query(`UPDATE categories SET commitment = $2 WHERE id = $1`, [c.id, c.commitment]);
  }

  for (const a of plan.allocations) {
    await query(
      `INSERT INTO budget_allocations (month, category_id, allocated, note, updated_by, updated_at)
       VALUES ($1::date, $2, $3, $4, $5, NOW())
       ON CONFLICT (month, category_id)
       DO UPDATE SET allocated = EXCLUDED.allocated, note = EXCLUDED.note,
                     updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [month, idOf(a.category), a.allocated, a.note, ctx.user.email],
    );
  }

  for (const t of plan.transactions) {
    const categoryId = t.category ? idOf(t.category) : null;
    await query(
      `INSERT INTO transactions (occurred_on, account_id, category_id, amount, payee, note, paid_by, created_by,
                                 installment_no, installments_total, charged_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10)`,
      [t.occurred_on, account!.id, categoryId, t.amount, t.payee, t.note, ctx.user.email,
        t.installment_no, t.installments_total, t.charged_on],
    );
    // The «סעיף» column of the file is exactly the decision payee_rules
    // remembers — importing it is the cheapest way the rules ever get taught.
    await learnPayee(t.payee, categoryId);
  }

  // Soft delete, as everywhere money lives: an adjustment that a later file
  // replaced still explains what the month looked like before it.
  if (plan.retire.length) {
    await query(`UPDATE transactions SET deleted_at = NOW() WHERE id = ANY($1::int[]) AND deleted_at IS NULL`, [plan.retire]);
  }
  for (const a of plan.adjustments) {
    await query(
      `INSERT INTO transactions (occurred_on, account_id, category_id, amount, payee, note, paid_by, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [month, account!.id, idOf(a.category), a.amount, ADJUSTMENT_PAYEE,
        'ההפרש בין «בפועל» באקסל לעסקאות שבקובץ', ctx.user.email],
    );
  }

  return { ...summary, applied: true };
}
