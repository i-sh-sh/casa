// The first screen, with the shelves labelled and nothing on them.
//
// An empty budget is not a blank canvas — it is homework. Nobody defines
// thirty categories before recording their first coffee, so the app names them
// and lets us disagree. Everything here is renameable and archivable; the only
// thing it costs to be wrong is one edit.
//
// The list is deliberately Israeli-household-shaped: ארנונה and ועד בית are
// not line items in any template you can download, and they are two of the
// four bills that actually arrive.
//
// **No amounts.** This file used to ship a `monthly_target` for every line —
// ₪5,000 for rent, ₪2,000 for the supermarket, ₪450 for the unforeseen — and a
// button that filled the month from them in one press. They were plausible and
// they were invented, and a household that presses the button once has a
// budget it never chose sitting in the same typeface as the figures it did.
// The structure is a suggestion worth making; the numbers never were.
//
// `commitment` **is** seeded, and that is not a contradiction of the line
// above. It is a classification, not a figure — it says what could be done
// about a category, and it moves no money anywhere. Naming שכירות as rigid is
// the same kind of suggestion as naming the category שכירות in the first
// place, and every one of them is changeable from the allocation sheet.
//
// `icon` was dropped for its own reason: an icon that repeats the word beside
// it is decoration, and an emoji is font-dependent, unstyleable, and the
// clearest single signal that nobody chose it. See docs/DESIGN.md §6.
//
// Leaving a column out of the INSERT is also the safe form: a VALUES column
// that is NULL in every row gives Postgres nothing to infer a type from, and
// the statement fails with "could not determine data type".

