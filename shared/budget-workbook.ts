import type { CategoryKind, Commitment } from './types.js';
import type { CellValue, ReadSheet, WriteCell, WriteSheet } from './xlsx.js';

/**
 * The household's budget workbook — the Excel template the money is managed
 * in, as a shape this app can write and read back.
 *
 * The template is the one israel works from: «שיקוף המצב», «התקציב החודשי»,
 * «תקציב שנתי», «בקרה חודשית», a sheet of the month's card transactions with
 * a «סעיף בבקרה החודשית» column, and «מעקב הוצאות שנתי». Its structure maps
 * almost one to one onto ours, which is why this file can exist at all:
 *
 *     Excel «קטגוריה»                → category_groups.name
 *     Excel «הוצאה» / «מקור הכנסה»   → categories.name
 *     «התקציב החודשי שלי»            → budget_allocations.allocated
 *     «בפועל»                        → Σ transactions for the category
 *     «הפרש»                         → available
 *     «הערות»                        → budget_allocations.note
 *     «קשיחות/גמישות»                → categories.commitment
 *
 * The app stays the source of truth (.council/decisions/0001). Export writes
 * only what the household typed or recorded; every average, running total and
 * closing balance in the file is an Excel formula, so no figure appears that
 * the app invented — the rule docs/PLAN.md was rebuilt around.
 *
 * Import is the other direction and it is additive and repeatable: it creates
 * the groups and lines the file has and the app lacks, sets the month's
 * budget, adds the transactions it has not seen, and never deletes anything
 * the household entered. Running it twice on the same file changes nothing.
 *
 * Pure, like the rest of shared/: the cells come in as data (shared/xlsx.ts
 * reads and writes them) and the database is the caller's business.
 */

export const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

/**
 * The payee of a row that makes the app's month agree with the file's.
 *
 * In the template, «בפועל» is typed by hand. Mostly it is the sum of the
 * transactions sheet for that line, but not always — ₪100 of cosmetics paid in
 * cash, a salary nobody lists as a transaction. Without a row for the
 * difference the month imported would be smaller than the month in the file,
 * by exactly the amount nobody can see. With it, the gap has a name.
 */
export const ADJUSTMENT_PAYEE = 'השלמה מהבקרה החודשית';

export const COMMITMENT_WORDS: Record<Commitment, string> = {
  rigid: 'קשיחה',
  flexible: 'גמישה',
  liquid: 'נזילה',
  unplanned: 'לא צפויה',
};

// ── Small pure helpers ───────────────────────────────────────────────────

