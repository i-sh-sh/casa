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
// `commitment` is not seeded either, and the ladder that read it is gone from
// the app. `icon` was dropped for its own reason: an icon that repeats the
// word beside it is decoration, and an emoji is font-dependent, unstyleable,
// and the clearest single signal that nobody chose it. See docs/DESIGN.md §6.
//
// Leaving a column out of the INSERT is also the safe form: a VALUES column
// that is NULL in every row gives Postgres nothing to infer a type from, and
// the statement fails with "could not determine data type".

export const SEED_SQL = `
INSERT INTO category_groups (name, sort_order) VALUES
  ('קבועות', 0), ('יומיום', 1), ('הבית', 2), ('אישי', 3), ('בריאות', 4),
  ('חיסכון', 5), ('לא צפויות', 6), ('הכנסות', 7)
ON CONFLICT (household_id, lower(name)) DO NOTHING;

INSERT INTO categories (group_id, name, kind, sort_order)
SELECT g.id, v.name, v.kind, v.ord
  FROM (VALUES
    ('קבועות', 'שכר דירה / משכנתא', 'spending', 0),
    ('קבועות', 'ארנונה', 'spending', 1),
    ('קבועות', 'ועד בית', 'spending', 2),
    ('קבועות', 'חשמל', 'spending', 3),
    ('קבועות', 'מים', 'spending', 4),
    ('קבועות', 'גז', 'spending', 5),
    ('קבועות', 'אינטרנט וטלוויזיה', 'spending', 6),
    ('קבועות', 'סלולר', 'spending', 7),
    ('קבועות', 'ביטוחים', 'spending', 8),

    ('יומיום', 'סופר', 'spending', 0),
    ('יומיום', 'קפה ומסעדות', 'spending', 1),
    ('יומיום', 'דלק ותחבורה', 'spending', 2),
    ('יומיום', 'פארמה', 'spending', 3),

    ('הבית', 'ריהוט וציוד', 'spending', 0),
    ('הבית', 'תיקונים ותחזוקה', 'spending', 1),
    ('הבית', 'ניקיון', 'spending', 2),

    ('אישי', 'ביגוד', 'spending', 0),
    ('אישי', 'תרבות ופנאי', 'spending', 1),
    ('אישי', 'מתנות', 'spending', 2),
    ('אישי', 'ספורט', 'spending', 3),

    ('בריאות', 'קופת חולים', 'spending', 0),
    ('בריאות', 'שיניים', 'spending', 1),

    -- Savings are categories like any other, and the discipline is the same:
    -- an amount that only gets put aside when something is left over never
    -- gets put aside. The kind 'saving' marks them as not-an-expense; what
    -- goes into them each month is for the household to decide, exactly like
    -- everything else here.
    ('חיסכון', 'קרן חירום', 'saving', 0),
    ('חיסכון', 'חופשה', 'saving', 1),
    ('חיסכון', 'רכב', 'saving', 2),

    -- The category most budgets leave out, which is why most budgets break.
    -- A wedding, a dentist, a phone that shattered: never the same thing
    -- twice, and never actually a surprise that *something* happened.
    ('לא צפויות', 'בלת״מ', 'spending', 0),

    ('הכנסות', 'משכורת', 'income', 0),
    ('הכנסות', 'הכנסה אחרת', 'income', 1)
  ) AS v(grp, name, kind, ord)
  JOIN category_groups g ON g.name = v.grp
ON CONFLICT DO NOTHING;

-- Two accounts, because a household has at least one bank account and a wallet,
-- and a transaction cannot be recorded without one to hang it on.
INSERT INTO accounts (name, kind, sort_order) VALUES
  ('עובר ושב', 'bank', 0),
  ('מזומן',    'cash', 1)
ON CONFLICT DO NOTHING;

-- The pantry staples, with the minimum that puts them back on the list.
-- min_qty is the whole point: 0 means "we track it but never nag", and a
-- positive number means "when it drops under this, write it down for us".
INSERT INTO products (name, name_key, unit, category, min_qty, default_location, shelf_life_days) VALUES
  ('חלב',          'חלב',          'ליטר',  'חלב וביצים',      2, 'מקרר',  7),
  ('ביצים',        'ביצים',        'יח׳',   'חלב וביצים',     12, 'מקרר', 21),
  ('קוטג׳',        'קוטג',         'יח׳',   'חלב וביצים',      1, 'מקרר', 14),
  ('גבינה צהובה',  'גבינה צהובה',  'יח׳',   'חלב וביצים',      1, 'מקרר', 21),
  ('לחם',          'לחם',          'יח׳',   'לחם ומאפים',      1, 'מזווה', 4),
  ('אורז',         'אורז',         'ק״ג',   'יבשים ושימורים',  1, 'מזווה', NULL),
  ('פסטה',         'פסטה',         'חבילה', 'יבשים ושימורים',  2, 'מזווה', NULL),
  ('קמח',          'קמח',          'ק״ג',   'יבשים ושימורים',  1, 'מזווה', NULL),
  ('סוכר',         'סוכר',         'ק״ג',   'יבשים ושימורים',  1, 'מזווה', NULL),
  ('שמן זית',      'שמן זית',      'ליטר',  'יבשים ושימורים',  1, 'מזווה', NULL),
  ('טונה',         'טונה',         'יח׳',   'יבשים ושימורים',  3, 'מזווה', NULL),
  ('קפה',          'קפה',          'חבילה', 'יבשים ושימורים',  1, 'מזווה', NULL),
  ('נייר טואלט',   'נייר טואלט',   'גליל',  'טואלטיקה',        6, 'אמבטיה', NULL),
  ('סבון כלים',    'סבון כלים',    'יח׳',   'ניקיון',          1, 'ניקיון', NULL),
  ('אבקת כביסה',   'אבקת כביסה',   'יח׳',   'ניקיון',          1, 'ניקיון', NULL)
ON CONFLICT (household_id, name_key) DO NOTHING;
`;