export const SEED_SQL = `
INSERT INTO category_groups (name, sort_order) VALUES
  ('קבועות', 0), ('יומיום', 1), ('הבית', 2), ('אישי', 3), ('בריאות', 4),
  ('חיסכון', 5), ('לא צפויות', 6), ('הכנסות', 7)
ON CONFLICT (household_id, lower(name)) DO NOTHING;

INSERT INTO categories (group_id, name, kind, commitment, sort_order)
SELECT g.id, v.name, v.kind, v.commitment, v.ord
  FROM (VALUES
    ('קבועות', 'שכר דירה / משכנתא', 'spending', 'rigid', 0),
    ('קבועות', 'ארנונה', 'spending', 'rigid', 1),
    ('קבועות', 'ועד בית', 'spending', 'rigid', 2),
    ('קבועות', 'חשמל', 'spending', 'flexible', 3),
    ('קבועות', 'מים', 'spending', 'flexible', 4),
    ('קבועות', 'גז', 'spending', 'flexible', 5),
    ('קבועות', 'אינטרנט וטלוויזיה', 'spending', 'rigid', 6),
    ('קבועות', 'סלולר', 'spending', 'rigid', 7),
    ('קבועות', 'ביטוחים', 'spending', 'rigid', 8),

    ('יומיום', 'סופר', 'spending', 'flexible', 0),
    ('יומיום', 'קפה ומסעדות', 'spending', 'liquid', 1),
    ('יומיום', 'דלק ותחבורה', 'spending', 'flexible', 2),
    ('יומיום', 'פארמה', 'spending', 'flexible', 3),

    ('הבית', 'ריהוט וציוד', 'spending', 'liquid', 0),
    ('הבית', 'תיקונים ותחזוקה', 'spending', 'flexible', 1),
    ('הבית', 'ניקיון', 'spending', 'flexible', 2),

    ('אישי', 'ביגוד', 'spending', 'liquid', 0),
    ('אישי', 'תרבות ופנאי', 'spending', 'liquid', 1),
    ('אישי', 'מתנות', 'spending', 'liquid', 2),
    ('אישי', 'ספורט', 'spending', 'liquid', 3),

    ('בריאות', 'קופת חולים', 'spending', 'rigid', 0),
    ('בריאות', 'שיניים', 'spending', 'flexible', 1),

    -- Savings are categories like any other, and the discipline is the same:
    -- an amount that only gets put aside when something is left over never
    -- gets put aside. The kind 'saving' marks them as not-an-expense; what
    -- goes into them each month is for the household to decide, exactly like
    -- everything else here.
    ('חיסכון', 'קרן חירום', 'saving', 'rigid', 0),
    ('חיסכון', 'חופשה', 'saving', 'liquid', 1),
    ('חיסכון', 'רכב', 'saving', 'rigid', 2),

    -- The category most budgets leave out, which is why most budgets break.
    -- A wedding, a dentist, a phone that shattered: never the same thing
    -- twice, and never actually a surprise that *something* happened.
    ('לא צפויות', 'בלת״מ', 'spending', 'unplanned', 0),

    ('הכנסות', 'משכורת', 'income', 'rigid', 0),
    ('הכנסות', 'הכנסה אחרת', 'income', 'flexible', 1)
  ) AS v(grp, name, kind, commitment, ord)
  JOIN category_groups g ON g.name = v.grp
ON CONFLICT DO NOTHING;

-- Two accounts, because a household has at least one bank account and a wallet,
-- and a transaction cannot be recorded without one to hang it on.
INSERT INTO accounts (name, kind, sort_order) VALUES
  ('עובר ושב', 'bank', 0),
  ('מזומן',    'cash', 1)
ON CONFLICT DO NOTHING;

-- The pantry staples, tracked but not yet nagging: min_qty 0.
-- A minimum on a product nobody has stocked means it is "below minimum" from
-- the first second, and the next stock sync or nightly cron put all fifteen on
-- the shopping list of a home that had not said it buys any of them. The
-- minimums each staple should get live in shared/pantry.ts (SUGGESTED_MIN),
-- and the home's setup checklist applies them to the ones it actually buys.
INSERT INTO products (name, name_key, unit, category, min_qty, default_location, shelf_life_days) VALUES
  ('חלב',          'חלב',          'ליטר',  'חלב וביצים',      0, 'מקרר',  7),
  ('ביצים',        'ביצים',        'יח׳',   'חלב וביצים',      0, 'מקרר', 21),
  ('קוטג׳',        'קוטג',         'יח׳',   'חלב וביצים',      0, 'מקרר', 14),
  ('גבינה צהובה',  'גבינה צהובה',  'יח׳',   'חלב וביצים',      0, 'מקרר', 21),
  ('לחם',          'לחם',          'יח׳',   'לחם ומאפים',      0, 'מזווה', 4),
  ('אורז',         'אורז',         'ק״ג',   'יבשים ושימורים',  0, 'מזווה', NULL),
  ('פסטה',         'פסטה',         'חבילה', 'יבשים ושימורים',  0, 'מזווה', NULL),
  ('קמח',          'קמח',          'ק״ג',   'יבשים ושימורים',  0, 'מזווה', NULL),
  ('סוכר',         'סוכר',         'ק״ג',   'יבשים ושימורים',  0, 'מזווה', NULL),
  ('שמן זית',      'שמן זית',      'ליטר',  'יבשים ושימורים',  0, 'מזווה', NULL),
  ('טונה',         'טונה',         'יח׳',   'יבשים ושימורים',  0, 'מזווה', NULL),
  ('קפה',          'קפה',          'חבילה', 'יבשים ושימורים',  0, 'מזווה', NULL),
  ('נייר טואלט',   'נייר טואלט',   'גליל',  'טואלטיקה',        0, 'אמבטיה', NULL),
  ('סבון כלים',    'סבון כלים',    'יח׳',   'ניקיון',          0, 'ניקיון', NULL),
  ('אבקת כביסה',   'אבקת כביסה',   'יח׳',   'ניקיון',          0, 'ניקיון', NULL)
ON CONFLICT (household_id, name_key) DO NOTHING;
`;
