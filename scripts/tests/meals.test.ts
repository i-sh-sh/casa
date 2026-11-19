import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { StockFact } from '../../shared/meals.ts';
import type { Ingredient, Recipe } from '../../shared/types.ts';

// shared/meals.ts reuses normalizeName from shared/pantry.js — the spelling
// the bundle needs and Node's type stripping cannot follow. Same one-line
// fallback as testing.test.ts, registered before the module is loaded.
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    try { return await next(specifier, context); }
    catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js')) {
        return next(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  }
`)}`);

const {
  cookConsumption, listChanges, nameCandidates, normalizeHabits, parseIngredientLine, parseIngredients,
  planWeek, shoppingNeeds, weekStart, unitLabel, guessAisle,
} = await import('../../shared/meals.ts');

// ── Pasting ──────────────────────────────────────────────────────────────

test('a pasted line becomes an amount, a unit and a name', () => {
  assert.deepEqual(parseIngredientLine('2 כוסות אורז'), { name: 'אורז', qty: 2, unit: 'כוס', always_have: false });
  assert.deepEqual(parseIngredientLine('½ ק״ג בשר טחון'), { name: 'בשר טחון', qty: 0.5, unit: 'ק״ג', always_have: false });
  assert.deepEqual(parseIngredientLine('- 3 ביצים'), { name: 'ביצים', qty: 3, unit: null, always_have: false });
  assert.deepEqual(parseIngredientLine('1/2 כפית כמון'), { name: 'כמון', qty: 0.5, unit: 'כפית', always_have: false });
  assert.deepEqual(parseIngredientLine('כוס וחצי קמח'), { name: 'קמח', qty: 1.5, unit: 'כוס', always_have: false });
  assert.deepEqual(parseIngredientLine('שתי שיני שום'), { name: 'שום', qty: 2, unit: 'שן', always_have: false });
  assert.deepEqual(parseIngredientLine('500 גרם פסטה'), { name: 'פסטה', qty: 500, unit: 'גרם', always_have: false });
});

test('salt is something, not an amount, and never goes on the list', () => {
  assert.deepEqual(parseIngredientLine('קורט מלח'), { name: 'מלח', qty: null, unit: null, always_have: true });
  assert.deepEqual(parseIngredientLine('מלח ופלפל שחור לפי הטעם'), { name: 'מלח ופלפל שחור', qty: null, unit: null, always_have: true });
});

test('headings and blank lines are dropped, nothing else is', () => {
  const lines = parseIngredients('לבצק:\n2 כוסות קמח\n\n• שמרים יבשים (לא חובה)\nמשהו מוזר שאין לו כמות');
  assert.deepEqual(lines.map((l) => l.name), ['קמח', 'שמרים יבשים', 'משהו מוזר שאין לו כמות']);
});

test('a singular in the recipe finds the plural in the pantry', () => {
  assert.ok(nameCandidates('ביצה').includes('ביצים'));
  assert.ok(nameCandidates('עגבנייה').includes('עגבניות'));
  assert.ok(nameCandidates('בצל').includes('בצלים'));
  assert.ok(nameCandidates('ביצים').includes('ביצה'));
});

// ── Habits ───────────────────────────────────────────────────────────────

test('stored habits read with defaults, and rules only about planned days', () => {
  assert.deepEqual(normalizeHabits(null).days, [0, 1, 2, 3, 4]);
  const h = normalizeHabits({ days: [0, 2, 9, 2], veggie_days: [1, 2], meat_max: 99 });
  assert.deepEqual(h.days, [0, 2]);
  assert.deepEqual(h.veggie_days, [2], 'a veggie Monday is not a rule when Monday is not planned');
  assert.equal(h.meat_max, 7);
});

test('the week starts on Sunday', () => {
  assert.equal(weekStart('2026-11-19'), '2026-11-15'); // Thursday
  assert.equal(weekStart('2026-11-15'), '2026-11-15');
});

