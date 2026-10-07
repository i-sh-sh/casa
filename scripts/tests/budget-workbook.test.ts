import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { colLetter, readXlsx, unzip, writeXlsx, zip, type WriteCell, type WriteSheet } from '../../shared/xlsx.ts';
import {
  ADJUSTMENT_PAYEE, BUDGET_STYLES_XML, buildBudgetWorkbook, dateToSerial, monthFromText, parseBudgetWorkbook, planImport,
  type ExistingCategory, type ExistingTransaction, type ImportPlan, type ParsedBudget, type WorkbookData,
} from '../../shared/budget-workbook.ts';

// The household manages its month in an Excel template, and asked for the app
// to read and write that exact file. These tests hold the two promises that
// make that safe: the file the app writes reads back as the same month, and
// importing the same file twice changes nothing the second time.

const sheetOf = (name: string, rows: (string | number | null)[][], firstRow = 1): WriteSheet => {
  const s: WriteSheet = { name, rows: new Map() };
  rows.forEach((cells, i) => {
    const row = new Map<string, WriteCell>();
    cells.forEach((v, c) => { if (v !== null && v !== '') row.set(colLetter(c), { value: v }); });
    s.rows.set(firstRow + i, row);
  });
  return s;
};

const read = async (sheets: WriteSheet[]) => readXlsx(writeXlsx(sheets, BUDGET_STYLES_XML));

/** A deflated zip, the way Excel and LibreOffice actually write one. */
function deflatedZip(name: string, content: string): Uint8Array {
  const stored = zip([{ name, data: new TextEncoder().encode(content) }]);
  const raw = new TextEncoder().encode(content);
  const packed = deflateRawSync(raw);
  const nameBytes = new TextEncoder().encode(name);
  const view = new DataView(stored.buffer);
  const crc = view.getUint32(14, true);
  const local = new Uint8Array(30 + nameBytes.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, 8, true); lv.setUint32(14, crc, true);
  lv.setUint32(18, packed.length, true); lv.setUint32(22, raw.length, true); lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 8, true); cv.setUint32(16, crc, true);
  cv.setUint32(20, packed.length, true); cv.setUint32(24, raw.length, true); cv.setUint16(28, nameBytes.length, true);
  central.set(nameBytes, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true); ev.setUint32(16, local.length + packed.length, true);
  const out = new Uint8Array(local.length + packed.length + central.length + end.length);
  out.set(local, 0); out.set(packed, local.length); out.set(central, local.length + packed.length);
  out.set(end, local.length + packed.length + central.length);
  return out;
}

test('a deflated entry is inflated, not returned as noise', async () => {
  const text = 'שכירות,ארנונה,חשמל '.repeat(50);
  const files = await unzip(deflatedZip('a.txt', text));
  assert.equal(new TextDecoder().decode(files.get('a.txt')), text);
});

test('cells survive a write and a read: Hebrew, numbers, and text that looks like a formula', async () => {
  const [sheet] = await read([sheetOf('גיליון', [['רמי לוי', 158.26], ['=cmd|calc', -40]])]);
  assert.equal(sheet!.name, 'גיליון');
  assert.equal(sheet!.cells.get('A1'), 'רמי לוי');
  assert.equal(sheet!.cells.get('B1'), 158.26);
  // Written as inline text, so Excel shows it and never evaluates it.
  assert.equal(sheet!.cells.get('A2'), '=cmd|calc');
  assert.equal(sheet!.cells.get('B2'), -40);
});

test('the month is read from the «בפועל» header, in Hebrew', () => {
  assert.equal(monthFromText('ספטמבר 2026 - בפועל'), '2026-09-01');
  assert.equal(monthFromText('עסקאות כרטיס אשראי – ינואר 2027'), '2027-01-01');
  assert.equal(monthFromText('בפועל'), null);
});

/**
 * The template as israel fills it in: income names in B, the group label in B
 * only on its first row, a «בפועל» header that names the month, rows the
 * original template did not have, and a card sheet whose «סעיף» column ties
 * each purchase to a line.
 */
