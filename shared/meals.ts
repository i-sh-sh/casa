import { normalizeName } from './pantry.js';
import type { Ingredient, MealHabits, Recipe, RecipeKind, ShoppingItem } from './types.js';

// The recipes and the weekly plan, as pure functions: parsing what somebody
// pasted, choosing a week, and working out what the week needs from the shop.
// Everything that decides something lives here, so it can be tested without a
// database; api/_lib/meals-service.ts only reads and writes.

export const RECIPE_KINDS: readonly RecipeKind[] = ['בשר', 'עוף', 'דגים', 'חלבי', 'צמחוני'];
export const EFFORTS = ['מהיר', 'רגיל', 'ארוך'] as const;

/** Meat in the sense the habit «בשר עד X פעמים» means: what makes a meal בשרי. */
export const isMeat = (kind: RecipeKind): boolean => kind === 'בשר' || kind === 'עוף';
/** What a «ערב צמחוני» allows. Fish is not on it: a household that says vegetarian means it. */
export const isVeggie = (kind: RecipeKind): boolean => kind === 'חלבי' || kind === 'צמחוני';

// ── Dates ────────────────────────────────────────────────────────────────

const DAY_LETTERS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function utc(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`not a date: ${iso}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function addDays(iso: string, days: number): string {
  const d = utc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday. */
export const weekday = (iso: string): number => utc(iso).getUTCDay();

/** The Sunday a date's week starts on. An Israeli week, so not Monday. */
export const weekStart = (iso: string): string => addDays(iso, -weekday(iso));

export const dayLetter = (iso: string): string => DAY_LETTERS[weekday(iso)]!;
export const dayName = (index: number): string => DAY_NAMES[index]!;

function daysBetween(from: string, to: string): number {
  return Math.round((utc(to).getTime() - utc(from).getTime()) / 86_400_000);
}

// ── Habits ───────────────────────────────────────────────────────────────

export const DEFAULT_HABITS: MealHabits = {
  days: [0, 1, 2, 3, 4],
  meat_max: 3,
  veggie_days: [],
  quick_days: [],
  repeat_gap: 10,
};

const dayList = (value: unknown): number[] =>
  Array.isArray(value)
    ? [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort()
    : [];

const bounded = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/**
 * Whatever is stored, as habits the planner can use.
 *
 * The column is JSONB and the rules will grow, so a row written before a rule
 * existed has to read as that rule's default rather than as `undefined` — and
 * a veggie day that is not also a planned day is not a rule about anything.
 */
export function normalizeHabits(raw: unknown): MealHabits {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const days = 'days' in r ? dayList(r['days']) : DEFAULT_HABITS.days;
  return {
    days,
    meat_max: bounded(r['meat_max'], 0, 7, DEFAULT_HABITS.meat_max),
    veggie_days: dayList(r['veggie_days']).filter((d) => days.includes(d)),
    quick_days: dayList(r['quick_days']).filter((d) => days.includes(d)),
    repeat_gap: bounded(r['repeat_gap'], 0, 60, DEFAULT_HABITS.repeat_gap),
  };
}

// ── Pasting a recipe ─────────────────────────────────────────────────────

const UNITS: Record<string, string> = {
  'גרם': 'גרם', 'גר': 'גרם', 'ג': 'גרם',
  'קג': 'ק״ג', 'קילו': 'ק״ג',
  'מל': 'מ״ל', 'ליטר': 'ליטר', 'ל': 'ליטר',
  'כוס': 'כוס', 'כוסות': 'כוס',
  'כף': 'כף', 'כפות': 'כף',
  'כפית': 'כפית', 'כפיות': 'כפית',
  'יח': 'יח׳', 'יחידה': 'יח׳', 'יחידות': 'יח׳',
  'חבילה': 'חבילה', 'חבילות': 'חבילה', 'חבילת': 'חבילה',
  'פחית': 'פחית', 'פחיות': 'פחית', 'פחיית': 'פחית',
  'קופסה': 'קופסה', 'קופסת': 'קופסה', 'קופסאות': 'קופסה',
  'שן': 'שן', 'שיני': 'שן', 'שיניים': 'שן', 'ראש': 'ראש', 'ראשי': 'ראש',
  'צרור': 'צרור', 'צרורות': 'צרור',
  'ענף': 'ענף', 'ענפים': 'ענף',
};

/** The one spelling of a unit, so «כפות» and «כף» compare equal. Unknown units pass through. */
export function normalizeUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  const bare = unit.trim().replace(/[׳״"'.]/g, '');
  return UNITS[bare] ?? unit.trim();
}

const PLURAL_UNITS: Record<string, string> = { 'כוס': 'כוסות', 'כף': 'כפות', 'כפית': 'כפיות', 'שן': 'שיני', 'חבילה': 'חבילות', 'פחית': 'פחיות', 'קופסה': 'קופסאות', 'ראש': 'ראשי', 'צרור': 'צרורות' };

/** «2 כפות», «כף אחת» — the unit as somebody would say it, which is also what the parser reads back. */
export function unitLabel(unit: string | null, qty: number | null): string | null {
  if (!unit) return null;
  return qty !== null && qty > 1 ? PLURAL_UNITS[unit] ?? unit : unit;
}

// Words that place a product on a shelf. Only for products the plan creates
// by itself; anything the household files by hand keeps its own aisle. A miss
// lands on «כללי», which is where it would have been anyway. Order matters:
// «רסק עגבניות» is a tin before it is a tomato, and «שמנת» is not «שמן».
const AISLE_WORDS: [string, RegExp][] = [
  ['בשר ודגים', /בשר|עוף|חזה|שוק|כרעיים|פרגית|סלמון|דג|טונה טרייה|כבד|נקניק/],
  ['חלב וביצים', /חלב|גבינ|שמנת|יוגורט|ביצ|חמאה|קוטג|לבנה|ריקוטה|מוצרלה|פרמזן/],
  ['לחם ומאפים', /לחם|פיתה|לחמני|בצק|טורטיה|פירורי/],
  ['יבשים ושימורים', /רסק|עדשים|אורז|פסטה|ספגטי|קמח|שימור|חומוס|שעועית|פפריקה|כמון|כורכום|תבלין|רוטב|קוסקוס|בורגול|קינואה|אטריות|סוכר|שמן|חומץ|סויה|טחינה|שקדים|אגוזים/],
  ['פירות וירקות', /עגבני|בצל|שום|מלפפון|קישוא|תפוח|גזר|פלפל|לימון|חציל|כרוב|חסה|פטרוזיליה|כוסברה|שמיר|נענע|בטטה|דלעת|פטריות|ברוקולי|כרובית|תרד|אבוקדו|ג׳ינג׳ר|זנגביל|תירס/],
  ['קפואים', /קפוא/],
];

export function guessAisle(name: string): string {
  return AISLE_WORDS.find(([, re]) => re.test(name))?.[0] ?? 'כללי';
}

const WORD_NUMBERS: Record<string, number> = {
  'חצי': 0.5, 'רבע': 0.25, 'אחד': 1, 'אחת': 1, 'שתיים': 2, 'שתים': 2, 'שני': 2, 'שתי': 2,
  'שלוש': 3, 'שלושה': 3, 'ארבע': 4, 'ארבעה': 4, 'חמש': 5, 'חמישה': 5, 'שש': 6, 'שישה': 6,
};
const FRACTIONS: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };

/** Words that mean «some», which is not a quantity anybody can shop for. */
const VAGUE = new Set(['קורט', 'מעט', 'חופן', 'קצת', 'לפי']);

/**
 * Salt and water are never worth a line on the list. Short on purpose: the
 * checkbox is there for everything else, and a guess that is wrong about
 * «סוכר» puts sugar silently off a list it belonged on.
 */
const ALWAYS_HAVE = new Set(['מלח', 'פלפל שחור', 'מלח ופלפל', 'מלח ופלפל שחור', 'מים', 'שמן', 'שמן קנולה']);

const round2 = (n: number): number => Math.round(n * 100) / 100;

function leadingQuantity(text: string): { qty: number | null; rest: string } {
  let rest = text;
  let qty: number | null = null;

  const fraction = /^([½¼¾⅓⅔])\s*/.exec(rest);
  const numeric = /^(\d+(?:[.,]\d+)?)(?:\s*\/\s*(\d+))?(?:\s*([½¼¾⅓⅔]))?\s*/.exec(rest);
  if (numeric) {
    const whole = Number(numeric[1]!.replace(',', '.'));
    qty = numeric[2] ? whole / Number(numeric[2]) : whole;
    if (numeric[3]) qty += FRACTIONS[numeric[3]]!;
    rest = rest.slice(numeric[0].length);
  } else if (fraction) {
    qty = FRACTIONS[fraction[1]!]!;
    rest = rest.slice(fraction[0].length);
  } else {
    const word = /^(\S+)\s+/.exec(rest);
    if (word && word[1]! in WORD_NUMBERS) {
      qty = WORD_NUMBERS[word[1]!]!;
      rest = rest.slice(word[0].length);
    }
  }
  // «1 וחצי כוסות», «כוס וחצי» is handled with the unit below.
  const andHalf = /^וחצי\s+/.exec(rest);
  if (qty !== null && andHalf) {
    qty += 0.5;
    rest = rest.slice(andHalf[0].length);
  }
  return { qty: qty === null ? null : round2(qty), rest };
}

/**
 * One pasted line as an ingredient: «2 כוסות אורז», «½ ק״ג בשר טחון»,
 * «3 ביצים», «קורט מלח».
 *
 * Recipes arrive pasted from a site or a WhatsApp message, and the alternative
 * to reading them is three form fields per ingredient — which is how a
 * cookbook stays empty. Anything it cannot read stays as a name with no
 * quantity, and the screen shows it for fixing; it never drops a line.
 */
export function parseIngredientLine(line: string): Omit<Ingredient, 'product_id'> | null {
  let text = line
    .replace(/^\s*(?:[-–•*·▪]+|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.endsWith(':')) return null;

  // Asides a shopping list has no use for.
  text = text
    .replace(/\s*\((?:לא חובה|אופציונלי|רשות)\)\s*/g, ' ')
    .replace(/\s*,?\s*(?:לפי הטעם|לטיגון|לקישוט)\s*$/, '')
    .trim();

  let { qty, rest } = leadingQuantity(text);
  let unit: string | null = null;

  const unitWord = /^(\S+?)\s+/.exec(rest);
  if (unitWord) {
    const bare = unitWord[1]!.replace(/[׳״"'.]/g, '');
    if (VAGUE.has(bare)) {
      qty = null;
      rest = rest.slice(unitWord[0].length).replace(/^(?:הטעם|של)\s+/, '');
    } else if (bare in UNITS) {
      unit = UNITS[bare]!;
      rest = rest.slice(unitWord[0].length);
      if (qty === null) qty = 1; // «כוס אורז»
      const andHalf = /^וחצי\s+/.exec(rest);
      if (andHalf) { qty += 0.5; rest = rest.slice(andHalf[0].length); }
    }
  }

  const name = rest.replace(/^של\s+/, '').trim();
  if (!name) return null;
  return {
    name,
    qty,
    unit,
    always_have: ALWAYS_HAVE.has(normalizeName(name)),
  };
}

export function parseIngredients(text: string): Omit<Ingredient, 'product_id'>[] {
  return text.split(/\r?\n/).map(parseIngredientLine).filter((i): i is Omit<Ingredient, 'product_id'> => i !== null);
}

/**
 * The product names an ingredient could be filed under.
 *
 * Recipes say «ביצה» and «עגבנייה»; the pantry says «ביצים» and «עגבניות».
 * Hebrew plurals are mostly a suffix, so trying the obvious ones finds the
 * product the household already tracks instead of creating a second one —
 * the same harm normalizeName exists to prevent.
 */
export function nameCandidates(name: string): string[] {
  const key = normalizeName(name);
  const out = [key];
  if (/ה$/.test(key)) out.push(key.replace(/ה$/, 'ים'), key.replace(/ה$/, 'ות'));
  // «עגבנייה» → «עגבניות»: the doubled yod is spelling, not part of the stem.
  if (/ייה$/.test(key)) out.push(key.replace(/ייה$/, 'יות'));
  if (/(ים|ות)$/.test(key)) out.push(key.replace(/(ים|ות)$/, ''), key.replace(/(ים|ות)$/, 'ה'));
  else out.push(`${key}ים`, `${key}ות`);
  return [...new Set(out)];
}

// ── Choosing the week ────────────────────────────────────────────────────

export interface StockFact { in_stock: number; next_expiry: string | null; name: string; unit: string }

export interface PlanInput {
  weekStart: string;
  today: string;
  habits: MealHabits;
  recipes: Recipe[];
  stock: Map<number, StockFact>;
  /** Days somebody already chose. The planner fills around them. */
  locked: { day: string; recipe_id: number }[];
  /** Recipes not to offer on a given day — what «החלפה» was just pressed on. */
  avoid?: { day: string; recipe_id: number }[];
  seed?: number;
}

export interface PlannedDay {
  day: string;
  recipe_id: number;
  locked: boolean;
  /** Why this one, in a few words — so the choice can be argued with. */
  reasons: string[];
  /** A habit that had to give way because nothing in the cookbook fit it. */
  relaxed: string | null;
}

/** Small, seedable, and enough: the jitter only has to break ties differently on «שוב». */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What a recipe needs from the shop, ignoring what we always have. */
const shoppable = (r: Recipe): Ingredient[] => r.ingredients.filter((i) => !i.always_have);

function pantryFacts(recipe: Recipe, stock: Map<number, StockFact>, day: string, today: string) {
  const needed = shoppable(recipe);
  let have = 0;
  let expiring: string | null = null;
  for (const ing of needed) {
    const fact = ing.product_id ? stock.get(ing.product_id) : undefined;
    if (!fact || fact.in_stock <= 0) continue;
    have++;
    // Only what turns before (or within two days after) the meal counts as
    // being rescued by it — a yoghurt good for a month is just stock.
    // Already expired is not rescued by anything, so it is not a reason.
    if (fact.next_expiry && fact.next_expiry >= today && daysBetween(day, fact.next_expiry) <= 2 && !expiring) {
      expiring = fact.name;
    }
  }
  return { coverage: needed.length ? have / needed.length : 0, expiring, total: needed.length };
}

/**
 * Picks a dinner for every planned day of the week.
 *
 * A greedy day-by-day choice, not an optimiser. The household has to be able
 * to read why a meal was picked and disagree with it, and «it maximised a
 * score over 7! orderings» is not a reason anybody can argue with. Each day
 * takes the best-scoring recipe that obeys the habits:
 *
 *   · liked more             — the cookbook's own rating, the heaviest weight;
 *   · already in the pantry  — fewer things to buy, and rescuing what is about
 *                              to expire is worth more than either;
 *   · not eaten lately       — the gap since it was last cooked, capped at four
 *                              weeks so a forgotten dish does not swamp a loved one;
 *   · not the same as yesterday — fish after fish reads as a mistake.
 *
 * Habits are hard rules while the cookbook can satisfy them, and give way —
 * with a sentence saying so — only when it cannot. A plan with an empty
 * Tuesday because nothing quick was tagged would be correct and useless.
 */
export function planWeek(input: PlanInput): PlannedDay[] {
  const { habits, stock, today } = input;
  const random = rng(input.seed ?? 1);
  const recipes = input.recipes.filter((r) => !r.archived_at);
  const days = habits.days
    .map((d) => addDays(input.weekStart, d))
    .filter((day) => day >= today || input.locked.some((l) => l.day === day));

  const byId = new Map(recipes.map((r) => [r.id, r]));
  const lockedOn = new Map(input.locked.map((l) => [l.day, l.recipe_id]));
  const used = new Set<number>(input.locked.map((l) => l.recipe_id));
  let meat = input.locked.filter((l) => {
    const r = byId.get(l.recipe_id);
    return r ? isMeat(r.kind) : false;
  }).length;

  const out: PlannedDay[] = [];
  let previous: RecipeKind | null = null;

  for (const day of days) {
    const lockedId = lockedOn.get(day);
    if (lockedId !== undefined) {
      out.push({ day, recipe_id: lockedId, locked: true, reasons: [], relaxed: null });
      previous = byId.get(lockedId)?.kind ?? null;
      continue;
    }

    const dow = weekday(day);
    const quick = habits.quick_days.includes(dow);
    const veggie = habits.veggie_days.includes(dow);
    const avoided = new Set((input.avoid ?? []).filter((a) => a.day === day).map((a) => a.recipe_id));

    const fresh = recipes.filter((r) => !used.has(r.id) && !avoided.has(r.id));
    const recent = (r: Recipe) => r.last_cooked !== null && daysBetween(r.last_cooked, day) < habits.repeat_gap;

    // Each habit in turn, dropped from the last-added backwards only if the
    // cookbook leaves nothing standing. The order is the order of how much a
    // household minds: a vegetarian evening first, then the meat count, then
    // a quick dinner, then not repeating last week.
    const rules: { label: string; ok: (r: Recipe) => boolean }[] = [
      { label: 'ערב צמחוני', ok: (r) => !veggie || isVeggie(r.kind) },
      { label: `בשר עד ${habits.meat_max} פעמים`, ok: (r) => !isMeat(r.kind) || meat < habits.meat_max },
      { label: 'ערב מהיר', ok: (r) => !quick || r.effort === 'מהיר' },
      { label: 'לא לחזור על מה שאכלנו לאחרונה', ok: (r) => !recent(r) },
    ];
    let pool: Recipe[] = [];
    let relaxed: string | null = null;
    for (let keep = rules.length; keep >= 0; keep--) {
      pool = fresh.filter((r) => rules.slice(0, keep).every((rule) => rule.ok(r)));
      if (pool.length > 0) {
        // The rule just dropped is the one that emptied the pool; the ones
        // dropped before it did not help, and are not worth a sentence.
        relaxed = keep < rules.length ? rules[keep]!.label : null;
        break;
      }
    }
    if (pool.length === 0) continue; // a cookbook smaller than the week

    const scored = pool.map((r) => {
      const facts = pantryFacts(r, stock, day, today);
      const gap = r.last_cooked === null ? null : daysBetween(r.last_cooked, day);
      const score =
        r.liking * 3
        + facts.coverage * 2
        + (facts.expiring ? 2.5 : 0)
        + (gap === null ? 1 : (Math.min(gap, 28) / 28) * 2)
        - (previous === r.kind ? 1.5 : 0)
        + random() * 1.5;
      return { r, score, facts, gap };
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]!;

    const reasons: string[] = [];
    if (best.facts.expiring) reasons.push(`לפני שה${best.facts.expiring} יפוג`);
    if (best.facts.total > 0 && best.facts.coverage === 1) reasons.push('יש הכול בבית');
    else if (best.facts.coverage >= 0.5) reasons.push('רוב המצרכים בבית');
    if (quick && best.r.effort === 'מהיר') reasons.push('ערב מהיר');
    if (veggie && isVeggie(best.r.kind)) reasons.push('ערב צמחוני');
    if (best.r.liking === 3) reasons.push('אהוב במיוחד');
    if (best.gap === null) reasons.push('עוד לא בישלנו');
    else if (best.gap >= 21) reasons.push(`לא היה ${Math.floor(best.gap / 7)} שבועות`);

    out.push({ day, recipe_id: best.r.id, locked: false, reasons: reasons.slice(0, 2), relaxed });
    used.add(best.r.id);
    if (isMeat(best.r.kind)) meat++;
    previous = best.r.kind;
  }
  return out;
}

// ── What the week needs from the shop ────────────────────────────────────

export interface PlannedMeal {
  day: string;
  recipe_name: string;
  ingredients: Ingredient[];
}

export interface Need {
  product_id: number | null;
  name: string;
  name_key: string;
  qty: number;
  unit: string;
  /** «שקשוקה · ג׳, פסטה · ה׳» — the list explains itself. */
  note: string;
}

/**
 * Can this amount be compared with the product's stock?
 *
 * «3 ביצים» against ביצים counted in יח׳: yes. «2 כוסות אורז» against rice
 * kept in ק״ג: no, and pretending otherwise would buy six kilos. An ingredient
 * with no unit is counted in the product's own unit.
 */
export function sameUnit(ingredientUnit: string | null, productUnit: string): boolean {
  const a = normalizeUnit(ingredientUnit);
  return a === null || a === normalizeUnit(productUnit);
}

/**
 * The lines the planned meals put on the shopping list.
 *
 * Per product: everything the week's meals need, minus what is on the shelf.
 * When the amounts cannot be compared (cups against kilos) the product is
 * needed only if there is none of it at all — one packet, in its own unit —
 * because «we have rice» is the fact that matters there, not the arithmetic.
 *
 * Always-have ingredients are skipped, and so are unlinked ones: the service
 * creates products for those first, so by the time this runs an unlinked
 * ingredient is one with no name worth buying.
 */
export function shoppingNeeds(meals: PlannedMeal[], stock: Map<number, StockFact>): Need[] {
  const groups = new Map<number, { fact: StockFact; total: number; comparable: boolean; meals: string[] }>();
  for (const meal of meals) {
    for (const ing of meal.ingredients) {
      if (ing.always_have || !ing.product_id) continue;
      const fact = stock.get(ing.product_id);
      if (!fact) continue;
      const g = groups.get(ing.product_id) ?? { fact, total: 0, comparable: true, meals: [] };
      if (sameUnit(ing.unit, fact.unit)) g.total += ing.qty ?? 1;
      else g.comparable = false;
      const label = `${meal.recipe_name} · ${dayLetter(meal.day)}`;
      if (!g.meals.includes(label)) g.meals.push(label);
      groups.set(ing.product_id, g);
    }
  }

  const needs: Need[] = [];
  for (const [productId, g] of groups) {
    let qty: number;
    if (g.comparable) {
      const missing = round2(g.total - g.fact.in_stock);
      if (missing <= 0) continue;
      // Whole units for things counted in units: nobody buys 0.5 eggs.
      qty = normalizeUnit(g.fact.unit) === 'יח׳' ? Math.ceil(missing) : missing;
    } else {
      if (g.fact.in_stock > 0) continue;
      qty = 1;
    }
    needs.push({
      product_id: productId,
      name: g.fact.name,
      name_key: normalizeName(g.fact.name),
      qty,
      unit: g.fact.unit,
      note: g.meals.join(', '),
    });
  }
  return needs.sort((a, b) => a.name.localeCompare(b.name, 'he'));
}

export interface ListChanges {
  add: Need[];
  update: { id: number; qty: number; note: string | null }[];
  remove: number[];
}

/**
 * How to bring the open list in line with what the week needs.
 *
 * The rule for whose line it is: a line the plan wrote (`source = 'recipe'`)
 * belongs to the plan, so it follows the plan — its amount changes with it,
 * and it leaves when the meal does. A line a person wrote is theirs and is
 * never touched; it already covers the need. A line the min-stock rule wrote
 * is the system's too, so it may grow to cover the meal, but is never removed
 * here — the pantry still wants it.
 *
 * Bought lines are out of scope: buying already put them on the shelf, and
 * the stock the needs were computed from has them.
 */
export function listChanges(needs: Need[], open: Pick<ShoppingItem, 'id' | 'product_id' | 'name_key' | 'qty' | 'note' | 'source'>[]): ListChanges {
  const changes: ListChanges = { add: [], update: [], remove: [] };
  const claimed = new Set<number>();
  // A line typed by hand before the product existed has no product_id, only a
  // name — «עגבניות» written at the door last week is still the tomatoes this
  // week's shakshuka needs, and a second line for them is the duplicate the
  // whole list is built to avoid.
  const find = (need: Need) => open.find((row) =>
    (need.product_id !== null && row.product_id === need.product_id)
    || (row.product_id === null && row.name_key === need.name_key));

  for (const need of needs) {
    const row = find(need);
    if (!row) { changes.add.push(need); continue; }
    claimed.add(row.id);
    if (row.source === 'recipe') {
      if (row.qty !== need.qty || row.note !== need.note) changes.update.push({ id: row.id, qty: need.qty, note: need.note });
    } else if (row.source === 'auto_min_stock' && row.qty < need.qty) {
      changes.update.push({ id: row.id, qty: need.qty, note: row.note });
    }
  }
  for (const row of open) {
    if (row.source === 'recipe' && !claimed.has(row.id)) changes.remove.push(row.id);
  }
  return changes;
}

/**
 * What «בישלנו» takes off the shelf: the amounts that can be counted in the
 * product's own unit. Cups of rice against kilos are left alone — a wrong
 * deduction is worse than none, because the min-stock rule reads it.
 */
export function cookConsumption(ingredients: Ingredient[], stock: Map<number, StockFact>): { product_id: number; qty: number }[] {
  const out = new Map<number, number>();
  for (const ing of ingredients) {
    if (ing.always_have || !ing.product_id || ing.qty === null) continue;
    const fact = stock.get(ing.product_id);
    if (!fact || !sameUnit(ing.unit, fact.unit)) continue;
    out.set(ing.product_id, round2((out.get(ing.product_id) ?? 0) + ing.qty));
  }
  return [...out].map(([product_id, qty]) => ({ product_id, qty }));
}