const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Gershayim, curly quotes and double spaces are the same name to a person. */
export function normalizeName(value: unknown): string {
  return String(value ?? '')
    .replace(/[״“”„]/g, '"')
    .replace(/[׳‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export const nameKey = (value: unknown) => normalizeName(value).toLowerCase();

const isTotal = (value: unknown) => /^סה"?כ/.test(normalizeName(value));

/** Days since 1899-12-30, the epoch every spreadsheet program agrees on. */
export function dateToSerial(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

export function serialToDate(serial: number): string {
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}

function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

const monthName = (month: string) => MONTHS[Number(month.slice(5, 7)) - 1] ?? month;

/** «ספטמבר 2026 - בפועל» → '2026-09-01'. A month name with no year gives `fallbackYear`. */
export function monthFromText(text: unknown, fallbackYear?: number): string | null {
  const t = normalizeName(text);
  const index = MONTHS.findIndex((name) => t.includes(name));
  if (index < 0) return null;
  const year = /(20\d\d)/.exec(t)?.[1];
  const y = year ? Number(year) : fallbackYear;
  if (!y) return null;
  return `${y}-${String(index + 1).padStart(2, '0')}-01`;
}

// ── Writing ──────────────────────────────────────────────────────────────

/** Index = position in cellXfs in BUDGET_STYLES_XML. */
const S = { plain: 0, header: 1, money: 2, date: 3, title: 4, totalLabel: 5, totalMoney: 6, percent: 7, agorot: 8 } as const;

/**
 * Totals sit under a double rule, as in docs/DESIGN.md — the accountant's one
 * container, and the one place the file carries the app's own look.
 */
export const BUDGET_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="&quot;₪&quot;\\ #,##0"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/><numFmt numFmtId="166" formatCode="#,##0.00"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font><font><b/><sz val="14"/><name val="Arial"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"/><diagonal/></border><border><left/><right/><top style="double"/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export interface WorkbookCategory {
  id: number;
  name: string;
  group_name: string | null;
  kind: CategoryKind;
  commitment: Commitment;
}

export interface WorkbookData {
  /** The month the monthly sheets describe, 'YYYY-MM-01'. The annual sheets cover its calendar year. */
  month: string;
  /** Non-archived, in the order the budget screen shows them. */
  categories: WorkbookCategory[];
  allocations: { month: string; category_id: number; allocated: number; note: string | null }[];
  /**
   * Signed sums per category per month, transfers excluded. A null category is
   * split by direction, so money that arrived unfiled is not netted against
   * money that left unfiled.
   */
  actuals: { month: string; category_id: number | null; incoming: boolean; amount: number }[];
  /** The month's transactions, transfers excluded. */
  transactions: {
    occurred_on: string; payee: string; amount: number; category_name: string | null; account_name: string; note: string | null;
    installment_no?: number | null; installments_total?: number | null; charged_on?: string | null;
  }[];
  /** Every account's balance on the first day of the year. */
  opening_balance: number;
}

interface Line {
  key: string;
  group: string;
  name: string;
  income: boolean;
  categoryId: number | null;
  commitment: Commitment | null;
}

const UNFILED_OUT = 'unfiled-out';
const UNFILED_IN = 'unfiled-in';
/** The export's lines for money with no category. They describe rows, not categories, and never import as one. */
const UNFILED_GROUP = 'לא שויך';
const UNFILED_NAMES = new Set(['ללא סעיף', 'הכנסה ללא סעיף']);

function linesOf(data: WorkbookData): { income: Line[]; expense: Line[] } {
  const income: Line[] = [];
  const expense: Line[] = [];
  for (const c of data.categories) {
    const line: Line = {
      key: String(c.id), group: c.group_name ?? 'ללא קבוצה', name: c.name,
      income: c.kind === 'income', categoryId: c.id, commitment: c.commitment,
    };
    (line.income ? income : expense).push(line);
  }
  // Grouped in order of first appearance, so a group whose categories were
  // created at different times is still one block with one merged label.
  const order = [...new Set(expense.map((l) => l.group))];
  expense.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));

  // Unfiled money is part of the month (see buildBudgetMonth's `unfiled`), so
  // it is a line here rather than a total that does not add up.
  if (data.actuals.some((a) => a.category_id == null && !a.incoming && a.amount !== 0)) {
    expense.push({ key: UNFILED_OUT, group: UNFILED_GROUP, name: 'ללא סעיף', income: false, categoryId: null, commitment: null });
  }
  if (data.actuals.some((a) => a.category_id == null && a.incoming && a.amount !== 0)) {
    income.push({ key: UNFILED_IN, group: 'הכנסות', name: 'הכנסה ללא סעיף', income: true, categoryId: null, commitment: null });
  }
  return { income, expense };
}

/** Actual for a line in a month, the way the template reads it: spending positive. */
function actualOf(data: WorkbookData, line: Line, month: string): number {
  let sum = 0;
  for (const a of data.actuals) {
    if (a.month !== month) continue;
    if (line.categoryId != null ? a.category_id !== line.categoryId : a.category_id != null || a.incoming !== line.income) continue;
    sum += a.amount;
  }
  return cents(line.income ? sum : -sum);
}

function allocationOf(data: WorkbookData, line: Line, month: string) {
  if (line.categoryId == null) return null;
  return data.allocations.find((a) => a.month === month && a.category_id === line.categoryId) ?? null;
}

function sheet(name: string, widths: number[]): WriteSheet {
  return { name, widths, rows: new Map(), merges: [] };
}

function put(s: WriteSheet, col: string, row: number, cell: WriteCell | string | number | null | undefined): void {
  if (cell == null || cell === '') return;
  const normalized: WriteCell = typeof cell === 'object' ? cell : { value: cell };
  let r = s.rows.get(row);
  if (!r) s.rows.set(row, (r = new Map()));
  r.set(col, normalized);
}

/** An actual: nothing happened and ₪0 read the same, so zero stays blank. */
const money = (value: number | null | undefined): WriteCell | null =>
  value == null || value === 0 ? null : { value: cents(value), style: S.money };
/** A budget: a typed ₪0 is a decision («לא החודש») and is written as one. */
const budgeted = (value: number | null | undefined): WriteCell | null =>
  value == null ? null : { value: cents(value), style: S.money };
const f = (formula: string, style: number = S.money): WriteCell => ({ formula, style });
const header = (value: string): WriteCell => ({ value, style: S.header });
const title = (value: string): WriteCell => ({ value, style: S.title });

/** Writes B=group (first row of each group only, merged down) and C=name; returns the next row. */
function groupedRows(s: WriteSheet, lines: Line[], first: number, each: (line: Line, row: number) => void): number {
  let row = first;
  let groupStart = first;
  lines.forEach((line, i) => {
    const prev = lines[i - 1];
    if (!prev || prev.group !== line.group) {
      put(s, 'B', row, line.group);
      groupStart = row;
    }
    put(s, 'C', row, line.name);
    each(line, row);
    const next = lines[i + 1];
    if ((!next || next.group !== line.group) && row > groupStart) s.merges!.push(`B${groupStart}:B${row}`);
    row++;
  });
  return row;
}

const MONTH_COLS = ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O'];

function snapshotSheet(data: WorkbookData, income: Line[], expense: Line[]): WriteSheet {
  const s = sheet('1. שיקוף המצב - מאזן', [2, 22, 30, 12, 12, 12, 14, 14, 14, 24, 2, 2, 24, 14]);
  const months = [addMonths(data.month, -2), addMonths(data.month, -1), data.month];
  put(s, 'B', 2, title('שיקוף תמונת מצב נוכחית – הוצאות והכנסות'));
  put(s, 'B', 3, 'ההוצאות כפי שנרשמו בקאסה בשלושת החודשים האחרונים, כבסיס לקביעת התקציב.');
  ['קטגוריה', 'הוצאה', ...months.map(monthName), 'ממוצע חודשי נוכחי', 'קשיחות/גמישות?', 'הערכה ריאלית לתקציב חודשי', 'הערות']
    .forEach((h, i) => put(s, String.fromCharCode(66 + i), 5, header(h)));

  const end = groupedRows(s, expense, 6, (line, row) => {
    months.forEach((m, i) => put(s, MONTH_COLS[i]!, row, money(actualOf(data, line, m))));
    put(s, 'G', row, f(`IFERROR(AVERAGE(D${row}:F${row}),0)`));
    if (line.commitment) put(s, 'H', row, COMMITMENT_WORDS[line.commitment]);
  });
  put(s, 'B', end, { value: 'סה"כ הוצאות', style: S.totalLabel });
  for (const col of ['D', 'E', 'F', 'G', 'I']) put(s, col, end, f(`SUM(${col}6:${col}${end - 1})`, S.totalMoney));

  put(s, 'M', 6, header('טבלת הכנסות (ממוצע חודשי)'));
  let row = 7;
  for (const line of income) {
    put(s, 'M', row, line.name);
    const values = months.map((m) => actualOf(data, line, m));
    put(s, 'N', row, f(`AVERAGE(${values.join(',')})`));
    row++;
  }
  put(s, 'M', row, { value: 'סה"כ הכנסות', style: S.totalLabel });
  put(s, 'N', row, f(`SUM(N7:N${Math.max(7, row - 1)})`, S.totalMoney));
  const incomeTotal = row;
  row += 2;
  put(s, 'M', row, header('סיכום'));
  put(s, 'M', row + 1, 'הכנסות');
  put(s, 'N', row + 1, f(`N${incomeTotal}`));
  put(s, 'M', row + 2, 'הוצאות');
  put(s, 'N', row + 2, f(`G${end}`));
  put(s, 'M', row + 3, 'יתרה');
  put(s, 'N', row + 3, f(`N${row + 1}-N${row + 2}`));
  return s;
}

function monthlyBudgetSheet(data: WorkbookData, income: Line[], expense: Line[]): WriteSheet {
  const s = sheet('2A.  התקציב החודשי', [2, 22, 30, 14, 26, 22, 2, 2, 22, 14, 12]);
  put(s, 'B', 1, title(`הכנסות חודשיות · ${monthName(data.month)} ${data.month.slice(0, 4)}`));
  ['מקור ההכנסה', 'סכום חודשי', 'הערות'].forEach((h, i) => put(s, String.fromCharCode(67 + i), 2, header(h)));
  let row = 3;
  for (const line of income) {
    const a = allocationOf(data, line, data.month);
    put(s, 'B', row, 'הכנסה');
    put(s, 'C', row, line.name);
    put(s, 'D', row, budgeted(a?.allocated));
    put(s, 'E', row, a?.note);
    row++;
  }
  const incomeTotal = row;
  put(s, 'B', incomeTotal, { value: 'סה"כ הכנסות', style: S.totalLabel });
  put(s, 'D', incomeTotal, f(`SUM(D3:D${Math.max(3, incomeTotal - 1)})`, S.totalMoney));

  const top = Math.max(incomeTotal + 3, 11);
  put(s, 'B', top, title('הוצאות חודשיות'));
  ['קטגוריה', 'הוצאה', 'תקציב חודשי', 'הערות', 'סיווג'].forEach((h, i) => put(s, String.fromCharCode(66 + i), top + 1, header(h)));
  const first = top + 2;
  const end = groupedRows(s, expense, first, (line, r) => {
    const a = allocationOf(data, line, data.month);
    put(s, 'D', r, budgeted(a?.allocated));
    put(s, 'E', r, a?.note);
    put(s, 'F', r, line.group);
  });
  const last = Math.max(first, end - 1);
  put(s, 'B', end, { value: 'סה"כ הוצאות', style: S.totalLabel });
  put(s, 'D', end, f(`SUM(D${first}:D${last})`, S.totalMoney));

  put(s, 'I', 1, title('סיכום תקציב חודשי'));
  put(s, 'I', 2, 'הכנסות');
  put(s, 'J', 2, f(`D${incomeTotal}`));
  put(s, 'I', 3, 'הוצאות');
  put(s, 'J', 3, f(`D${end}`));
  put(s, 'I', 4, 'יתרה (גירעון)');
  put(s, 'J', 4, f('J2-J3'));

  put(s, 'I', top + 1, header('קטגוריה'));
  put(s, 'J', top + 1, header('תקציב חודשי'));
  put(s, 'K', top + 1, header('אחוז (%) מהתקציב'));
  const groups = [...new Set(expense.map((l) => l.group))];
  const sumRow = top + 2 + groups.length;
  groups.forEach((g, i) => {
    const r = top + 2 + i;
    put(s, 'I', r, g);
    put(s, 'J', r, f(`SUMIF($F$${first}:$F$${last},I${r},$D$${first}:$D$${last})`));
    put(s, 'K', r, f(`IFERROR(J${r}/$J$${sumRow},0)`, S.percent));
  });
  put(s, 'I', sumRow, { value: 'סה"כ', style: S.totalLabel });
  put(s, 'J', sumRow, f(`SUM(J${top + 2}:J${Math.max(top + 2, sumRow - 1)})`, S.totalMoney));
  put(s, 'K', sumRow, f(`IFERROR(SUM(K${top + 2}:K${Math.max(top + 2, sumRow - 1)}),0)`, S.percent));
  return s;
}

/**
 * The twelve-month sheet, once for the budget (2B) and once for what happened (4).
 * Cumulative, average and the bank's running balance are Excel's formulas.
 */
function annualSheet(
  name: string,
  heading: string,
  data: WorkbookData,
  income: Line[],
  expense: Line[],
  valueOf: (line: Line, month: string) => number | null,
  cell: (value: number | null) => WriteCell | null = money,
): WriteSheet {
  const s = sheet(name, [2, 22, 30, ...MONTH_COLS.map(() => 11), 12, 12]);
  const year = data.month.slice(0, 4);
  const months = MONTH_COLS.map((_, i) => `${year}-${String(i + 1).padStart(2, '0')}-01`);
  const monthHeaders = (row: number) => {
    months.forEach((m, i) => put(s, MONTH_COLS[i]!, row, header(monthName(m))));
    put(s, 'P', row, header('מצטבר'));
    put(s, 'Q', row, header('ממוצע לחודש'));
  };
  const rowTotals = (row: number) => {
    put(s, 'P', row, f(`SUM(D${row}:O${row})`));
    put(s, 'Q', row, f(`IFERROR(AVERAGE(D${row}:O${row}),0)`));
  };
  const columnTotals = (row: number, from: number, label: string, labelCol = 'B') => {
    put(s, labelCol, row, { value: label, style: S.totalLabel });
    for (const col of [...MONTH_COLS, 'P']) put(s, col, row, f(`SUM(${col}${from}:${col}${Math.max(from, row - 1)})`, S.totalMoney));
    put(s, 'Q', row, f(`IFERROR(SUM(Q${from}:Q${Math.max(from, row - 1)}),0)`, S.totalMoney));
  };

  put(s, 'B', 2, title(`${heading} ${year}`));
  s.merges!.push('B2:O2');
  put(s, 'B', 4, header('הכנסות'));
  put(s, 'B', 6, header('פירוט הכנסות'));
  monthHeaders(6);
  let row = 8;
  for (const line of income) {
    put(s, 'B', row, line.name);
    months.forEach((m, i) => put(s, MONTH_COLS[i]!, row, cell(valueOf(line, m))));
    rowTotals(row);
    row++;
  }
  const incomeTotal = row;
  columnTotals(incomeTotal, 8, 'סה"כ');

  const top = incomeTotal + 3;
  put(s, 'B', top, header('הוצאות שוטפות'));
  put(s, 'C', top + 2, header('פירוט הוצאות'));
  monthHeaders(top + 2);
  const first = top + 3;
  const end = groupedRows(s, expense, first, (line, r) => {
    months.forEach((m, i) => put(s, MONTH_COLS[i]!, r, cell(valueOf(line, m))));
    rowTotals(r);
  });
  columnTotals(end, first, 'סה"כ הוצאות');

  const bank = end + 3;
  put(s, 'B', bank, 'יתרה בבנק (יתרת פתיחה)');
  put(s, 'D', bank, { value: cents(data.opening_balance), style: S.money });
  months.forEach((m, i) => put(s, MONTH_COLS[i]!, bank + 2, header(monthName(m))));
  put(s, 'B', bank + 3, 'סה"כ הכנסות');
  put(s, 'B', bank + 4, 'סה"כ הוצאות');
  put(s, 'B', bank + 5, 'יתרה');
  put(s, 'B', bank + 7, { value: 'יתרת סגירה בסוף החודש', style: S.totalLabel });
  MONTH_COLS.forEach((col, i) => {
    if (i > 0) put(s, col, bank, f(`${MONTH_COLS[i - 1]}${bank + 7}`));
    put(s, col, bank + 3, f(`${col}${incomeTotal}`));
    put(s, col, bank + 4, f(`${col}${end}`));
    put(s, col, bank + 5, f(`${col}${bank + 3}-${col}${bank + 4}`));
    put(s, col, bank + 7, f(`${col}${bank}+${col}${bank + 5}`, S.totalMoney));
  });
  const yearly = bank + 10;
  put(s, 'B', yearly, 'סה"כ הכנסה שנתית');
  put(s, 'D', yearly, f(`SUM(D${bank + 3}:O${bank + 3})`));
  put(s, 'B', yearly + 1, 'סה"כ הוצאה שנתית');
  put(s, 'D', yearly + 1, f(`SUM(D${bank + 4}:O${bank + 4})`));
  put(s, 'B', yearly + 2, { value: 'יתרה', style: S.totalLabel });
  put(s, 'D', yearly + 2, f(`D${yearly}-D${yearly + 1}`, S.totalMoney));
  return s;
}

function controlSheet(data: WorkbookData, income: Line[], expense: Line[]): WriteSheet {
  // The trailing space is the template's own, and the importer finds this
  // sheet by its headers anyway — kept so the tab reads the same in both files.
  const s = sheet('3. בקרה חודשית ', [2, 22, 30, 16, 20, 12, 30]);
  const actualHeader = `${monthName(data.month)} ${data.month.slice(0, 4)} - בפועל`;
  put(s, 'B', 2, title('בקרה ומעקב אחר הוצאות (והכנסות)'));
  put(s, 'B', 3, 'ההוצאות וההכנסות כפי שנרשמו בקאסה החודש, מול התקציב החודשי שהגדרתם.');
  put(s, 'B', 5, header('הכנסות'));
  ['פירוט הכנסות', '', 'התקציב החודשי שלי', actualHeader, 'הפרש', 'הערות']
    .forEach((h, i) => h && put(s, String.fromCharCode(66 + i), 7, header(h)));

  let row = 9;
  for (const line of income) {
    const a = allocationOf(data, line, data.month);
    put(s, 'B', row, line.name);
    put(s, 'D', row, budgeted(a?.allocated));
    put(s, 'E', row, money(actualOf(data, line, data.month)));
    // Income reads the other way round: more than planned is the good side.
    put(s, 'F', row, f(`E${row}-D${row}`));
    put(s, 'G', row, a?.note);
    row++;
  }
  const incomeTotal = row;
  put(s, 'B', incomeTotal, { value: 'סה"כ', style: S.totalLabel });
  for (const col of ['D', 'E', 'F']) put(s, col, incomeTotal, f(`SUM(${col}9:${col}${Math.max(9, incomeTotal - 1)})`, S.totalMoney));

  const top = incomeTotal + 3;
  put(s, 'B', top, header('הוצאות שוטפות'));
  ['פירוט הוצאות', 'התקציב החודשי שלי', actualHeader, 'הפרש', 'הערות']
    .forEach((h, i) => put(s, String.fromCharCode(67 + i), top + 2, header(h)));
  const first = top + 3;
  const end = groupedRows(s, expense, first, (line, r) => {
    const a = allocationOf(data, line, data.month);
    put(s, 'D', r, budgeted(a?.allocated));
    put(s, 'E', r, money(actualOf(data, line, data.month)));
    put(s, 'F', r, f(`D${r}-E${r}`));
    put(s, 'G', r, a?.note);
  });
  put(s, 'B', end, { value: 'סה"כ הוצאות', style: S.totalLabel });
  for (const col of ['D', 'E', 'F']) put(s, col, end, f(`SUM(${col}${first}:${col}${Math.max(first, end - 1)})`, S.totalMoney));

  const sum = end + 3;
  put(s, 'D', sum, header('התקציב החודשי שלי'));
  put(s, 'E', sum, header('החודש הנוכחי - בפועל'));
  put(s, 'F', sum, header('הפרש'));
  put(s, 'B', sum + 1, 'סה"כ הכנסות');
  put(s, 'B', sum + 2, 'סה"כ הוצאות');
  put(s, 'B', sum + 3, { value: 'יתרה', style: S.totalLabel });
  for (const col of ['D', 'E']) {
    put(s, col, sum + 1, f(`${col}${incomeTotal}`));
    put(s, col, sum + 2, f(`${col}${end}`));
    put(s, col, sum + 3, f(`${col}${sum + 1}-${col}${sum + 2}`, S.totalMoney));
  }
  put(s, 'F', sum + 3, f(`E${sum + 3}-D${sum + 3}`, S.totalMoney));
  return s;
}

const TX_HEADERS = ['תאריך עסקה', 'שם בית העסק', 'קטגוריה (חברת האשראי)', 'סוג עסקה', 'סכום חיוב (₪)', 'תאריך חיוב', 'הערות', 'לשונית מקור', 'סעיף בבקרה החודשית'];

function transactionsSheet(data: WorkbookData): WriteSheet {
  const s = sheet(`עסקאות ${monthName(data.month)}`, [12, 30, 18, 12, 14, 12, 30, 16, 28]);
  put(s, 'A', 1, title(`עסקאות – ${monthName(data.month)} ${data.month.slice(0, 4)}`));
  put(s, 'A', 2, 'כל התנועות שנרשמו בקאסה בחודש, בלי העברות בין חשבונות. סכום חיובי הוא הוצאה. «לשונית מקור» היא החשבון.');
  TX_HEADERS.forEach((h, i) => put(s, String.fromCharCode(65 + i), 4, header(h)));
  const rows = [...data.transactions].sort((a, b) => a.occurred_on.localeCompare(b.occurred_on));
  let row = 5;
  for (const t of rows) {
    put(s, 'A', row, { value: dateToSerial(t.occurred_on), style: S.date });
    put(s, 'B', row, t.payee);
    // The template's sign: a charge is positive. Ours is the other way round,
    // and this is the one place the two meet on the way out.
    put(s, 'E', row, { value: cents(-t.amount), style: S.agorot });
    if (t.installment_no && t.installments_total) {
      put(s, 'D', row, 'תשלומים');
      // The words the card statement uses, so the note reads back the same.
      const words = `תשלום ${t.installment_no} מתוך ${t.installments_total}`;
      put(s, 'G', row, t.note?.includes(words) ? t.note : [words, t.note].filter(Boolean).join(' · '));
    } else {
      put(s, 'G', row, t.note);
    }
    if (t.charged_on) put(s, 'F', row, { value: dateToSerial(t.charged_on), style: S.date });
    put(s, 'H', row, t.account_name);
    put(s, 'I', row, t.category_name);
    row++;
  }
  put(s, 'A', row, { value: 'סה"כ', style: S.totalLabel });
  put(s, 'E', row, f(`SUM(E5:E${Math.max(5, row - 1)})`, S.totalMoney));
  return s;
}

/** The six sheets, in the template's order. */
export function buildBudgetWorkbook(data: WorkbookData): WriteSheet[] {
  const { income, expense } = linesOf(data);
  return [
    snapshotSheet(data, income, expense),
    monthlyBudgetSheet(data, income, expense),
    annualSheet('2B. תקציב שנתי', 'תקציב שנתי', data, income, expense,
      (line, m) => allocationOf(data, line, m)?.allocated ?? null, budgeted),
    controlSheet(data, income, expense),
    transactionsSheet(data),
    annualSheet('4. מעקב הוצאות שנתי', 'בקרה ומעקב אחר הוצאות (והכנסות)', data, income, expense,
      (line, m) => actualOf(data, line, m)),
  ];
}

export function workbookFilename(month: string): string {
  return `casa-budget-${month.slice(0, 7)}.xlsx`;
}

// ── Reading ──────────────────────────────────────────────────────────────

export interface ParsedLine {
  section: 'income' | 'expense';
  group: string | null;
  name: string;
  budget: number | null;
  actual: number | null;
  note: string | null;
  commitment: Commitment | null;
}

export interface ParsedTransaction {
  date: string;
  payee: string;
  /** In the app's sign: negative is money out. */
  amount: number;
  line: string | null;
  note: string | null;
  installment_no?: number | null;
  installments_total?: number | null;
  /** The card's billing date, when the sheet has one. */
  charged_on?: string | null;
}

/** «תשלום 2 מתוך 3», «2/3», «תשלום 2 מ-3» → [2, 3]. */
export function installmentOf(text: unknown): [number, number] | null {
  const t = normalizeName(text);
  const m = /(\d+)\s*(?:מתוך|מ-|\/)\s*(\d+)/.exec(t);
  if (!m) return null;
  const no = Number(m[1]);
  const total = Number(m[2]);
  if (!(no >= 1 && total >= 2 && no <= total && total <= 120)) return null;
  // «2/3» alone could be a date. Without the word, only trust it when the row
  // already says it is an installment (the caller passes the type column too).
  return [no, total];
}

/** One line of a twelve-month sheet: a value per calendar month, January first. */
export interface ParsedYearLine {
  section: 'income' | 'expense';
  group: string | null;
  name: string;
  months: (number | null)[];
}

/**
 * «2B. תקציב שנתי» or «4. מעקב הוצאות שנתי». Which one it is decides whether
 * its figures become allocations or «בפועל» for months other than the file's.
 */
export interface ParsedYear {
  sheet: string;
  role: 'budget' | 'actual';
  lines: ParsedYearLine[];
}

export interface ParsedBudget {
  month: string | null;
  lines: ParsedLine[];
  transactions: ParsedTransaction[];
  /** The annual sheets, for the months around the one the file is about. */
  years?: ParsedYear[];
  /** Which sheets were read, by name — said back to the person before anything is written. */
  sources: string[];
  warnings: string[];
}

interface Grid {
  get(col: number, row: number): CellValue;
  text(col: number, row: number): string;
  maxRow: number;
  maxCol: number;
}

function gridOf(s: ReadSheet): Grid {
  const byRow = new Map<number, Map<number, CellValue>>();
  let maxRow = 0;
  let maxCol = 0;
  for (const [ref, value] of s.cells) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m) continue;
    let col = 0;
    for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
    col -= 1;
    const row = Number(m[2]);
    let r = byRow.get(row);
    if (!r) byRow.set(row, (r = new Map()));
    r.set(col, value);
    maxRow = Math.max(maxRow, row);
    maxCol = Math.max(maxCol, col);
  }
  const get = (col: number, row: number) => byRow.get(row)?.get(col) ?? null;
  return { get, text: (col, row) => normalizeName(get(col, row) ?? ''), maxRow, maxCol };
}