function householdFile(): WriteSheet[] {
  const control = sheetOf('3. בקרה חודשית ', [
    [null, 'בקרה ומעקב אחר הוצאות (והכנסות)'],
    [],
    [null, 'הכנסות'],
    [],
    [null, 'פירוט הכנסות', null, 'התקציב החודשי שלי', 'ספטמבר 2026 - בפועל', 'הפרש', 'הערות'],
    [],
    [null, 'הכנסה מעבודה 1 ', null, 8000, 8000],
    [null, 'הורים', null, 2000],
    [null, 'סה"כ', null, 10000, 8000],
    [],
    [null, 'הוצאות שוטפות'],
    [],
    [null, null, 'פירוט הוצאות', 'התקציב החודשי שלי', 'ספטמבר 2026 - בפועל', 'הפרש', 'הערות'],
    [null, 'דיור', 'שכירות', 3000],
    [null, null, 'מסי שמירה', 250],
    [null, 'מכולת ומוצרי פארם', 'מזון', 1500, 223.26, null, 'בלי מסעדות'],
    [null, 'תקשורת', 'מכשירי תקשורת (תשלומים)', null, 211.33],
    [null, 'ביגוד וטיפוח', 'קוסמטיקה', 100, 100],
    [null, 'סה״כ הוצאות', null, 4850, 534.59],
  ], 3);
  const card = sheetOf('עסקאות ספטמבר', [
    ['עסקאות כרטיס אשראי – ספטמבר 2026'],
    [],
    [],
    ['תאריך עסקה', 'שם בית העסק', 'קטגוריה (חברת האשראי)', 'סוג עסקה', 'סכום חיוב (₪)', 'תאריך חיוב', 'הערות', 'לשונית מקור', 'סעיף בבקרה החודשית'],
    [46279, 'רמי לוי גוש עציון', 'מזון וצריכה', 'רגילה', 158.26, 46310, null, null, 'מזון'],
    [46279, 'רמי לוי גוש עציון', 'מזון וצריכה', 'רגילה', 65, 46310, null, null, 'מזון'],
    [46252, 'סאני תקשורת', 'שירותי תקשורת', 'תשלומים', 211.33, 46310, 'תשלום 2 מתוך 3', null, 'מכשירי תקשורת (תשלומים)'],
    [46280, 'פרחי הארץ', 'שונות', 'רגילה', 40, 46310, null, null, 'פרחים'],
    ['סה"כ', null, null, null, 474.59],
  ]);
  return [control, card];
}

test('the household file is read by its headers, not by cell addresses', async () => {
  const parsed = parseBudgetWorkbook(await read(householdFile()));
  assert.equal(parsed.month, '2026-09-01');
  assert.deepEqual(parsed.sources, ['3. בקרה חודשית', 'עסקאות ספטמבר']);

  const income = parsed.lines.filter((l) => l.section === 'income');
  assert.deepEqual(income.map((l) => [l.name, l.budget, l.actual]), [['הכנסה מעבודה 1', 8000, 8000], ['הורים', 2000, null]]);

  const expense = parsed.lines.filter((l) => l.section === 'expense');
  // The group label sits on the first row only; the rows under it belong to it.
  assert.deepEqual(expense.map((l) => [l.group, l.name]), [
    ['דיור', 'שכירות'], ['דיור', 'מסי שמירה'], ['מכולת ומוצרי פארם', 'מזון'],
    ['תקשורת', 'מכשירי תקשורת (תשלומים)'], ['ביגוד וטיפוח', 'קוסמטיקה'],
  ]);
  assert.equal(expense[2]!.note, 'בלי מסעדות');

  // Spends arrive in the app's sign: negative is money out.
  assert.equal(parsed.transactions.length, 4);
  assert.deepEqual(parsed.transactions[0], {
    date: '2026-09-14', payee: 'רמי לוי גוש עציון', amount: -158.26, line: 'מזון', note: null,
    installment_no: null, installments_total: null, charged_on: '2026-10-15',
  });
});

