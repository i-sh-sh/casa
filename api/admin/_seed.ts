// The first screen, pre-filled.
//
// An empty budget is not a blank canvas — it is homework. Nobody defines
// seventeen categories before recording their first coffee, so the app defines
// them and lets us disagree. Everything here is renameable and archivable; the
// only thing it costs to be wrong is one edit.
//
// The list is deliberately Israeli-household-shaped: ארנונה and ועד בית are
// not line items in any template you can download, and they are two of the
// four bills that actually arrive.
//
// `monthly_target` is what the category usually gets. It is what makes the
// "מלא את החודש" button meaningful on day one; nothing is allocated from it
// until somebody presses that.
//
// `icon` is not seeded at all. It used to carry an emoji per category, and
// both halves of that were wrong: an icon that repeats the word beside it is
// decoration, and an emoji is font-dependent, unstyleable, and the clearest
// single signal that nobody chose it. The column stays in the schema and the
// UI draws nothing from it. See docs/DESIGN.md §6.
//
// Leaving it out of the INSERT is also the safe form: a VALUES column that is
// NULL in every row gives Postgres nothing to infer a type from, and the
// statement fails with "could not determine data type".

export const SEED_SQL = `
INSERT INTO category_groups (name, sort_order) VALUES
  ('קבועות', 0), ('יומיום', 1), ('הבית', 2), ('אישי', 3), ('בריאות', 4), ('חיסכון', 5), ('הכנסות', 6)
ON CONFLICT (name) DO NOTHING;

INSERT INTO categories (group_id, name, kind, monthly_target, sort_order)
SELECT g.id, v.name, v.kind, v.target, v.ord
  FROM (VALUES
    ('קבועות', 'שכר דירה / משכנתא', 'spending', 5000, 0),
    ('קבועות', 'ארנונה',            'spending', 400, 1),
    ('קבועות', 'ועד בית',           'spending', 150, 2),
    ('קבועות', 'חשמל',              'spending', 300, 3),
    ('קבועות', 'מים',               'spending', 120, 4),
    ('קבועות', 'גז',                'spending', 80, 5),
    ('קבועות', 'אינטרנט וטלוויזיה', 'spending', 180, 6),
    ('קבועות', 'סלולר',             'spending', 100, 7),
    ('קבועות', 'ביטוחים',           'spending', 400, 8),

    ('יומיום', 'סופר',              'spending', 2000, 0),
    ('יומיום', 'קפה ומסעדות',       'spending', 600, 1),
    ('יומיום', 'דלק ותחבורה',       'spending', 700, 2),
    ('יומיום', 'פארמה',             'spending', 150, 3),

    ('הבית',   'ריהוט וציוד',       'spending', 300, 0),
    ('הבית',   'תיקונים ותחזוקה',   'spending', 200, 1),
    ('הבית',   'ניקיון',            'spending', 120, 2),

    ('אישי',   'ביגוד',             'spending', 300, 0),
    ('אישי',   'תרבות ופנאי',       'spending', 250, 1),
    ('אישי',   'מתנות',             'spending', 200, 2),
    ('אישי',   'ספורט',             'spending', 200, 3),

    ('בריאות', 'קופת חולים',        'spending', 200, 0),
    ('בריאות', 'שיניים',            'spending', 150, 1),

    ('חיסכון', 'קרן חירום',         'saving', 1000, 0),
    ('חיסכון', 'חופשה',             'saving', 500, 1),
    ('חיסכון', 'רכב',               'saving', 400, 2),

    ('הכנסות', 'משכורת',            'income', NULL, 0),
    ('הכנסות', 'הכנסה אחרת',        'income', NULL, 1)
  ) AS v(grp, name, kind, target, ord)
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
ON CONFLICT (name_key) DO NOTHING;
`;
