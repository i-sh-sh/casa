// Reading a supermarket's digital receipt, and deciding what it means here.
//
// Pure: no SQL, no fetch. The server parses with it, the import plans with it,
// and the tests reach every rule without a database.
//
// The parser is deliberately forgiving rather than exact. Each chain formats
// its receipt page its own way and changes it without telling anyone, and the
// person always reviews the lines before anything is written — so a parser
// that reads most lines of an unfamiliar layout is worth more than one that
// reads every line of one layout and nothing of the next.

// No runtime import from another shared module, as everywhere in shared/: the
// tests load these files directly, and a cross-import is one more path for
// the API bundle and the test runner to disagree on.
/** shared/pantry.ts normalizeName, which is what products.name_key holds. */
function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0591-\u05C7]/g, '')
    .replace(/[׳״"'`´’]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface ReceiptLine {
  name: string;
  barcode: string | null;
  qty: number;
  /** What the line cost in all, after its own discounts. */
  total: number | null;
}

export interface ParsedReceipt {
  store: string;
  /** YYYY-MM-DD, or null when the receipt never said. */
  purchased_on: string | null;
  total: number | null;
  lines: ReceiptLine[];
  warnings: string[];
}

const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

/** The name a slip line is remembered by. Two spellings of one item collapse onto it. */
export const itemKey = (name: string) => normalizeName(name);

// ── Store ────────────────────────────────────────────────────────────────

/**
 * The chains a receipt is likely to come from, with the words that give each
 * away. The name stored is the short one people say, so the expense reads
 * «רמי לוי» and not «רמי לוי שיווק השקמה 2011 בע״מ».
 */
const STORES: { name: string; pattern: RegExp }[] = [
  { name: 'רמי לוי', pattern: /רמי\s*לוי|rami[\s-]*levy/i },
  { name: 'אושר עד', pattern: /אושר\s*עד|osher[\s-]*ad/i },
  { name: 'שופרסל', pattern: /שופרסל|shufersal/i },
  { name: 'יוחננוף', pattern: /יוחננוף|yochananof/i },
  { name: 'ויקטורי', pattern: /ויקטורי|victory/i },
  { name: 'יינות ביתן', pattern: /יינות\s*ביתן/ },
  { name: 'טיב טעם', pattern: /טיב\s*טעם/ },
  { name: 'חצי חינם', pattern: /חצי\s*חינם/ },
  { name: 'קרפור', pattern: /קרפור|carrefour/i },
];

export function detectStore(text: string): string {
  return STORES.find((s) => s.pattern.test(text))?.name ?? '';
}

// ── Dates and numbers ────────────────────────────────────────────────────

/** The first plausible purchase date in the text: 18/11/2026, 18.11.26, 2026-11-18. */
export function findDate(text: string): string | null {
  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})/);
  if (iso) return dateOf(+iso[1]!, +iso[2]!, +iso[3]!);
  const local = text.match(/\b(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})\b/);
  if (local) {
    const y = local[3]!.length === 2 ? 2000 + +local[3]! : +local[3]!;
    return dateOf(y, +local[2]!, +local[1]!);
  }
  return null;
}