test('an import into an empty home creates the structure, the budget and the month', async () => {
  const parsed = parseBudgetWorkbook(await read(householdFile()));
  const plan = planImport({ parsed, month: '2026-09-01', categories: [], groups: [], allocations: [], transactions: [] });

  assert.deepEqual(plan.newGroups, ['הכנסות', 'דיור', 'מכולת ומוצרי פארם', 'תקשורת', 'ביגוד וטיפוח']);
  assert.equal(plan.newCategories.length, 7);
  assert.equal(plan.newCategories[0]!.kind, 'income');
  assert.equal(plan.allocations.length, 6, 'a line with no budget typed does not get a zero');
  assert.equal(plan.transactions.length, 4);

  // The installment charged this cycle was bought in August. It counts in the
  // month whose sheet it is on, and its real date is kept.
  const installment = plan.transactions.find((t) => t.payee === 'סאני תקשורת')!;
  assert.equal(installment.occurred_on, '2026-09-01');
  assert.match(installment.note!, /עסקה מ-2026-08-18/);
  assert.match(installment.note!, /תשלום 2 מתוך 3/);

  // «פרחים» is no line in the file and no category here: the row is kept,
  // unfiled, and named so it can be filed by hand.
  assert.deepEqual(plan.unmatched, ['פרחים']);
  assert.equal(plan.transactions.find((t) => t.payee === 'פרחי הארץ')!.category, null);

  // «בפועל» for food equals its two purchases, so no gap. Cosmetics and the
  // salary have no transaction at all: the gap becomes one named row each.
  assert.deepEqual(plan.adjustments.map((a) => [a.name, a.amount]), [['הכנסה מעבודה 1', 8000], ['קוסמטיקה', -100]]);
});

/** What the household looks like after `plan` ran — the second import's starting point. */
function applied(plan: ImportPlan, before: { categories: ExistingCategory[]; transactions: ExistingTransaction[] }) {
  let id = 1000;
  const newIds = plan.newCategories.map(() => ++id);
  const categories: ExistingCategory[] = [
    ...before.categories,
    ...plan.newCategories.map((c, i) => ({ id: newIds[i]!, name: c.name, group_name: c.group, kind: c.kind, commitment: c.commitment })),
  ];
  const idOf = (ref: { id: number } | { new: number }) => ('id' in ref ? ref.id : newIds[ref.new]!);
  const transactions: ExistingTransaction[] = [
    ...before.transactions.filter((t) => !plan.retire.includes(t.id)),
    ...plan.transactions.map((t) => ({ id: ++id, occurred_on: t.occurred_on, amount: t.amount, payee: t.payee, category_id: t.category ? idOf(t.category) : null })),
    ...plan.adjustments.map((a) => ({ id: ++id, occurred_on: plan.month, amount: a.amount, payee: ADJUSTMENT_PAYEE, category_id: idOf(a.category) })),
  ];
  const allocations = plan.allocations.map((a) => ({ category_id: idOf(a.category), allocated: a.allocated, note: a.note }));
  return { categories, groups: categories.map((c) => c.group_name ?? ''), transactions, allocations };
}

test('importing the same file twice changes nothing the second time', async () => {
  const parsed = parseBudgetWorkbook(await read(householdFile()));
  const first = planImport({ parsed, month: '2026-09-01', categories: [], groups: [], allocations: [], transactions: [] });
  const state = applied(first, { categories: [], transactions: [] });
  const second = planImport({ parsed, month: '2026-09-01', ...state });

  assert.deepEqual(second.newCategories, []);
  assert.deepEqual(second.newGroups, []);
  assert.deepEqual(second.allocations, []);
  assert.equal(second.unchangedAllocations, 6);
  assert.deepEqual(second.transactions, []);
  assert.equal(second.duplicates, 4);
  assert.deepEqual(second.adjustments, []);
  assert.deepEqual(second.retire, []);
});