function findCol(g: Grid, row: number, test: (text: string) => boolean): number {
  for (let c = 0; c <= g.maxCol; c++) if (test(g.text(c, row))) return c;
  return -1;
}

function numberOf(value: CellValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? cents(value) : null;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[₪,\s]/g, '').replace(/[−–]/g, '-');
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? cents(n) : null;
  }
  return null;
}

function dateOf(value: CellValue): string | null {
  if (typeof value === 'number' && value > 20000 && value < 80000) return serialToDate(value);
  if (typeof value !== 'string') return null;
  const t = value.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  // Israeli order: day first.
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(t);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${y}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  }
  return null;
}

function commitmentOf(text: string): Commitment | null {
  if (text.includes('קשיח')) return 'rigid';
  if (text.includes('נזיל')) return 'liquid';
  if (text.includes('גמיש')) return 'flexible';
  if (text.includes('צפוי') || text.includes('בלת')) return 'unplanned';
  return null;
}

const BUDGET_HEADER = 'התקציב החודשי שלי';

/**
 * Reads the month back out of the household's file.
 *
 * Everything is located by the words in a header row, never by a cell
 * address: the template as israel uses it already has rows the original did
 * not (מסי שמירה, כלי עבודה), and the next household's will have others. A
 * sheet that has no recognisable header is skipped and named in `warnings`,
 * rather than read at the wrong offset.
 */
