/**
 * Test people, for the operator to walk through the app as after each release.
 *
 * Testing a household app properly needs more than one person and more than one
 * state: a stranger who has never seen it, a partner opening an invitation, a
 * couple two months in. Doing that with real Google accounts means keeping
 * three spare accounts and an incognito window per release, so in practice it
 * does not happen. These are those people, made from data.
 *
 * ## Why they cannot be anybody real
 *
 * Every address ends in `.invalid`, a top-level domain reserved by RFC 2606 so
 * that it never resolves. Google cannot issue an account there, so no Google
 * sign-in can ever arrive as one of these people, and no real person's account
 * can be reached through them. The step-in route (api/auth/[action].ts) takes a
 * persona *key* and looks the address up here; it never takes an address from
 * the request, so it can only ever produce one of the addresses below.
 *
 * Everything in this file is pure: the personas, and the populated home as rows
 * relative to a given day. api/admin/_testing.ts writes them.
 */

export const TEST_DOMAIN = 'casa.invalid';

export type PersonaKey = 'noa' | 'omer' | 'dana' | 'yoav';

export interface Persona {
  key: PersonaKey;
  email: string;
  display_name: string;
  /** What this person is for, said on the operator's screen. */
  purpose: string;
  /** The populated home they belong to, or null for someone who starts with none. */
  home: 'couple' | null;
  role: 'owner' | 'member' | null;
}

export const PERSONAS: readonly Persona[] = [
  {
    key: 'noa', email: `noa@${TEST_DOMAIN}`, display_name: 'נועה',
    purpose: 'נכנסת בפעם הראשונה, בלי בית. פותחת בית ומזמינה את עומר',
    home: null, role: null,
  },
  {
    key: 'omer', email: `omer@${TEST_DOMAIN}`, display_name: 'עומר',
    purpose: 'בלי בית. פותח את קישור ההזמנה של נועה',
    home: null, role: null,
  },
  {
    key: 'dana', email: `dana@${TEST_DOMAIN}`, display_name: 'דנה',
    purpose: 'בעלת בית עם חודשיים של נתונים: תקציב, תנועות, מזווה וקניות',
    home: 'couple', role: 'owner',
  },
  {
    key: 'yoav', email: `yoav@${TEST_DOMAIN}`, display_name: 'יואב',
    purpose: 'בן הזוג של דנה, חבר באותו בית',
    home: 'couple', role: 'member',
  },
];

export const COUPLE_HOME_NAME = 'הבית של דנה ויואב (בדיקה)';

export function isTestEmail(email: string | null | undefined): boolean {
  return !!email && email.trim().toLowerCase().endsWith(`@${TEST_DOMAIN}`);
}

export function personaByKey(key: unknown): Persona | null {
  return PERSONAS.find((p) => p.key === key) ?? null;
}

export function personaByEmail(email: string | null | undefined): Persona | null {
  if (!email) return null;
  const wanted = email.trim().toLowerCase();
  return PERSONAS.find((p) => p.email === wanted) ?? null;
}

// ── The populated home ───────────────────────────────────────────────────

/** `YYYY-MM-DD`, `days` before `today`. Calendar arithmetic, in UTC, so no DST skips a day. */
export function daysBefore(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** The first of the month `back` months before `today`'s. */
export function monthStart(today: string, back = 0): string {
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 10);
}

/** A day in the month `back` months ago, clamped so it never lands after `today`. */
function dayOf(today: string, back: number, day: number): string {
  const date = `${monthStart(today, back).slice(0, 8)}${String(day).padStart(2, '0')}`;
  return date > today ? today : date;
}

export interface FixtureAccount { name: string; kind: 'bank' | 'cash' | 'credit'; opening_balance: number }

export interface FixtureTransaction {
  occurred_on: string;
  account: string;
  /** A seeded category name, or null for a line the couple has not filed yet. */
  category: string | null;
  amount: number;
  payee: string;
  paid_by: PersonaKey;
  split: 'shared' | 'personal';
  installment_no?: number;
  installments_total?: number;
}

export interface FixtureStock { product: string; qty: number; expires_in_days: number | null; location: string }

export interface CoupleFixture {
  accounts: FixtureAccount[];
  /** Per month (first of the month), category name → amount. */
  allocations: { month: string; category: string; allocated: number }[];
  transactions: FixtureTransaction[];
  recurring: { name: string; category: string; account: string; amount_estimate: number; cadence: 'monthly' | 'bimonthly'; next_due: string }[];
  payee_rules: { payee: string; category: string }[];
  /** Product name_key → minimum, for the staples this couple actually buys. */
  minimums: Record<string, number>;
  stock: FixtureStock[];
  shopping: { name: string; qty: number; unit: string; category: string; added_by: PersonaKey }[];
  settlement: { occurred_on: string; from: PersonaKey; to: PersonaKey; amount: number; note: string };
}