test('two identical purchases on one day are two purchases', () => {
  // Deduplication counts: a file with the coffee twice, against a month that
  // has it once, adds exactly one.
  const coffee = { date: '2026-09-03', payee: 'קפה נטו', amount: -18, line: null, note: null };
  const parsed: ParsedBudget = { month: '2026-09-01', lines: [], transactions: [coffee, coffee], sources: [], warnings: [] };
  const plan = planImport({
    parsed, month: '2026-09-01', categories: [], groups: [], allocations: [],
    transactions: [{ id: 1, occurred_on: '2026-09-03', amount: -18, payee: 'קפה נטו', category_id: null }],
  });
  assert.equal(plan.duplicates, 1);
  assert.equal(plan.transactions.length, 1);
});

test('a later file that fills in a purchase replaces the earlier gap row, softly', async () => {
  const parsed = parseBudgetWorkbook(await read(householdFile()));
  const first = planImport({ parsed, month: '2026-09-01', categories: [], groups: [], allocations: [], transactions: [] });
  const state = applied(first, { categories: [], transactions: [] });

  // October's israel adds the cosmetics purchase to the card sheet.
  const withPurchase: ParsedBudget = {
    ...parsed,
    transactions: [...parsed.transactions, { date: '2026-09-20', payee: 'סופר פארם', amount: -100, line: 'קוסמטיקה', note: null }],
  };
  const second = planImport({ parsed: withPurchase, month: '2026-09-01', ...state });
  assert.equal(second.transactions.length, 1);
  assert.deepEqual(second.adjustments, []);
  const oldGap = state.transactions.find((t) => t.payee === ADJUSTMENT_PAYEE && t.amount === -100)!;
  assert.deepEqual(second.retire, [oldGap.id]);
});

test('an existing category is matched by name, whatever the file calls its group', async () => {
  const parsed = parseBudgetWorkbook(await read(householdFile()));
  const plan = planImport({
    parsed, month: '2026-09-01',
    categories: [{ id: 7, name: 'שכירות', group_name: 'קבועות', kind: 'spending', commitment: 'rigid' }],
    groups: ['קבועות'], allocations: [], transactions: [],
  });
  assert.ok(!plan.newCategories.some((c) => c.name === 'שכירות'));
  assert.deepEqual(plan.allocations.find((a) => a.name === 'שכירות')!.category, { id: 7 });
});

// ── Export ───────────────────────────────────────────────────────────────

const month: WorkbookData = {
  month: '2026-09-01',
  categories: [
    { id: 1, name: 'משכורת', group_name: 'הכנסות', kind: 'income', commitment: 'rigid' },
    { id: 2, name: 'שכירות', group_name: 'קבועות', kind: 'spending', commitment: 'rigid' },
    { id: 3, name: 'סופר', group_name: 'יומיום', kind: 'spending', commitment: 'flexible' },
    { id: 4, name: 'ארנונה', group_name: 'קבועות', kind: 'spending', commitment: 'rigid' },
  ],
  allocations: [
    { month: '2026-09-01', category_id: 1, allocated: 12000, note: null },
    { month: '2026-09-01', category_id: 2, allocated: 5000, note: 'חוזה עד מרץ' },
    { month: '2026-09-01', category_id: 3, allocated: 2000, note: null },
    { month: '2026-08-01', category_id: 3, allocated: 1800, note: null },
  ],
  actuals: [
    { month: '2026-09-01', category_id: 1, incoming: false, amount: 12000 },
    { month: '2026-09-01', category_id: 2, incoming: false, amount: -5000 },
    { month: '2026-09-01', category_id: 3, incoming: false, amount: -412.5 },
    { month: '2026-09-01', category_id: null, incoming: false, amount: -75 },
    { month: '2026-08-01', category_id: 3, incoming: false, amount: -1700 },
  ],
  transactions: [
    { occurred_on: '2026-09-01', payee: 'מעסיק', amount: 12000, category_name: 'משכורת', account_name: 'עובר ושב', note: null },
    { occurred_on: '2026-09-02', payee: 'בעל הבית', amount: -5000, category_name: 'שכירות', account_name: 'עובר ושב', note: null },
    { occurred_on: '2026-09-05', payee: 'רמי לוי', amount: -400, category_name: 'סופר', account_name: 'אשראי', note: null },
    { occurred_on: '2026-09-06', payee: 'רמי לוי', amount: -12.5, category_name: 'סופר', account_name: 'אשראי', note: null },
    { occurred_on: '2026-09-07', payee: 'קיוסק', amount: -75, category_name: null, account_name: 'מזומן', note: null },
  ],
  opening_balance: 3000,
};