export function parseBudgetWorkbook(sheets: ReadSheet[]): ParsedBudget {
  const out: ParsedBudget = { month: null, lines: [], transactions: [], years: [], sources: [], warnings: [] };
  const grids = sheets.map((s) => ({ name: s.name, g: gridOf(s) }));

  // «בקרה חודשית»: the budget and the actuals, side by side.
  const control = grids
    .filter(({ g }) => {
      for (let r = 1; r <= g.maxRow; r++) if (findCol(g, r, (t) => t === BUDGET_HEADER) >= 0 && findCol(g, r, (t) => t.startsWith('פירוט')) >= 0) return true;
      return false;
    })
    .sort((a, b) => Number(b.name.includes('בקרה')) - Number(a.name.includes('בקרה')))[0];

  if (control) {
    out.sources.push(control.name.trim());
    const { g } = control;
    for (let r = 1; r <= g.maxRow; r++) {
      const budgetCol = findCol(g, r, (t) => t === BUDGET_HEADER);
      const labelCol = findCol(g, r, (t) => t.startsWith('פירוט'));
      if (budgetCol < 0 || labelCol < 0) continue;
      const section = g.text(labelCol, r).includes('הכנס') ? 'income' : 'expense';
      const actualCol = findCol(g, r, (t) => t.includes('בפועל'));
      const noteCol = findCol(g, r, (t) => t === 'הערות');
      if (actualCol >= 0 && !out.month) out.month = monthFromText(g.text(actualCol, r));

      const groupCol = section === 'expense' && labelCol > 0 ? labelCol - 1 : -1;
      let group: string | null = null;
      for (let row = r + 1; row <= g.maxRow; row++) {
        const label = g.text(labelCol, row);
        const groupText = groupCol >= 0 ? g.text(groupCol, row) : '';
        if (isTotal(label) || isTotal(groupText)) break;
        // A new header row means the table ended without a total line.
        if (findCol(g, row, (t) => t === BUDGET_HEADER) >= 0) break;
        if (groupText) group = groupText;
        // Income in the template sits in a merged B:C, so the name may be in
        // either; an expense row's name is always in its own column.
        const name = label || (section === 'income' ? g.text(labelCol + 1, row) : '');
        if (!name) continue;
        const note = noteCol >= 0 ? g.text(noteCol, row) : '';
        out.lines.push({
          section,
          group: section === 'income' ? null : group,
          name,
          budget: numberOf(g.get(budgetCol, row)),
          actual: actualCol >= 0 ? numberOf(g.get(actualCol, row)) : null,
          note: note || null,
          commitment: null,
        });
      }
    }
  } else {
    out.warnings.push('לא נמצא גיליון «בקרה חודשית» עם העמודה «התקציב החודשי שלי». ייובאו רק עסקאות.');
  }

  // «שיקוף המצב» carries the one thing «בקרה» does not: which lines are rigid.
  for (const { g } of grids) {
    for (let r = 1; r <= Math.min(g.maxRow, 20); r++) {
      const ladderCol = findCol(g, r, (t) => t.includes('קשיחות'));
      const nameCol = findCol(g, r, (t) => t === 'הוצאה');
      if (ladderCol < 0 || nameCol < 0) continue;
      for (let row = r + 1; row <= g.maxRow; row++) {
        const commitment = commitmentOf(g.text(ladderCol, row));
        if (!commitment) continue;
        const key = nameKey(g.get(nameCol, row));
        for (const line of out.lines) if (line.section === 'expense' && nameKey(line.name) === key) line.commitment = commitment;
      }
    }
  }

  // «התקציב החודשי» (2A): the same budget as «בקרה», as a plain list. It only
  // fills what «בקרה» left empty — the control sheet is the live one, and the
  // template's own instructions say to copy 2A into it.
  for (const { name, g } of grids) {
    if (control && name === control.name) continue;
    for (let r = 1; r <= Math.min(g.maxRow, 40); r++) {
      const budgetCol = findCol(g, r, (t) => t === 'תקציב חודשי' || t === 'סכום חודשי');
      const nameCol = findCol(g, r, (t) => t === 'הוצאה' || t === 'מקור ההכנסה');
      if (budgetCol < 0 || nameCol < 0 || budgetCol < nameCol) continue;
      const section = g.text(nameCol, r) === 'מקור ההכנסה' ? 'income' : 'expense';
      const groupCol = section === 'expense' ? findCol(g, r, (t) => t === 'קטגוריה') : -1;
      let group: string | null = null;
      let used = false;
      for (let row = r + 1; row <= g.maxRow; row++) {
        const label = g.text(nameCol, row);
        const groupText = groupCol >= 0 ? g.text(groupCol, row) : '';
        if (isTotal(label) || isTotal(groupText) || isTotal(g.text(nameCol - 1, row))) break;
        if (groupText) group = groupText;
        const budget = numberOf(g.get(budgetCol, row));
        if (!label || budget == null || budget === 0) continue;
        const key = nameKey(label);
        const known = out.lines.find((l) => l.section === section && nameKey(l.name) === key);
        if (known) {
          if (known.budget == null) { known.budget = budget; used = true; }
          continue;
        }
        out.lines.push({ section, group: section === 'income' ? null : group, name: label, budget, actual: null, note: null, commitment: null });
        used = true;
      }
      if (used && !out.sources.includes(name.trim())) out.sources.push(name.trim());
    }
  }

  // The twelve-month sheets: any table whose header names the months.
  for (const { name, g } of grids) {
    if (control && name === control.name) continue;
    const lines: ParsedYearLine[] = [];
    for (let r = 1; r <= g.maxRow; r++) {
      const labelCol = findCol(g, r, (t) => t.startsWith('פירוט'));
      if (labelCol < 0) continue;
      const monthCols = MONTHS.map((m) => findCol(g, r, (t) => t === m));
      if (monthCols.filter((c) => c >= 0).length < 6) continue;
      const section = g.text(labelCol, r).includes('הכנס') ? 'income' : 'expense';
      const groupCol = section === 'expense' && labelCol > 0 ? labelCol - 1 : -1;
      let group: string | null = null;
      for (let row = r + 1; row <= g.maxRow; row++) {
        const label = g.text(labelCol, row);
        const groupText = groupCol >= 0 ? g.text(groupCol, row) : '';
        if (isTotal(label) || isTotal(groupText)) break;
        if (findCol(g, row, (t) => t.startsWith('פירוט')) >= 0) break;
        if (groupText) group = groupText;
        if (!label) continue;
        const months = monthCols.map((c) => (c >= 0 ? numberOf(g.get(c, row)) : null));
        if (!months.some((v) => v != null && v !== 0)) continue;
        lines.push({ section, group: section === 'income' ? null : group, name: label, months });
      }
    }
    if (!lines.length) continue;
    out.years!.push({ sheet: name.trim(), role: name.includes('מעקב') || name.includes('בפועל') ? 'actual' : 'budget', lines });
    out.sources.push(name.trim());
  }

  // The template asks for the rung in «שיקוף המצב» and nowhere else, and that
  // sheet is the one most often left empty. Saying so is the difference
  // between «everything is flexible» and «nobody has said yet».
  if (out.lines.some((l) => l.section === 'expense') && !out.lines.some((l) => l.commitment)) {
    out.warnings.push('בקובץ אין סיווג קשיחות/גמישות (בגיליון «שיקוף המצב» העמודה ריקה). סעיפים חדשים ייכנסו כגמישים, ואפשר לסווג אותם במסך התקציב תחת «לסווג את הסעיפים».');
  }

  // Transaction sheets: a header row with an amount and a «סעיף» column.
  for (const { name, g } of grids) {
    if (control && name === control.name) continue;
    for (let r = 1; r <= Math.min(g.maxRow, 30); r++) {
      const lineCol = findCol(g, r, (t) => t.includes('סעיף'));
      const amountCol = findCol(g, r, (t) => t.includes('סכום'));
      const payeeCol = findCol(g, r, (t) => t.includes('בית העסק') || t.includes('בית עסק'));
      if (lineCol < 0 || amountCol < 0 || payeeCol < 0) continue;
      let dateCol = findCol(g, r, (t) => t.includes('תאריך עסקה'));
      if (dateCol < 0) dateCol = findCol(g, r, (t) => t.startsWith('תאריך'));
      const noteCol = findCol(g, r, (t) => t === 'הערות');
      const typeCol = findCol(g, r, (t) => t.includes('סוג עסקה'));
      const chargedCol = findCol(g, r, (t) => t.includes('תאריך חיוב'));

      out.sources.push(name.trim());
      if (!out.month) {
        for (let tr = 1; tr < r && !out.month; tr++) out.month = monthFromText(g.text(0, tr));
      }

      let skipped = 0;
      for (let row = r + 1; row <= g.maxRow; row++) {
        if (isTotal(g.text(0, row)) || isTotal(g.text(payeeCol, row))) break;
        const amount = numberOf(g.get(amountCol, row));
        const payee = g.text(payeeCol, row);
        const date = dateCol >= 0 ? dateOf(g.get(dateCol, row)) : null;
        if (amount == null || amount === 0) continue;
        if (!date) { skipped++; continue; }
        const note = noteCol >= 0 ? g.text(noteCol, row) : '';
        const line = g.text(lineCol, row);
        const type = typeCol >= 0 ? g.text(typeCol, row) : '';
        const installment = /תשלום/.test(note) || type.includes('תשלומים') ? installmentOf(note) : null;
        out.transactions.push({
          date, payee, amount: -amount, line: line || null, note: note || null,
          installment_no: installment?.[0] ?? null,
          installments_total: installment?.[1] ?? null,
          charged_on: chargedCol >= 0 ? dateOf(g.get(chargedCol, row)) : null,
        });
      }
      if (skipped) out.warnings.push(`בגיליון «${name.trim()}» ${skipped} שורות בלי תאריך שאפשר לקרוא — דולגו.`);
      break;
    }
  }

  // A month the file never names is the month most of its transactions fall in.
  if (!out.month && out.transactions.length) {
    const counts = new Map<string, number>();
    for (const t of out.transactions) counts.set(t.date.slice(0, 7), (counts.get(t.date.slice(0, 7)) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) out.month = `${top[0]}-01`;
  }

  // A «תקציב שנתי» filled in with what was spent is common enough to check:
  // the file's own month says which it is. If that column agrees with
  // «בפועל» in «בקרה» rather than with the budget, the sheet is read as
  // what happened, and the person is told.
  if (out.month) {
    const i = Number(out.month.slice(5, 7)) - 1;
    for (const year of out.years!) {
      if (year.role !== 'budget') continue;
      let asBudget = 0;
      let asActual = 0;
      for (const yl of year.lines) {
        const v = yl.months[i];
        if (v == null || v === 0) continue;
        const l = out.lines.find((x) => x.section === yl.section && nameKey(x.name) === nameKey(yl.name));
        if (!l) continue;
        if (l.budget != null && cents(l.budget) === cents(v)) asBudget++;
        if (l.actual != null && cents(l.actual) === cents(v)) asActual++;
      }
      if (asActual > asBudget && asActual >= 2) {
        year.role = 'actual';
        out.warnings.push(`בגיליון «${year.sheet}» עמודת ${MONTHS[i]} זהה ל«בפועל» ולא לתקציב, אז הגיליון נקרא כמה שהוצא בפועל בכל חודש.`);
      }
    }
  }
  return out;
}

// ── Planning an import ───────────────────────────────────────────────────

export interface ExistingCategory {
  id: number;
  name: string;
  group_name: string | null;
  kind: CategoryKind;
  commitment: Commitment;
}

export interface ExistingTransaction {
  id: number;
  occurred_on: string;
  amount: number;
  payee: string;
  category_id: number | null;
}

/** An existing category by id, or one this import creates, by its index in `newCategories`. */
export type CategoryRef = { id: number } | { new: number };

export interface ImportPlan {
  month: string;
  newGroups: string[];
  newCategories: { name: string; group: string; kind: CategoryKind; commitment: Commitment }[];
  commitments: { id: number; commitment: Commitment }[];
  allocations: { category: CategoryRef; name: string; allocated: number; note: string | null }[];
  unchangedAllocations: number;
  transactions: {
    category: CategoryRef | null; occurred_on: string; amount: number; payee: string; note: string | null;
    installment_no: number | null; installments_total: number | null; charged_on: string | null;
  }[];
  duplicates: number;
  /** Rows with no «סעיף» of their own, filed by an earlier decision about the same payee. */
  byPayee: number;
  /** One per line whose «בפועל» differs from its transactions. Replaces any earlier one. */
  adjustments: { category: CategoryRef; name: string; amount: number }[];
  /** Earlier adjustment rows that no longer match the file, to soft-delete. */
  retire: number[];
  /** «סעיף» values on transactions that match no line and no category; those rows import unfiled. */
  unmatched: string[];
  /** The other months of the year, from the annual sheets. */
  months: MonthPlan[];
  warnings: string[];
}

/**
 * A month the file speaks about only through its annual sheets: a budget
 * (2B) and/or a «בפועל» (4) per line, with no transactions behind it. The
 * budget becomes allocations; «בפועל» becomes one gap row per line against
 * whatever that month already has recorded — the same rule as the file's own
 * month, so importing a year twice changes nothing the second time.
 */
export interface MonthPlan {
  month: string;
  allocations: { category: CategoryRef; name: string; allocated: number }[];
  unchangedAllocations: number;
  adjustments: { category: CategoryRef; name: string; amount: number }[];
  retire: number[];
}

const txKey = (date: string, amount: number, payee: string) => `${date}|${cents(amount).toFixed(2)}|${nameKey(payee)}`;
const isSavingGroup = (group: string) => /חיסכון|חסכון/.test(group);

/**
 * What importing `parsed` into this household would do, without doing it.
 *
 * The same function answers the preview and drives the write, so the summary a
 * person agrees to is the import that runs — there is no second
 * implementation to drift from it.
 */
export function planImport(params: {
  parsed: ParsedBudget;
  month: string;
  categories: ExistingCategory[];
  /** Every group, including ones with no category left in them. */
  groups: string[];
  allocations: { category_id: number; allocated: number; note: string | null }[];
  transactions: ExistingTransaction[];
  /** payee_rules: which category this household filed each payee under. */
  rules?: { payee_key: string; category_id: number }[];
  /** The rest of the file's year, for the annual sheets: allocations and rows by month. */
  history?: { allocations: { month: string; category_id: number; allocated: number }[]; transactions: ExistingTransaction[] };
}): ImportPlan {
  const { parsed, month, categories, groups, allocations, transactions } = params;
  const rules = new Map((params.rules ?? []).map((r) => [r.payee_key, r.category_id]));
  const live = new Set(categories.map((c) => c.id));
  const plan: ImportPlan = {
    month, newGroups: [], newCategories: [], commitments: [], allocations: [], unchangedAllocations: 0,
    transactions: [], duplicates: 0, byPayee: 0, adjustments: [], retire: [], unmatched: [], months: [], warnings: [...parsed.warnings],
  };
  const monthEnd = addMonths(month, 1);
  const inMonth = (d: string) => d >= month && d < monthEnd;

  const existingGroups = new Set(groups.map(nameKey));
  const newByKey = new Map<string, number>();

  // A line resolves to a category of the same direction, preferring the same
  // group: «חשמל» under «דיור» in the file is our «חשמל» even when we filed
  // it under «קבועות», but if both exist the group decides.
  const resolve = (line: ParsedLine, loose = false): CategoryRef => {
    const income = line.section === 'income';
    const group = income ? 'הכנסות' : line.group ?? 'שונות';
    const key = nameKey(line.name);
    const candidates = categories.filter((c) => nameKey(c.name) === key && (c.kind === 'income') === income);
    const match = candidates.find((c) => nameKey(c.group_name) === nameKey(group)) ?? candidates[0];
    if (match) {
      if (line.commitment && line.commitment !== match.commitment && !plan.commitments.some((c) => c.id === match.id)) {
        plan.commitments.push({ id: match.id, commitment: line.commitment });
      }
      return { id: match.id };
    }
    const newKey = `${income ? 'in' : 'out'}|${nameKey(group)}|${key}`;
    // The annual sheets (`loose`) get the same rule for a category this import
    // is creating: they often file «מזון» under another group than «בקרה»
    // does, and that is still one line, not two. Within «בקרה» itself two
    // groups may each have their own «אחר».
    const existing = newByKey.get(newKey) ?? (loose ? newByKey.get(`${income ? 'in' : 'out'}|*|${key}`) : undefined);
    if (existing != null) return { new: existing };
    if (!existingGroups.has(nameKey(group)) && !plan.newGroups.some((g) => nameKey(g) === nameKey(group))) {
      plan.newGroups.push(group);
    }
    plan.newCategories.push({
      name: line.name,
      group,
      kind: income ? 'income' : isSavingGroup(group) ? 'saving' : 'spending',
      commitment: line.commitment ?? (/לא צפוי/.test(group) ? 'unplanned' : 'flexible'),
    });
    newByKey.set(newKey, plan.newCategories.length - 1);
    if (!newByKey.has(`${income ? 'in' : 'out'}|*|${key}`)) newByKey.set(`${income ? 'in' : 'out'}|*|${key}`, plan.newCategories.length - 1);
    return { new: plan.newCategories.length - 1 };
  };

  const lineRefs = parsed.lines
    .filter((line) => !(UNFILED_NAMES.has(normalizeName(line.name)) && (line.section === 'income' || line.group === UNFILED_GROUP)))
    .map((line) => ({ line, ref: resolve(line) }));

  for (const { line, ref } of lineRefs) {
    if (line.budget == null) continue;
    const current = 'id' in ref ? allocations.find((a) => a.category_id === ref.id) : undefined;
    if (current && cents(current.allocated) === line.budget && (line.note == null || current.note === line.note)) {
      plan.unchangedAllocations++;
      continue;
    }
    plan.allocations.push({ category: ref, name: line.name, allocated: line.budget, note: line.note ?? current?.note ?? null });
  }

  // Transactions: matched to a line by «סעיף», then to any category by name.
  const byLine = new Map(lineRefs.map(({ line, ref }) => [nameKey(line.name), ref]));
  const byCategory = new Map<string, CategoryRef>();
  for (const c of categories) if (!byCategory.has(nameKey(c.name))) byCategory.set(nameKey(c.name), { id: c.id });

  const seen = new Map<string, number>();
  for (const t of transactions) {
    if (t.payee === ADJUSTMENT_PAYEE) continue;
    const k = txKey(t.occurred_on, t.amount, t.payee);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }

  const fileSums = new Map<string, number>();
  for (const t of parsed.transactions) {
    // An adjustment row in the file is one this app wrote on export. It is
    // part of «בפועל», not a purchase, and the gap below reproduces it.
    if (normalizeName(t.payee) === ADJUSTMENT_PAYEE) continue;
    const lineKey = t.line ? nameKey(t.line) : null;
    let ref = lineKey ? byLine.get(lineKey) ?? byCategory.get(lineKey) ?? null : null;
    let ruled = false;
    if (!ref) {
      const learned = rules.get(nameKey(t.payee));
      if (learned != null && live.has(learned)) { ref = { id: learned }; ruled = true; }
    }
    if (lineKey && !ref && !plan.unmatched.includes(t.line!)) plan.unmatched.push(t.line!);
    if (lineKey && byLine.has(lineKey)) fileSums.set(lineKey, cents((fileSums.get(lineKey) ?? 0) + t.amount));

    // The template counts an installment in the month it was charged, and so
    // does the sheet it came from: a date outside the month moves to its first
    // day, and the real date stays in the note.
    const occurred_on = inMonth(t.date) ? t.date : month;
    const note = occurred_on === t.date ? t.note : [`עסקה מ-${t.date}`, t.note].filter(Boolean).join(' · ');

    const k = txKey(occurred_on, t.amount, t.payee);
    const have = seen.get(k) ?? 0;
    if (have > 0) {
      seen.set(k, have - 1);
      plan.duplicates++;
      continue;
    }
    if (ruled) plan.byPayee++;
    plan.transactions.push({
      category: ref, occurred_on, amount: t.amount, payee: t.payee || 'ללא שם', note,
      installment_no: t.installment_no ?? null,
      installments_total: t.installment_no ? t.installments_total ?? null : null,
      charged_on: t.charged_on ?? null,
    });
  }

  // The gap between «בפועל» and the line's transactions, as one row per line.
  const earlier = transactions.filter((t) => t.payee === ADJUSTMENT_PAYEE && inMonth(t.occurred_on));
  const kept = new Set<number>();
  for (const { line, ref } of lineRefs) {
    if (line.actual == null) continue;
    const income = line.section === 'income';
    const recorded = fileSums.get(nameKey(line.name)) ?? 0;
    const gap = cents((income ? line.actual : -line.actual) - recorded);
    if (gap === 0) continue;
    const match = 'id' in ref
      ? earlier.find((t) => t.category_id === ref.id && cents(t.amount) === gap && !kept.has(t.id))
      : undefined;
    if (match) { kept.add(match.id); continue; }
    plan.adjustments.push({ category: ref, name: line.name, amount: gap });
  }
  // Only lines this file speaks about: a line it has no «בפועל» for keeps
  // whatever an earlier import left there.
  const spokenFor = new Set(
    lineRefs.filter(({ line }) => line.actual != null).flatMap(({ ref }) => ('id' in ref ? [ref.id] : [])),
  );
  for (const t of earlier) {
    if (!kept.has(t.id) && t.category_id != null && spokenFor.has(t.category_id)) plan.retire.push(t.id);
  }

  planYear(plan, parsed, month, resolve, params.history);
  return plan;
}

function planYear(
  plan: ImportPlan,
  parsed: ParsedBudget,
  month: string,
  resolve: (line: ParsedLine, loose?: boolean) => CategoryRef,
  history: { allocations: { month: string; category_id: number; allocated: number }[]; transactions: ExistingTransaction[] } = { allocations: [], transactions: [] },
): void {
  const year = month.slice(0, 4);
  const byMonth = new Map<string, MonthPlan>();
  const monthPlan = (m: string) => {
    let mp = byMonth.get(m);
    if (!mp) byMonth.set(m, (mp = { month: m, allocations: [], unchangedAllocations: 0, adjustments: [], retire: [] }));
    return mp;
  };
  const refKey = (ref: CategoryRef) => ('id' in ref ? `id${ref.id}` : `new${ref.new}`);
  // Each (month, line) once per role: two budget sheets naming the same line
  // agree or the later one wins, rather than allocating it twice.
  const budgets = new Map<string, { m: string; ref: CategoryRef; name: string; value: number }>();
  const actuals = new Map<string, { m: string; ref: CategoryRef; name: string; value: number; income: boolean }>();

  for (const sheet of parsed.years ?? []) {
    for (const yl of sheet.lines) {
      if (UNFILED_NAMES.has(normalizeName(yl.name)) && (yl.section === 'income' || yl.group === UNFILED_GROUP)) continue;
      let ref: CategoryRef | null = null;
      yl.months.forEach((value, i) => {
        if (value == null || value === 0) return;
        const m = `${year}-${String(i + 1).padStart(2, '0')}-01`;
        // The file's own month comes from «בקרה» and the transactions, which
        // are richer than a single figure. And «בפועל» after that month has
        // not happened yet; a number there is a forecast, not a record.
        if (m === month) return;
        if (sheet.role === 'actual' && m > month) return;
        ref ??= resolve({ section: yl.section, group: yl.group, name: yl.name, budget: null, actual: null, note: null, commitment: null }, true);
        const k = `${m}|${refKey(ref)}`;
        if (sheet.role === 'budget') budgets.set(k, { m, ref, name: yl.name, value: cents(value) });
        else actuals.set(k, { m, ref, name: yl.name, value: cents(value), income: yl.section === 'income' });
      });
    }
  }

  for (const b of budgets.values()) {
    const mp = monthPlan(b.m);
    const current = 'id' in b.ref ? history.allocations.find((a) => a.month === b.m && a.category_id === (b.ref as { id: number }).id) : undefined;
    if (current && cents(current.allocated) === b.value) { mp.unchangedAllocations++; continue; }
    mp.allocations.push({ category: b.ref, name: b.name, allocated: b.value });
  }

  const inMonth = (d: string, m: string) => d >= m && d < addMonths(m, 1);
  const kept = new Set<number>();
  for (const a of actuals.values()) {
    const mp = monthPlan(a.m);
    const id = 'id' in a.ref ? a.ref.id : null;
    const rows = id == null ? [] : history.transactions.filter((t) => t.category_id === id && inMonth(t.occurred_on, a.m));
    const recorded = cents(rows.filter((t) => t.payee !== ADJUSTMENT_PAYEE).reduce((s, t) => s + t.amount, 0));
    const gap = cents((a.income ? a.value : -a.value) - recorded);
    const earlier = rows.filter((t) => t.payee === ADJUSTMENT_PAYEE);
    const match = earlier.find((t) => cents(t.amount) === gap && !kept.has(t.id));
    if (match) kept.add(match.id);
    for (const t of earlier) if (t !== match && !kept.has(t.id)) mp.retire.push(t.id);
    if (gap !== 0 && !match) mp.adjustments.push({ category: a.ref, name: a.name, amount: gap });
  }

  plan.months = [...byMonth.values()]
    .filter((mp) => mp.allocations.length || mp.unchangedAllocations || mp.adjustments.length || mp.retire.length)
    .sort((x, y) => x.month.localeCompare(y.month));
}

export interface ImportSummary {
  month: string;
  account_name: string | null;
  new_groups: string[];
  new_categories: { name: string; group: string; kind: CategoryKind }[];
  commitments: number;
  allocations: number;
  unchanged_allocations: number;
  transactions: number;
  transactions_total: number;
  duplicates: number;
  by_payee: number;
  installments: number;
  adjustments: { name: string; amount: number }[];
  retire: number;
  unmatched: string[];
  /** Per other month of the year: what the annual sheets change there. */
  months: { month: string; allocations: number; unchanged_allocations: number; adjustments: number; spent: number; income: number; retire: number }[];
  warnings: string[];
  applied: boolean;
}

/** What a person reads before agreeing: names and counts, never ids. */
export function summarizePlan(plan: ImportPlan, accountName: string | null, applied = false): ImportSummary {
  return {
    month: plan.month,
    account_name: accountName,
    new_groups: plan.newGroups,
    new_categories: plan.newCategories.map((c) => ({ name: c.name, group: c.group, kind: c.kind })),
    commitments: plan.commitments.length,
    allocations: plan.allocations.length,
    unchanged_allocations: plan.unchangedAllocations,
    transactions: plan.transactions.length,
    transactions_total: cents(plan.transactions.reduce((s, t) => s + t.amount, 0)),
    duplicates: plan.duplicates,
    by_payee: plan.byPayee,
    installments: plan.transactions.filter((t) => t.installment_no).length,
    adjustments: plan.adjustments.map((a) => ({ name: a.name, amount: a.amount })),
    retire: plan.retire.length,
    unmatched: plan.unmatched,
    months: plan.months.map((m) => ({
      month: m.month,
      allocations: m.allocations.length,
      unchanged_allocations: m.unchangedAllocations,
      adjustments: m.adjustments.length,
      // Split by direction: a month's gap rows are spends and income together,
      // and their net would be a figure that appears in no column of the file.
      spent: cents(m.adjustments.filter((a) => a.amount < 0).reduce((s, a) => s - a.amount, 0)),
      income: cents(m.adjustments.filter((a) => a.amount > 0).reduce((s, a) => s + a.amount, 0)),
      retire: m.retire.length,
    })),
    warnings: plan.warnings,
    applied,
  };
}