function dateOf(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const BARCODE = /(?<![\d.])\d{7,14}(?![\d.])/;
const NUMBER = /-?\d{1,6}(?:[.,]\d{1,3})?(?!\d)/g;
const LETTERS = /[א-תa-zA-Z]/;

/** Lines that are about the payment, not about something bought. */
const NOT_AN_ITEM = /בע["״']?מ|שיווק|סה["״']?כ|סך\s*הכל|לתשלום|מע["״']?מ|עודף|אשראי|כרטיס|ויזה|מאסטרקארד|ישראכרט|אמריקן|דיינרס|מזומן|קופה|קופאי|סניף|תאריך|שעה|חשבונית|קבלה|עוסק|ח\.?פ|טלפון|טל[.:]|מספר|כתובת|תודה|נקודות|יתרה|חיסכון|חסכת|ברקוד|כמות|מחיר|תיאור|פריטים|עסקה|אישור|שובר|total|vat|cash|change/i;
/** Lines that reduce the line before them. */
const DISCOUNT = /הנחה|מבצע|זיכוי|discount/i;

const toNumber = (s: string) => Number(s.replace(',', '.'));

// ── Text ─────────────────────────────────────────────────────────────────

/**
 * Reads receipt text — what is copied off the receipt page, or typed.
 *
 * The rule per line: a line with words and at least one amount is an item.
 * Of its numbers, the last is what the line cost; a leading number that
 * multiplies out against a unit price is the quantity. A line with words and
 * no amount is a name whose numbers are on the next line, which is how most
 * receipt pages wrap on a phone.
 */
// ── The receipt page, one card per item ──────────────────────────────────

/** A line that is only an amount: «₪19.47», «19.47 ₪», «-2.00». */
const PRICE_ONLY = /^(?:₪\s*)?(-?\d{1,6}[.,]\d{2})(?:\s*₪)?$/;
/** A line that is only a quantity: «1 יח'», «3.974 ק"ג». */
const QTY_ONLY = /^(\d{1,4}(?:[.,]\d{1,3})?)\s*(?:יח['׳]?|יחידות|ק["״]?ג|קג)\.?$/;
/** Both on one line, in either order. */
const PRICE_QTY = /^(?:₪\s*)?(-?\d{1,6}[.,]\d{2})(?:\s*₪)?\s+(\d{1,4}(?:[.,]\d{1,3})?)\s*(?:יח['׳]?|יחידות|ק["״]?ג|קג)\.?$/;
const QTY_PRICE = /^(\d{1,4}(?:[.,]\d{1,3})?)\s*(?:יח['׳]?|יחידות|ק["״]?ג|קג)\.?\s+(?:₪\s*)?(-?\d{1,6}[.,]\d{2})(?:\s*₪)?$/;
const TOTAL_WORDS = /סה["״']?כ|סך\s*הכל|לתשלום|שולם/;

const clean = (raw: string) => raw.replace(/[\u200e\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Whether this is the receipt page as Rami Levy shows it (and as copying it
 * off a phone produces): each item a small card — its name, its code, then
 * the amount and the quantity, each on a line of their own.
 *
 * On that page the name carries numbers that are not prices («1.5*6 ליטר»,
 * «5 * 100 גרם»), so the line-at-a-time reading would take them for amounts.
 * Here an amount is only ever a line that is nothing but an amount.
 */
export function looksLikeCards(text: string): boolean {
  const ls = text.split(/\r?\n/).map(clean);
  return ls.filter((l) => PRICE_ONLY.test(l) || PRICE_QTY.test(l) || QTY_PRICE.test(l)).length >= 2
    && ls.some((l) => QTY_ONLY.test(l) || PRICE_QTY.test(l) || QTY_PRICE.test(l));
}

export function parseCardText(text: string): ParsedReceipt {
  const lines: ReceiptLine[] = [];
  let total: number | null = null;
  let expectTotal = false;
  let name: string[] = [];
  let barcode: string | null = null;
  let qty: number | null = null;
  let price: number | null = null;
  /** The item just closed, still open to its quantity line. */
  let last: ReceiptLine | null = null;
  let lastHasQty = false;

  const close = () => {
    if (price == null) return;
    if (price < 0 && name.length === 0 && lines.length > 0) {
      // A discount card under the item it belongs to.
      const prev = lines[lines.length - 1]!;
      if (prev.total != null) prev.total = cents(prev.total + price);
    } else if (name.length) {
      last = { name: name.join(' ').slice(0, 120), barcode, qty: round3(qty ?? 1), total: cents(price) };
      lastHasQty = qty != null;
      lines.push(last);
    }
    name = []; barcode = null; qty = null; price = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = clean(raw);
    if (!line) continue;

    let m: RegExpMatchArray | null;
    if ((m = line.match(PRICE_ONLY))) {
      const amount = toNumber(m[1]!);
      if (expectTotal) { total = Math.abs(amount); expectTotal = false; continue; }
      price = amount;
      close();
      continue;
    }
    if ((m = line.match(PRICE_QTY)) || (m = line.match(QTY_PRICE))) {
      const priceFirst = PRICE_QTY.test(line);
      price = toNumber(priceFirst ? m[1]! : m[2]!);
      qty = toNumber(priceFirst ? m[2]! : m[1]!);
      close();
      continue;
    }
    if ((m = line.match(QTY_ONLY))) {
      const n = toNumber(m[1]!);
      // `last` is set inside close(), which the compiler cannot see.
      const prev = last as ReceiptLine | null;
      if (prev && !lastHasQty && name.length === 0) { prev.qty = round3(n); lastHasQty = true; }
      else qty = n;
      continue;
    }
    if (/^\d{1,14}$/.test(line)) {
      // The item's code. Only a full barcode is worth keeping: «300» is the
      // chain's own number for loose produce and matches nothing of ours.
      if (line.length >= 7) barcode = line;
      continue;
    }
    if (TOTAL_WORDS.test(line)) {
      const amounts = numbersIn(line).filter((n) => n > 0);
      if (amounts.length) total = Math.max(...amounts);
      else expectTotal = true;
      name = [];
      continue;
    }
    expectTotal = false;
    const isHeader = STORES.some((st) => st.pattern.test(line) && !LETTERS.test(line.replace(st.pattern, '')));
    if (isHeader || NOT_AN_ITEM.test(line) || DISCOUNT.test(line) && !LETTERS.test(line.replace(DISCOUNT, ''))) {
      name = [];
      continue;
    }
    // A name line. A second one in a row continues a long name; one after a
    // closed item starts the next.
    if (LETTERS.test(line)) {
      const trailing = line.match(/\s(\d{7,14})$/);
      if (trailing) { barcode = trailing[1]!; name.push(line.slice(0, -trailing[0].length)); }
      else name.push(line);
      last = null;
    }
  }

  const warnings: string[] = [];
  if (lines.length === 0) warnings.push('לא מצאתי פריטים בטקסט');
  const declared = text.match(/(\d{1,3})\s*פריטים/);
  if (declared && Number(declared[1]) !== lines.length && lines.length > 0) {
    warnings.push(`בקבלה כתוב ${declared[1]} פריטים ומצאתי ${lines.length}. אולי לא נלחץ «הצגת עוד פריטים»`);
  }
  return { store: detectStore(text), purchased_on: findDate(text), total, lines, warnings };
}

export function parseReceiptText(text: string): ParsedReceipt {
  if (looksLikeCards(text)) return parseCardText(text);
  const warnings: string[] = [];
  const lines: ReceiptLine[] = [];
  let total: number | null = null;
  let pendingName: string | null = null;
  let pendingBarcode: string | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[₪‎‏‪-‮]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;

    if (/סה["״']?כ\s*(?:ל)?תשלום|לתשלום|סך\s*הכל\s*לתשלום|total/i.test(line)) {
      const amounts = numbersIn(line).filter((n) => n > 0);
      if (amounts.length) total = Math.max(...amounts);
      continue;
    }

    // Dates and clock times are numbers too, and never an amount.
    const undated = line.replace(/\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}:\d{2}(?::\d{2})?/g, ' ');
    const barcode = undated.match(BARCODE)?.[0] ?? null;
    const withoutBarcode = barcode ? undated.replace(barcode, ' ') : undated;
    const numbers = numbersIn(withoutBarcode);
    const name = nameIn(withoutBarcode);

    if (DISCOUNT.test(line) && lines.length > 0 && numbers.length > 0) {
      const last = lines[lines.length - 1]!;
      const off = Math.abs(numbers[numbers.length - 1]!);
      if (last.total != null) last.total = cents(last.total - off);
      continue;
    }
    const isHeader = STORES.some((st) => st.pattern.test(line) && !LETTERS.test(line.replace(st.pattern, '')));
    if (isHeader || NOT_AN_ITEM.test(line)) { pendingName = null; pendingBarcode = null; continue; }

    if (name && numbers.length === 0) {
      // A name alone. Keep it for the numbers on the next line — or, if there
      // already was one waiting, this is the second half of a long name.
      pendingName = pendingName && !barcode ? `${pendingName} ${name}` : name;
      pendingBarcode = barcode ?? pendingBarcode;
      continue;
    }
    if (!name && numbers.length === 0) {
      if (barcode) pendingBarcode = barcode;
      continue;
    }

    const itemName = name || pendingName;
    if (!itemName) continue;
    const item = itemFromNumbers(itemName, barcode ?? (name ? null : pendingBarcode), numbers);
    if (item) lines.push(item);
    pendingName = null;
    pendingBarcode = null;
  }

  if (lines.length === 0) warnings.push('לא מצאתי פריטים בטקסט');
  return { store: detectStore(text), purchased_on: findDate(text), total, lines, warnings };
}

/** A size in the product's name: «1 ליטר», «80 גרם», «6 יח». */
const SIZE_UNIT = /^\s*(?:ליטר|ל['׳]?|גרם|גר['׳]?|ג['׳]|ק["״]?ג|מ["״]?ל|יח['׳]?|יחידות|מטר|מ['׳]|kg|g|ml|l)(?![א-תa-zA-Z])/i;

/** Whether the number at `index` belongs to the name rather than being an amount. */
function partOfName(whole: string, index: number, length: number): boolean {
  const after = whole[index + length] ?? '';
  const before = whole[index - 1] ?? '';
  // Glued to letters — «3%», «1ל», «500גר» — or followed by a unit word.
  return LETTERS.test(after) || after === '%' || LETTERS.test(before) || SIZE_UNIT.test(whole.slice(index + length));
}

function numbersIn(line: string): number[] {
  return [...line.matchAll(NUMBER)]
    .filter((m) => !partOfName(line, m.index!, m[0].length))
    .map((m) => toNumber(m[0]));
}

function nameIn(line: string): string {
  if (!LETTERS.test(line)) return '';
  // Strip the free-standing amounts, keep the numbers that belong to the name.
  return line
    .replace(NUMBER, (m, offset: number, whole: string) => (partOfName(whole, offset, m.length) ? m : ' '))
    .replace(/\s*[x×*]\s*(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function itemFromNumbers(name: string, barcode: string | null, numbers: number[]): ReceiptLine | null {
  const positive = numbers.filter((n) => n !== 0);
  if (positive.length === 0) return null;
  const total = cents(positive[positive.length - 1]!);
  let qty = 1;
  if (positive.length >= 3) {
    // qty · unit = total, in either order the page chose, just before the total.
    const [a, b] = positive.slice(-3) as [number, number];
    if (Math.abs(a * b - total) <= 0.05) qty = a <= b ? a : b;
  } else if (positive.length === 2) {
    const [a] = positive as [number];
    // «2 13.80»: a small round count before the amount.
    if (a > 0 && a < 100 && (Number.isInteger(a) || a < 10)) qty = a;
  }
  return { name: name.slice(0, 120), barcode, qty: round3(qty), total };
}

// ── JSON ─────────────────────────────────────────────────────────────────

/**
 * Reads a receipt that arrived as data — the document behind a receipt link,
 * fetched on the phone and pasted here.
 *
 * Nothing about the field names is assumed. The array of items is whichever
 * array of objects looks most like items (a name and an amount on most of
 * them), and each field is found by what its key sounds like. This is what
 * keeps a renamed field at the chain's end from silently emptying the import.
 */
export function parseReceiptJson(data: unknown): ParsedReceipt {
  const warnings: string[] = [];
  const arrays: Record<string, unknown>[][] = [];
  const scalars: { key: string; value: unknown }[] = [];

  const walk = (value: unknown, key: string, depth: number) => {
    if (depth > 8 || value == null) return;
    if (Array.isArray(value)) {
      const objects = value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
      if (objects.length) arrays.push(objects);
      for (const v of value) walk(v, key, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, k, depth + 1);
      return;
    }
    scalars.push({ key, value });
  };
  walk(data, '', 0);

  let best: ReceiptLine[] = [];
  for (const arr of arrays) {
    const items = arr.map(itemFromObject).filter((x): x is ReceiptLine => x != null);
    if (items.length > best.length && items.length >= arr.length / 2) best = items;
  }

  const text = scalars.map((s) => String(s.value)).join('\n');
  const totalScalar = scalars.find((s) => /^(total|sum|final|amount|grand|topay|to_pay|payment)/i.test(s.key.replace(/[^a-z_]/gi, ''))
    && toAmount(s.value) != null);
  const dateScalar = scalars.find((s) => /date|time|תאריך/i.test(s.key) && typeof s.value === 'string' && findDate(s.value));

  if (best.length === 0) warnings.push(`לא מצאתי פריטים בקובץ. מבנה: ${jsonShape(data).slice(0, 400)}`);
  return {
    store: detectStore(text),
    purchased_on: dateScalar ? findDate(String(dateScalar.value)) : findDate(text),
    total: totalScalar ? toAmount(totalScalar.value) : null,
    lines: best,
    warnings,
  };
}

const KEY = {
  name: /name|desc|title|item|product|שם|תיאור|פריט/i,
  barcode: /barcode|ean|upc|sku|gtin|ברקוד|^code$|itemcode|productcode/i,
  qty: /qty|quant|count|units|weight|כמות|משקל/i,
  total: /total|sum|final|linetotal|net|סה|סכום/i,
  price: /price|unit|מחיר/i,
};

function itemFromObject(o: Record<string, unknown>): ReceiptLine | null {
  let name: string | null = null;
  let barcode: string | null = null;
  let qty: number | null = null;
  let total: number | null = null;
  let price: number | null = null;
  for (const [k, v] of Object.entries(o)) {
    if (v == null || typeof v === 'object') continue;
    const s = String(v).trim();
    if (KEY.barcode.test(k) && /^\d{4,14}$/.test(s)) { barcode ??= s; continue; }
    if (KEY.name.test(k) && LETTERS.test(s) && !name) { name = s; continue; }
    const n = toAmount(v);
    if (n == null) continue;
    if (KEY.qty.test(k)) qty ??= n;
    else if (KEY.total.test(k)) total ??= n;
    else if (KEY.price.test(k)) price ??= n;
  }
  if (!name || (total == null && price == null)) return null;
  const q = qty && qty > 0 ? qty : 1;
  return { name: name.slice(0, 120), barcode, qty: round3(q), total: cents(total ?? (price ?? 0) * q) };
}

function toAmount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+(?:[.,]\d+)?$/.test(v.trim())) return toNumber(v.trim());
  return null;
}

// ── Either ───────────────────────────────────────────────────────────────

/** Whatever was pasted: the receipt's data if it parses as JSON, otherwise its text. */
export function parseReceipt(input: string): ParsedReceipt {
  const trimmed = input.trim();
  let parsed: ParsedReceipt;
  if (/^[[{]/.test(trimmed)) {
    try {
      parsed = parseReceiptJson(JSON.parse(trimmed));
    } catch {
      parsed = parseReceiptText(trimmed);
    }
  } else {
    parsed = parseReceiptText(trimmed);
  }
  if (parsed.total == null && parsed.lines.length) {
    parsed.total = cents(parsed.lines.reduce((s, l) => s + (l.total ?? 0), 0));
  } else if (parsed.total != null && parsed.lines.length) {
    const sum = cents(parsed.lines.reduce((s, l) => s + (l.total ?? 0), 0));
    // A gap is usually a line the parser missed, or a discount it did not
    // attribute. Said, not hidden: the expense uses the receipt's own total.
    if (Math.abs(sum - parsed.total) > 1) {
      parsed.warnings.push(`סכום השורות (${sum.toFixed(2)}) שונה מסה״כ בקבלה (${parsed.total.toFixed(2)})`);
    }
  }
  return parsed;
}

/** What two pastes of the same receipt agree on. */
export function receiptFingerprint(r: { store: string; purchased_on: string; total: number | null; lines: { name: string; total: number | null }[] }): string {
  const items = r.lines.map((l) => `${itemKey(l.name)}=${(l.total ?? 0).toFixed(2)}`).sort().join(';');
  return `${itemKey(r.store)}|${r.purchased_on}|${(r.total ?? 0).toFixed(2)}|${items}`;
}

// ── Matching ─────────────────────────────────────────────────────────────

export interface MatchProduct { id: number; name: string; name_key: string; barcode: string | null }
export interface ItemRule { item_key: string; product_id: number | null; ignored: boolean }

export type MatchHow = 'barcode' | 'learned' | 'name' | 'ignored' | null;
export interface LineMatch { product_id: number | null; how: MatchHow }

/**
 * Which of our products a slip line is.
 *
 * In order of how sure it is: the barcode (cannot be wrong), what this house
 * answered about the same line before (was a decision), then the exact name.
 * Nothing fuzzier — a wrong guess fills the wrong shelf without anyone
 * noticing, while no guess is asked about once and then remembered.
 */
export function matchLine(line: ReceiptLine, products: MatchProduct[], rules: ItemRule[]): LineMatch {
  if (line.barcode) {
    const byCode = products.find((p) => p.barcode && p.barcode === line.barcode);
    if (byCode) return { product_id: byCode.id, how: 'barcode' };
  }
  const key = itemKey(line.name);
  const rule = rules.find((r) => r.item_key === key);
  if (rule?.ignored) return { product_id: null, how: 'ignored' };
  if (rule?.product_id != null && products.some((p) => p.id === rule.product_id)) {
    return { product_id: rule.product_id, how: 'learned' };
  }
  const byName = products.find((p) => p.name_key === key);
  if (byName) return { product_id: byName.id, how: 'name' };
  return { product_id: null, how: null };
}

export interface ListItem { id: number; product_id: number | null; name_key: string; status: 'open' | 'bought' }

/**
 * What a receipt does to the shopping list.
 *
 * Open items it covers come off. Items already ticked «bought» in the shop
 * come off too — and those were put in the pantry when they were ticked, so
 * the receipt must not stock them a second time: `alreadyStocked` names the
 * products to skip.
 */
export function planListClear(
  lines: { product_id: number | null; name: string }[],
  items: ListItem[],
): { clear: number[]; alreadyStocked: Set<number> } {
  const products = new Set(lines.map((l) => l.product_id).filter((id): id is number => id != null));
  const names = new Set(lines.map((l) => itemKey(l.name)));
  const clear: number[] = [];
  const alreadyStocked = new Set<number>();
  for (const item of items) {
    const covered = item.product_id != null ? products.has(item.product_id) : names.has(item.name_key);
    if (!covered) continue;
    clear.push(item.id);
    if (item.status === 'bought' && item.product_id != null) alreadyStocked.add(item.product_id);
  }
  return { clear, alreadyStocked };
}

// ── A receipt link ───────────────────────────────────────────────────────

/**
 * The receipt a pasted SMS points at, if it is one we know how to open.
 *
 * Only exact hosts, never a URL taken as given: the server fetches what this
 * returns, and a server that fetches whatever URL it is handed is a server
 * that can be pointed at anything.
 */
export function receiptLink(text: string): { store: string; page: string; data: string } | null {
  const rami = text.match(/https?:\/\/digi\.rami-levy\.co\.il\/([A-Za-z0-9_-]{6,64})(?![A-Za-z0-9_-])/);
  if (rami) {
    const id = rami[1]!;
    return {
      store: 'רמי לוי',
      page: `https://digi.rami-levy.co.il/${id}`,
      data: `https://digi-api.rami-levy.co.il/api/client/documents/${id}`,
    };
  }
  return null;
}

/** The keys of a JSON document, a few levels deep — what to report when no items were found in it. */
export function jsonShape(data: unknown, depth = 0): string {
  if (depth > 2 || data == null || typeof data !== 'object') return typeof data;
  if (Array.isArray(data)) return `[${data.length ? jsonShape(data[0], depth + 1) : ''}]`;
  return `{${Object.entries(data as Record<string, unknown>).slice(0, 30).map(([k, v]) => `${k}:${jsonShape(v, depth + 1)}`).join(',')}}`;
}