test('the export has the template\'s six sheets, in its order and with its names', () => {
  const names = buildBudgetWorkbook(month).map((s) => s.name);
  assert.deepEqual(names, [
    '1. שיקוף המצב - מאזן', '2A.  התקציב החודשי', '2B. תקציב שנתי',
    '3. בקרה חודשית ', 'עסקאות ספטמבר', '4. מעקב הוצאות שנתי',
  ]);
});

test('every figure the export writes was typed or recorded; the rest are formulas', () => {
  // The rule docs/PLAN.md was rebuilt around: no number on the page that the
  // household did not put there. An average or a running balance in this file
  // is Excel's arithmetic, visible in the cell, not a value the app chose.
  const typed = new Set<number>([12000, 5000, 2000, 1800, 412.5, 75, 1700, 400, 12.5, 3000]);
  for (const t of month.transactions) typed.add(dateToSerial(t.occurred_on));
  for (const sheet of buildBudgetWorkbook(month)) {
    for (const cells of sheet.rows.values()) {
      for (const cell of cells.values()) {
        if (typeof cell.value === 'number') assert.ok(typed.has(Math.abs(cell.value)), `${sheet.name}: ${cell.value} was invented`);
      }
    }
  }
});

test('an exported month imports back as itself — nothing new, nothing changed', async () => {
  const parsed = parseBudgetWorkbook(await read(buildBudgetWorkbook(month)));
  assert.equal(parsed.month, '2026-09-01');

  const transactions = month.transactions.map((t, i) => ({
    id: i + 1, occurred_on: t.occurred_on, amount: t.amount, payee: t.payee,
    category_id: month.categories.find((c) => c.name === t.category_name)?.id ?? null,
  }));
  const plan = planImport({
    parsed,
    month: '2026-09-01',
    categories: month.categories,
    groups: ['הכנסות', 'קבועות', 'יומיום'],
    allocations: month.allocations.filter((a) => a.month === '2026-09-01'),
    transactions,
    // August is in the annual sheets: its budget, and one purchase behind its «בפועל».
    history: {
      allocations: month.allocations,
      transactions: [...transactions, { id: 99, occurred_on: '2026-08-12', amount: -1700, payee: 'רמי לוי', category_id: 3 }],
    },
  });

  assert.deepEqual(plan.allocations, []);
  assert.deepEqual(plan.transactions, []);
  assert.equal(plan.duplicates, 5);
  // Unfiled money is exported as a line of its own so the month adds up. On
  // the way back it is not a line to create: the row it came from is already
  // here, unfiled, and stays that way.
  assert.deepEqual(plan.newCategories, []);
  assert.deepEqual(plan.adjustments, []);
  assert.deepEqual(plan.months.map((m) => [m.month, m.allocations.length, m.unchangedAllocations, m.adjustments.length]), [['2026-08-01', 0, 1, 0]]);
});

// ── The annual sheets ────────────────────────────────────────────────────

const MONTH_HEAD = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