/**
 * Two months of an ordinary couple, ending on `today`.
 *
 * Built from the seeded categories (api/admin/_seed.ts) so that what the
 * operator tests is the home a real couple would have after the same seed. It
 * deliberately includes the awkward cases that new screens tend to forget: a
 * line nobody filed, a purchase in installments, a personal expense, an
 * overspent envelope, something past its expiry and something about to be.
 */
export function coupleFixture(today: string): CoupleFixture {
  const BANK = 'עובר ושב';
  const DANA_CARD = 'ויזה של דנה';
  const YOAV_CARD = 'מקס של יואב';
  const CASH = 'מזומן';

  const allocationsFor = (month: string) => [
    ['שכר דירה / משכנתא', 5200], ['ארנונה', 340], ['ועד בית', 250], ['חשמל', 450],
    ['מים', 150], ['אינטרנט וטלוויזיה', 180], ['סלולר', 110], ['ביטוחים', 420],
    ['סופר', 2600], ['קפה ומסעדות', 600], ['דלק ותחבורה', 700], ['פארמה', 200],
    ['ניקיון', 150], ['ביגוד', 400], ['תרבות ופנאי', 350], ['מתנות', 300],
    ['קופת חולים', 260], ['קרן חירום', 1000], ['חופשה', 500], ['בלת״מ', 400],
  ].map(([category, allocated]) => ({ month, category: category as string, allocated: allocated as number }));

  const month = (back: number) => {
    const rows: [number, Omit<FixtureTransaction, 'occurred_on'>][] = [
      [1, { account: BANK, category: 'משכורת', amount: 14250, payee: 'משכורת — דנה', paid_by: 'dana', split: 'shared' }],
      [1, { account: BANK, category: 'משכורת', amount: 11800, payee: 'משכורת — יואב', paid_by: 'yoav', split: 'shared' }],
      [2, { account: BANK, category: 'שכר דירה / משכנתא', amount: -5200, payee: 'שכר דירה', paid_by: 'dana', split: 'shared' }],
      [3, { account: BANK, category: 'ועד בית', amount: -250, payee: 'ועד הבית', paid_by: 'yoav', split: 'shared' }],
      [4, { account: DANA_CARD, category: 'סופר', amount: -612.4, payee: 'שופרסל דיל', paid_by: 'dana', split: 'shared' }],
      [5, { account: YOAV_CARD, category: 'קפה ומסעדות', amount: -96, payee: 'ארומה', paid_by: 'yoav', split: 'shared' }],
      [6, { account: DANA_CARD, category: 'סלולר', amount: -109.9, payee: 'פלאפון', paid_by: 'dana', split: 'shared' }],
      [7, { account: YOAV_CARD, category: 'דלק ותחבורה', amount: -318.55, payee: 'פז', paid_by: 'yoav', split: 'shared' }],
      [9, { account: YOAV_CARD, category: 'סופר', amount: -487.2, payee: 'רמי לוי', paid_by: 'yoav', split: 'shared' }],
      [10, { account: DANA_CARD, category: 'אינטרנט וטלוויזיה', amount: -179.9, payee: 'בזק', paid_by: 'dana', split: 'shared' }],
      [11, { account: DANA_CARD, category: 'ביטוחים', amount: -418.3, payee: 'הראל ביטוח', paid_by: 'dana', split: 'shared' }],
      [12, { account: CASH, category: 'קפה ומסעדות', amount: -38, payee: 'קיוסק', paid_by: 'yoav', split: 'personal' }],
      [13, { account: DANA_CARD, category: 'פארמה', amount: -84.7, payee: 'סופר-פארם', paid_by: 'dana', split: 'shared' }],
      [15, { account: YOAV_CARD, category: 'קפה ומסעדות', amount: -342, payee: 'מסעדת הבית', paid_by: 'yoav', split: 'shared' }],
      [16, { account: DANA_CARD, category: 'סופר', amount: -734.85, payee: 'שופרסל דיל', paid_by: 'dana', split: 'shared' }],
      [18, { account: YOAV_CARD, category: 'דלק ותחבורה', amount: -290.1, payee: 'פז', paid_by: 'yoav', split: 'shared' }],
      [20, { account: DANA_CARD, category: 'קופת חולים', amount: -258, payee: 'מכבי שירותי בריאות', paid_by: 'dana', split: 'shared' }],
      [22, { account: YOAV_CARD, category: 'סופר', amount: -556.3, payee: 'רמי לוי', paid_by: 'yoav', split: 'shared' }],
      [24, { account: DANA_CARD, category: 'תרבות ופנאי', amount: -164, payee: 'סינמה סיטי', paid_by: 'dana', split: 'shared' }],
      [26, { account: DANA_CARD, category: 'ביגוד', amount: -249.9, payee: 'קסטרו', paid_by: 'dana', split: 'personal' }],
      [27, { account: BANK, category: 'קרן חירום', amount: -1000, payee: 'הפקדה לחיסכון', paid_by: 'dana', split: 'shared' }],
    ];
    // This month stops at today: a fixture with next week's supermarket in it
    // is a budget that cannot happen.
    const todayDay = Number(today.slice(8));
    return rows
      .filter(([day]) => back > 0 || day <= todayDay)
      .map(([day, row]) => ({ ...row, occurred_on: dayOf(today, back, day) }));
  };

  const transactions: FixtureTransaction[] = [
    ...month(1),
    ...month(0),
    // Bimonthly: once in the two months.
    { occurred_on: dayOf(today, 1, 14), account: BANK, category: 'ארנונה', amount: -684, payee: 'עיריית תל אביב', paid_by: 'dana', split: 'shared' },
    { occurred_on: dayOf(today, 1, 19), account: BANK, category: 'חשמל', amount: -512.6, payee: 'חברת החשמל', paid_by: 'yoav', split: 'shared' },
    // An overspent envelope: the gift budget is 300.
    { occurred_on: dayOf(today, 1, 21), account: YOAV_CARD, category: 'מתנות', amount: -480, payee: 'מתנה לחתונה', paid_by: 'yoav', split: 'shared' },
    // A purchase in installments, second of three charged this month.
    { occurred_on: dayOf(today, 1, 8), account: DANA_CARD, category: 'ריהוט וציוד', amount: -1299, payee: 'איקאה', paid_by: 'dana', split: 'shared', installment_no: 1, installments_total: 3 },
    { occurred_on: dayOf(today, 0, 8), account: DANA_CARD, category: 'ריהוט וציוד', amount: -1299, payee: 'איקאה', paid_by: 'dana', split: 'shared', installment_no: 2, installments_total: 3 },
    // Nobody has filed this one yet — the transactions screen should say so.
    { occurred_on: daysBefore(today, 1), account: YOAV_CARD, category: null, amount: -129.9, payee: 'עלי אקספרס', paid_by: 'yoav', split: 'shared' },
  ];

  const products: [string, number, number | null, string][] = [
    // name_key, qty, days to expiry, location
    ['חלב', 1, 3, 'מקרר'],
    ['ביצים', 10, 16, 'מקרר'],
    ['קוטג', 1, -2, 'מקרר'],        // past its date
    ['גבינה צהובה', 1, 12, 'מקרר'],
    ['לחם', 1, 1, 'מזווה'],         // about to go
    ['אורז', 2, null, 'מזווה'],
    ['פסטה', 1, null, 'מזווה'],
    ['קפה', 1, null, 'מזווה'],
    ['נייר טואלט', 4, null, 'אמבטיה'],
    ['סבון כלים', 1, null, 'ניקיון'],
  ];

  return {
    accounts: [
      { name: BANK, kind: 'bank', opening_balance: 18400 },
      { name: CASH, kind: 'cash', opening_balance: 300 },
      { name: DANA_CARD, kind: 'credit', opening_balance: 0 },
      { name: YOAV_CARD, kind: 'credit', opening_balance: 0 },
    ],
    allocations: [...allocationsFor(monthStart(today, 1)), ...allocationsFor(monthStart(today, 0))],
    transactions,
    recurring: [
      { name: 'שכר דירה', category: 'שכר דירה / משכנתא', account: BANK, amount_estimate: 5200, cadence: 'monthly', next_due: nextDay(today, 2) },
      { name: 'ועד בית', category: 'ועד בית', account: BANK, amount_estimate: 250, cadence: 'monthly', next_due: nextDay(today, 3) },
      { name: 'ארנונה', category: 'ארנונה', account: BANK, amount_estimate: 684, cadence: 'bimonthly', next_due: nextDay(today, 14) },
    ],
    payee_rules: [
      { payee: 'שופרסל דיל', category: 'סופר' },
      { payee: 'רמי לוי', category: 'סופר' },
      { payee: 'פז', category: 'דלק ותחבורה' },
      { payee: 'ארומה', category: 'קפה ומסעדות' },
    ],
    minimums: { 'חלב': 2, 'ביצים': 12, 'לחם': 1, 'קוטג': 1, 'קפה': 1, 'נייר טואלט': 6, 'סבון כלים': 1 },
    stock: products.map(([product, qty, expires_in_days, location]) => ({ product, qty, expires_in_days, location })),
    shopping: [
      { name: 'עגבניות', qty: 1, unit: 'ק״ג', category: 'פירות וירקות', added_by: 'dana' },
      { name: 'מלפפונים', qty: 1, unit: 'ק״ג', category: 'פירות וירקות', added_by: 'dana' },
      { name: 'שקיות זבל', qty: 1, unit: 'יח׳', category: 'ניקיון', added_by: 'yoav' },
    ],
    settlement: { occurred_on: dayOf(today, 1, 28), from: 'yoav', to: 'dana', amount: 850, note: 'השלמה לשכר דירה' },
  };
}

/** The first of next month's `day`, or this month's if it is still ahead. */
function nextDay(today: string, day: number): string {
  const here = `${today.slice(0, 8)}${String(day).padStart(2, '0')}`;
  if (here > today) return here;
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return `${d.toISOString().slice(0, 8)}${String(day).padStart(2, '0')}`;
}

/** Today's date in Israel, which is the calendar every screen in the app speaks. */
export function israelToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);
}