// ── Planning ─────────────────────────────────────────────────────────────

const ing = (product_id: number | null, name: string, qty: number | null = 1, unit: string | null = null, always_have = false): Ingredient =>
  ({ product_id, name, qty, unit, always_have });

const recipe = (id: number, over: Partial<Recipe> = {}): Recipe => ({
  id, name: `מתכון ${id}`, kind: 'צמחוני', effort: 'רגיל', liking: 2, servings: null, source: null, note: null,
  archived_at: null, ingredients: [], last_cooked: null, times_cooked: 0, ...over,
});

const WEEK = '2026-11-15';
const habits = (over = {}) => normalizeHabits({ days: [0, 1, 2, 3, 4], ...over });

test('every planned day gets a different dinner', () => {
  const plan = planWeek({
    weekStart: WEEK, today: WEEK, habits: habits(), stock: new Map(), locked: [],
    recipes: [1, 2, 3, 4, 5, 6].map((id) => recipe(id)),
  });
  assert.equal(plan.length, 5);
  assert.equal(new Set(plan.map((p) => p.recipe_id)).size, 5);
  assert.deepEqual(plan.map((p) => p.day), ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19']);
});

test('days already behind us are not planned', () => {
  const plan = planWeek({
    weekStart: WEEK, today: '2026-11-18', habits: habits(), stock: new Map(), locked: [],
    recipes: [1, 2, 3].map((id) => recipe(id)),
  });
  assert.deepEqual(plan.map((p) => p.day), ['2026-11-18', '2026-11-19']);
});

test('the meat count is a rule, and a locked meat day counts toward it', () => {
  const recipes = [
    recipe(1, { kind: 'בשר', liking: 3 }), recipe(2, { kind: 'עוף', liking: 3 }), recipe(3, { kind: 'בשר', liking: 3 }),
    recipe(4), recipe(5), recipe(6),
  ];
  const plan = planWeek({
    weekStart: WEEK, today: WEEK, habits: habits({ meat_max: 2 }), stock: new Map(), recipes,
    locked: [{ day: '2026-11-15', recipe_id: 1 }],
  });
  const meat = plan.filter((p) => [1, 2, 3].includes(p.recipe_id));
  assert.equal(meat.length, 2);
  assert.equal(plan[0]!.locked, true);
});

test('a vegetarian evening is vegetarian, and a quick one is quick', () => {
  const recipes = [
    recipe(1, { kind: 'בשר', liking: 3, effort: 'ארוך' }), recipe(2, { kind: 'חלבי', liking: 1 }),
    recipe(3, { kind: 'עוף', liking: 3 }), recipe(4, { effort: 'מהיר', kind: 'דגים', liking: 1 }),
  ];
  // Monday veggie, Tuesday quick.
  const plan = planWeek({
    weekStart: WEEK, today: WEEK, habits: habits({ days: [1, 2], veggie_days: [1], quick_days: [2] }),
    stock: new Map(), recipes, locked: [],
  });
  assert.equal(plan[0]!.recipe_id, 2);
  assert.ok(plan[0]!.reasons.includes('ערב צמחוני'));
  assert.equal(plan[1]!.recipe_id, 4);
});

test('when the cookbook cannot keep a habit, the plan says which one gave way', () => {
  const plan = planWeek({
    weekStart: WEEK, today: WEEK, habits: habits({ days: [1], veggie_days: [1] }),
    stock: new Map(), recipes: [recipe(1, { kind: 'בשר' })], locked: [],
  });
  assert.equal(plan[0]!.recipe_id, 1);
  assert.equal(plan[0]!.relaxed, 'ערב צמחוני');
});

test('what is about to expire pulls its recipe forward', () => {
  const stock = new Map<number, StockFact>([[7, { in_stock: 1, next_expiry: '2026-11-16', name: 'שמנת', unit: 'יח׳' }]]);
  const plan = planWeek({
    weekStart: WEEK, today: WEEK, habits: habits({ days: [0] }), stock, locked: [],
    recipes: [recipe(1, { liking: 2 }), recipe(2, { liking: 2, ingredients: [ing(7, 'שמנת')] })],
  });
  assert.equal(plan[0]!.recipe_id, 2);
  assert.ok(plan[0]!.reasons.some((r) => r.includes('שמנת')));
});

test('something cooked last week waits its turn', () => {
  const plan = planWeek({
    weekStart: WEEK, today: WEEK, habits: habits({ days: [0], repeat_gap: 10 }), stock: new Map(), locked: [],
    recipes: [recipe(1, { liking: 3, last_cooked: '2026-11-10' }), recipe(2, { liking: 1 })],
  });
  assert.equal(plan[0]!.recipe_id, 2);
});

test('«החלפה» offers something else for that day', () => {
  const recipes = [1, 2, 3].map((id) => recipe(id));
  const first = planWeek({ weekStart: WEEK, today: WEEK, habits: habits({ days: [0] }), stock: new Map(), locked: [], recipes });
  const again = planWeek({
    weekStart: WEEK, today: WEEK, habits: habits({ days: [0] }), stock: new Map(), locked: [], recipes,
    avoid: [{ day: WEEK, recipe_id: first[0]!.recipe_id }],
  });
  assert.notEqual(again[0]!.recipe_id, first[0]!.recipe_id);
});

test('archived recipes are never planned', () => {
  const plan = planWeek({
    weekStart: WEEK, today: WEEK, habits: habits({ days: [0] }), stock: new Map(), locked: [],
    recipes: [recipe(1, { liking: 3, archived_at: '2026-11-01' }), recipe(2, { liking: 1 })],
  });
  assert.equal(plan[0]!.recipe_id, 2);
});

// ── The list ─────────────────────────────────────────────────────────────

const stock = new Map<number, StockFact>([
  [1, { in_stock: 4, next_expiry: null, name: 'ביצים', unit: 'יח׳' }],
  [2, { in_stock: 0, next_expiry: null, name: 'אורז', unit: 'ק״ג' }],
  [3, { in_stock: 1, next_expiry: null, name: 'פסטה', unit: 'חבילה' }],
  [4, { in_stock: 0, next_expiry: null, name: 'שמנת', unit: 'יח׳' }],
]);

test('the week needs what its meals need, minus the shelf', () => {
  const needs = shoppingNeeds([
    { day: '2026-11-17', recipe_name: 'שקשוקה', ingredients: [ing(1, 'ביצים', 4), ing(null, 'מלח', null, null, true)] },
    { day: '2026-11-19', recipe_name: 'פשטידה', ingredients: [ing(1, 'ביצה', 3), ing(4, 'שמנת', 1)] },
  ], stock);
  const eggs = needs.find((n) => n.product_id === 1)!;
  assert.equal(eggs.qty, 3, '7 needed, 4 on the shelf');
  assert.equal(eggs.note, 'שקשוקה · ג׳, פשטידה · ה׳');
  assert.equal(needs.find((n) => n.product_id === 4)!.qty, 1);
  assert.equal(needs.length, 2, 'salt never goes on the list');
});

test('cups against kilos: buy one only if there is none', () => {
  const needs = shoppingNeeds([
    { day: '2026-11-17', recipe_name: 'מג׳דרה', ingredients: [ing(2, 'אורז', 2, 'כוסות')] },
    { day: '2026-11-18', recipe_name: 'פסטה ברוטב', ingredients: [ing(3, 'פסטה', 500, 'גרם')] },
  ], stock);
  assert.deepEqual(needs.map((n) => [n.name, n.qty, n.unit]), [['אורז', 1, 'ק״ג']], 'there is pasta on the shelf');
});

test('the plan owns its lines, people own theirs', () => {
  const needs = [
    { product_id: 1, name: 'ביצים', name_key: 'ביצים', qty: 3, unit: 'יח׳', note: 'שקשוקה · ג׳' },
    { product_id: 2, name: 'אורז', name_key: 'אורז', qty: 1, unit: 'ק״ג', note: 'מג׳דרה · ג׳' },
    { product_id: 4, name: 'שמנת', name_key: 'שמנת', qty: 2, unit: 'יח׳', note: 'פשטידה · ה׳' },
    { product_id: 5, name: 'חלב', name_key: 'חלב', qty: 3, unit: 'יח׳', note: 'פשטידה · ה׳' },
  ];
  const changes = listChanges(needs, [
    { id: 10, product_id: 1, name_key: 'ביצים', qty: 2, note: 'ישן', source: 'recipe' },
    { id: 11, product_id: 2, name_key: 'אורז', qty: 1, note: null, source: 'manual' },
    { id: 12, product_id: 9, name_key: 'קישואים', qty: 1, note: 'ממתכון שהוסר', source: 'recipe' },
    { id: 13, product_id: 8, name_key: 'לחם', qty: 1, note: null, source: 'manual' },
    { id: 14, product_id: 5, name_key: 'חלב', qty: 2, note: null, source: 'auto_min_stock' },
  ]);
  assert.deepEqual(changes.add.map((n) => n.name), ['שמנת']);
  assert.deepEqual(changes.update, [
    { id: 10, qty: 3, note: 'שקשוקה · ג׳' },
    { id: 14, qty: 3, note: null },
  ]);
  assert.deepEqual(changes.remove, [12], 'a manual line is never removed, a dropped meal’s line is');
});

test('cooking takes off what can be counted, and nothing else', () => {
  const taken = cookConsumption([
    ing(1, 'ביצים', 4), ing(1, 'ביצה', 1), ing(2, 'אורז', 2, 'כוס'), ing(4, 'שמנת', null), ing(null, 'מלח', null, null, true),
  ], stock);
  assert.deepEqual(taken, [{ product_id: 1, qty: 5 }]);
});

test('what already expired is not a reason to cook anything', () => {
  const stock = new Map<number, StockFact>([[7, { in_stock: 1, next_expiry: '2026-11-14', name: 'שמנת', unit: 'יח׳' }]]);
  const plan = planWeek({
    weekStart: WEEK, today: WEEK, habits: habits({ days: [0] }), stock, locked: [],
    recipes: [recipe(2, { ingredients: [ing(7, 'שמנת')] })],
  });
  assert.ok(!plan[0]!.reasons.some((r) => r.includes('יפוג')));
});

test('a line typed by hand before the product existed still covers the need', () => {
  const changes = listChanges(
    [{ product_id: 30, name: 'עגבניות', name_key: 'עגבניות', qty: 3, unit: 'יח׳', note: 'שקשוקה · ה׳' }],
    [{ id: 1, product_id: null, name_key: 'עגבניות', qty: 1, note: null, source: 'manual' }],
  );
  assert.deepEqual(changes, { add: [], update: [], remove: [] });
});

test('a unit written back reads the way it was pasted', () => {
  assert.equal(unitLabel('שן', 2), 'שיני');
  assert.equal(unitLabel('כוס', 1), 'כוס');
  assert.deepEqual(parseIngredientLine(`2 ${unitLabel('כף', 2)} שמן זית`), { name: 'שמן זית', qty: 2, unit: 'כף', always_have: false });
});

test('a product the plan creates lands on a sensible shelf', () => {
  assert.equal(guessAisle('עגבניות'), 'פירות וירקות');
  assert.equal(guessAisle('בשר טחון'), 'בשר ודגים');
  assert.equal(guessAisle('שמנת'), 'חלב וביצים');
  assert.equal(guessAisle('רסק עגבניות'), 'יבשים ושימורים');
  assert.equal(guessAisle('נייר אפייה'), 'כללי');
});