function yearFile(name: string, food: (number | null)[], salary: (number | null)[]): WriteSheet[] {
  return [
    ...householdFile(),
    sheetOf(name, [
      [null, 'פירוט הכנסות', null, ...MONTH_HEAD, 'מצטבר'],
      [null, 'הכנסה מעבודה 1', null, ...salary],
      [null, 'סה"כ'],
      [],
      [null, null, 'פירוט הוצאות', ...MONTH_HEAD, 'מצטבר'],
      [null, 'מכולת', 'מזון', ...food],
      [null, 'סה"כ הוצאות'],
    ]),
  ];
}

test('a year of budget becomes allocations for the other months, once', async () => {
  const parsed = parseBudgetWorkbook(await read(yearFile('2B. תקציב שנתי', [1500, 1500, 1600, null, null, null, null, null, 1700, 1800], [])));
  assert.equal(parsed.years!.length, 1);
  assert.equal(parsed.years![0]!.role, 'budget');

  const first = planImport({ parsed, month: '2026-09-01', categories: [], groups: [], allocations: [], transactions: [] });
  // September is «בקרה»'s; the other five months come from the annual sheet.
  assert.deepEqual(first.months.map((m) => [m.month, m.allocations.map((a) => a.allocated)]), [
    ['2026-01-01', [1500]], ['2026-02-01', [1500]], ['2026-03-01', [1600]], ['2026-10-01', [1800]],
  ]);
  assert.equal(first.newCategories.filter((c) => c.name === 'מזון').length, 1, 'one category, whichever sheet named it first');

  const state = applied(first, { categories: [], transactions: [] });
  const foodId = state.categories.find((c) => c.name === 'מזון')!.id;
  const second = planImport({
    parsed, month: '2026-09-01', ...state,
    history: {
      allocations: first.months.flatMap((m) => m.allocations.map((a) => ({ month: m.month, category_id: foodId, allocated: a.allocated }))),
      transactions: state.transactions,
    },
  });
  assert.deepEqual(second.months.map((m) => [m.month, m.allocations.length, m.unchangedAllocations]), [
    ['2026-01-01', 0, 1], ['2026-02-01', 0, 1], ['2026-03-01', 0, 1], ['2026-10-01', 0, 1],
  ]);
});

test('a year of «בפועל» fills each past month with one gap row per line, and nothing in the future', async () => {
  const parsed = parseBudgetWorkbook(await read(yearFile('4. מעקב הוצאות שנתי', [null, null, null, null, null, null, 1200, 1100, 999, 50], [null, null, null, null, null, null, 8000])));
  assert.equal(parsed.years![0]!.role, 'actual');
  const state = applied(
    planImport({ parsed, month: '2026-09-01', categories: [], groups: [], allocations: [], transactions: [] }),
    { categories: [], transactions: [] },
  );
  const foodId = state.categories.find((c) => c.name === 'מזון')!.id;
  // August already has 1,000 of groceries recorded; the file says 1,100.
  const recorded = { id: 500, occurred_on: '2026-08-14', amount: -1000, payee: 'שופרסל', category_id: foodId };
  const plan = planImport({ parsed, month: '2026-09-01', ...state, history: { allocations: [], transactions: [recorded] } });
  assert.deepEqual(plan.months.map((m) => [m.month, m.adjustments.map((a) => [a.name, a.amount])]), [
    ['2026-07-01', [['הכנסה מעבודה 1', 8000], ['מזון', -1200]]],
    ['2026-08-01', [['מזון', -100]]],
  ]);

  // Once those rows exist, the same file is a no-op; a corrected August replaces its row.
  const after = [recorded, { id: 501, occurred_on: '2026-08-01', amount: -100, payee: ADJUSTMENT_PAYEE, category_id: foodId }];
  const again = planImport({ parsed, month: '2026-09-01', ...state, history: { allocations: [], transactions: after } });
  assert.deepEqual(again.months.find((m) => m.month === '2026-08-01'), undefined);
  const corrected = parseBudgetWorkbook(await read(yearFile('4. מעקב הוצאות שנתי', [null, null, null, null, null, null, null, 1150], [])));
  const fix = planImport({ parsed: corrected, month: '2026-09-01', ...state, history: { allocations: [], transactions: after } });
  assert.deepEqual(fix.months.map((m) => [m.month, m.retire, m.adjustments.map((a) => a.amount)]), [['2026-08-01', [501], [-150]]]);
});

test('a «תקציב שנתי» that holds what was spent is read as what was spent, and says so', async () => {
  // The household's real file: September in 2B is the «בפועל» column of «בקרה».
  const base = householdFile();
  const parsedBase = parseBudgetWorkbook(await read(base));
  const actualOf = (n: string) => parsedBase.lines.find((l) => l.name === n)!.actual!;
  const sept = (v: number) => [null, null, null, null, null, null, null, null, v];
  const parsed = parseBudgetWorkbook(await read([
    ...base,
    sheetOf('2B. תקציב שנתי', [
      [null, null, 'פירוט הוצאות', ...MONTH_HEAD],
      [null, 'מכולת', 'מזון', ...sept(actualOf('מזון'))],
      [null, null, 'קוסמטיקה', ...sept(actualOf('קוסמטיקה'))],
      [null, 'סה"כ הוצאות'],
    ]),
  ]));
  assert.equal(parsed.years![0]!.role, 'actual');
  assert.ok(parsed.warnings.some((w) => w.includes('2B') && w.includes('ספטמבר')));
});

// ── Installments and payee rules ─────────────────────────────────────────

test('an installment is read from the card sheet, with its billing date', async () => {
  const parsed = parseBudgetWorkbook(await read(householdFile()));
  const sunny = parsed.transactions.find((t) => t.payee === 'סאני תקשורת')!;
  assert.equal(sunny.installment_no, 2);
  assert.equal(sunny.installments_total, 3);
  assert.equal(sunny.charged_on, '2026-10-15');
  // An ordinary purchase whose note happens to hold «2/3» is not one.
  assert.equal(parsed.transactions.find((t) => t.payee === 'רמי לוי גוש עציון')!.installment_no, null);
});

test('a row with no «סעיף» is filed where this payee was filed last time', async () => {
  const parsed = parseBudgetWorkbook(await read(householdFile()));
  const plan = planImport({
    parsed, month: '2026-09-01',
    categories: [{ id: 9, name: 'מתנות', group_name: 'אישי', kind: 'spending', commitment: 'liquid' }],
    groups: ['אישי'], allocations: [], transactions: [],
    rules: [{ payee_key: 'פרחי הארץ', category_id: 9 }],
  });
  const flowers = plan.transactions.find((t) => t.payee === 'פרחי הארץ')!;
  assert.deepEqual(flowers.category, { id: 9 });
  assert.equal(plan.byPayee, 1);
  assert.deepEqual(plan.unmatched, [], 'a row the rules filed is not reported as unfiled');
});

test('a rule pointing at an archived category files nothing', async () => {
  const parsed = parseBudgetWorkbook(await read(householdFile()));
  const plan = planImport({
    parsed, month: '2026-09-01', categories: [], groups: [], allocations: [], transactions: [],
    rules: [{ payee_key: 'פרחי הארץ', category_id: 9 }],
  });
  assert.equal(plan.transactions.find((t) => t.payee === 'פרחי הארץ')!.category, null);
});

test('installments go out with «תשלומים» and come back as installments', async () => {
  const data: WorkbookData = {
    ...month,
    transactions: [{ occurred_on: '2026-09-01', payee: 'סאני תקשורת', amount: -211.33, category_name: null, account_name: 'אשראי', note: null, installment_no: 2, installments_total: 3, charged_on: '2026-10-15' }],
  };
  const parsed = parseBudgetWorkbook(await read(buildBudgetWorkbook(data)));
  const t = parsed.transactions[0]!;
  assert.equal(t.installment_no, 2);
  assert.equal(t.installments_total, 3);
  assert.equal(t.charged_on, '2026-10-15');
});
