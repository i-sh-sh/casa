// GENERATED FROM db/schema.sql — do not edit by hand.
// Run `npm run schema:build` after changing the .sql file.
//
// It exists because a Vercel function only bundles what it statically
// references: reading the .sql at runtime deploys fine and then fails with
// ENOENT on the one request that is supposed to repair the database.

export const SCHEMA_SQL = `-- casa — the whole schema, in one idempotent file.
--
-- Every statement here is safe to run again. That is not a style preference:
-- the migration is a button in the app, pressed by a person who is not going
-- to reason about which half already ran. \`CREATE TABLE IF NOT EXISTS\` plus
-- \`ADD COLUMN IF NOT EXISTS\` means the answer to "did I already press it?" is
-- always "press it again".
--
-- Money is NUMERIC(12,2), never float. 0.1 + 0.2 must equal 0.30 in a budget.
-- Dates that mean "a day" are DATE; moments are TIMESTAMPTZ.

-- ─────────────────────────────────────────────────────────────────────────
-- People
-- ─────────────────────────────────────────────────────────────────────────
--
-- A person, not a member. Identity lives here; belonging lives in
-- \`household_members\`, near the bottom of this file.
--
-- This table once carried \`role\`, when there was exactly one home in the
-- database. That column is left in place because the migration reads it to
-- build the first membership, and because dropping a column is the one
-- migration step that cannot be undone by re-running the file. **Nothing in
-- the application reads users.role any more** — the authoritative role is
-- \`household_members.role\`, and it is per-home.

CREATE TABLE IF NOT EXISTS users (
  email         TEXT PRIMARY KEY,
  name          TEXT,
  picture       TEXT,
  role          TEXT NOT NULL DEFAULT 'pending'
                CHECK (role IN ('owner', 'member', 'viewer', 'pending')),
  display_name  TEXT,                      -- what we call each other, not what Google calls us
  color         TEXT,                       -- for avatars and split bars
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ
);

-- ─────────────────────────────────────────────────────────────────────────
-- Money — envelope budgeting (the YNAB model)
-- ─────────────────────────────────────────────────────────────────────────
--
-- The whole point of the envelope model is that it answers a different
-- question than a bank app. A bank app answers "how much do I have?"; an
-- envelope answers "how much may I still spend on THIS?" — and that is the
-- question that actually changes behaviour at the till.
--
-- The rule the schema commits to: every shekel gets a job before it is spent.
-- \`budget_allocations\` is that job. \`transactions\` is what happened.

CREATE TABLE IF NOT EXISTS accounts (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'bank'
                   CHECK (kind IN ('bank', 'cash', 'credit', 'savings')),
  currency         TEXT NOT NULL DEFAULT 'ILS',
  -- Where the account stood the day we started tracking. Balance is this plus
  -- every transaction since; we never store a running balance, because a
  -- stored balance and a transaction list drift, and then neither is trusted.
  opening_balance  NUMERIC(12,2) NOT NULL DEFAULT 0,
  color            TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  archived_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS category_groups (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS categories (
  id              SERIAL PRIMARY KEY,
  group_id        INTEGER REFERENCES category_groups(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'spending'
                  CHECK (kind IN ('spending', 'income', 'saving')),
  -- How much control we have over this expense, which is a different axis
  -- from \`kind\` and the more useful one. \`kind\` says what an amount is;
  -- \`commitment\` says what could be done about it — the only question worth
  -- asking when a month does not add up. "Spend less" is not advice; "of your
  -- ₪9,700, ₪3,570 is rigid and ₪1,450 is liquid" is.
  commitment      TEXT NOT NULL DEFAULT 'flexible'
                  CHECK (commitment IN ('rigid', 'flexible', 'liquid', 'unplanned')),
  -- What we normally intend to put here each month. Used to pre-fill a new
  -- month in one click; it is a suggestion, never an allocation on its own.
  monthly_target  NUMERIC(12,2),
  icon            TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS categories_unique_name
  ON categories (COALESCE(group_id, -1), lower(name));

-- One row per (month, category). \`month\` is always the first of the month:
-- storing the whole date and agreeing to only ever write day 1 would invite a
-- day-15 row that silently splits an envelope in two, so the CHECK enforces it.
CREATE TABLE IF NOT EXISTS budget_allocations (
  id           SERIAL PRIMARY KEY,
  month        DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  allocated    NUMERIC(12,2) NOT NULL DEFAULT 0,
  note         TEXT,
  updated_by   TEXT REFERENCES users(email) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (month, category_id)
);

-- Sign convention, chosen once and never negotiated again:
--   amount < 0  → money left the household (a spend)
--   amount > 0  → money arrived (income, refund)
-- Storing spends as positives with a separate \`type\` column is the same data
-- with an extra way to get it wrong: every SUM would need the type joined in,
-- and the first query that forgets is a budget that reads twice as healthy as
-- it is.
CREATE TABLE IF NOT EXISTS transactions (
  id            SERIAL PRIMARY KEY,
  occurred_on   DATE NOT NULL,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  amount        NUMERIC(12,2) NOT NULL CHECK (amount <> 0),
  payee         TEXT NOT NULL DEFAULT '',
  note          TEXT,

  -- Who actually paid, which is not the same as who entered it. This is the
  -- entire Splitwise half of the module: without it we know what the household
  -- spent and nothing about who is owed.
  paid_by       TEXT REFERENCES users(email) ON DELETE SET NULL,
  -- 'shared' counts toward the balance between us; 'personal' never does.
  split         TEXT NOT NULL DEFAULT 'shared'
                CHECK (split IN ('shared', 'personal')),

  -- Two rows, one movement. A transfer between our own accounts is not a
  -- spend, and giving it a category would make it one.
  transfer_id   TEXT,
  recurring_id  INTEGER,

  created_by    TEXT REFERENCES users(email) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Soft delete: a deleted transaction still has to be explainable next month
  -- when the envelope does not add up.
  deleted_at    TIMESTAMPTZ,

  CHECK (transfer_id IS NULL OR category_id IS NULL)
);

-- A plain column index, and not \`date_trunc('month', occurred_on)\`.
--
-- That expression index looked clever and could not be created at all:
-- there is no date_trunc(text, date), so Postgres promotes the argument to
-- TIMESTAMPTZ — the preferred datetime type — and that overload is STABLE,
-- not IMMUTABLE, because its answer depends on the session time zone. An
-- index expression must be IMMUTABLE, so the statement failed with 42P17 and
-- took the rest of the migration down with it: every table from
-- recurring_bills onward was silently never created.
--
-- It was also unnecessary. Every query here asks for a half-open range
-- (\`occurred_on >= $1 AND occurred_on < $1 + interval '1 month'\`), which a
-- btree on the bare column serves perfectly — and which also serves the
-- date ranges that are not month-aligned.
CREATE INDEX IF NOT EXISTS transactions_occurred_on
  ON transactions (occurred_on) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS transactions_category
  ON transactions (category_id, occurred_on) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS transactions_account
  ON transactions (account_id, occurred_on) WHERE deleted_at IS NULL;

-- The bills that arrive whether or not anyone remembers them: ארנונה, חשמל,
-- ועד בית, ביטוח, מנויים. Their value is not the record — it is the warning
-- five days out, and knowing how much of next month is already spoken for.
CREATE TABLE IF NOT EXISTS recurring_bills (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  category_id      INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  account_id       INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  amount_estimate  NUMERIC(12,2) NOT NULL DEFAULT 0,
  cadence          TEXT NOT NULL DEFAULT 'monthly'
                   CHECK (cadence IN ('monthly', 'bimonthly', 'quarterly', 'yearly')),
  next_due         DATE NOT NULL,
  autopay          BOOLEAN NOT NULL DEFAULT FALSE,
  remind_days      INTEGER NOT NULL DEFAULT 3,
  note             TEXT,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "העברתי לך 300 על הסופר." Without this the balance between us only ever
-- grows, because paying each other back would otherwise look like a new spend.
CREATE TABLE IF NOT EXISTS settlements (
  id           SERIAL PRIMARY KEY,
  occurred_on  DATE NOT NULL DEFAULT CURRENT_DATE,
  from_email   TEXT NOT NULL REFERENCES users(email) ON DELETE RESTRICT,
  to_email     TEXT NOT NULL REFERENCES users(email) ON DELETE RESTRICT,
  amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  note         TEXT,
  created_by   TEXT REFERENCES users(email) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (from_email <> to_email)
);

-- ─────────────────────────────────────────────────────────────────────────
-- Pantry — stock that knows when it is running out (the Grocy model)
-- ─────────────────────────────────────────────────────────────────────────
--
-- A shopping list you have to remember to write is a shopping list you forget.
-- The product carries \`min_qty\`; when stock drops under it the list writes
-- itself. That single rule is most of what makes Grocy worth running.

CREATE TABLE IF NOT EXISTS products (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  -- Normalised name: "חלב 3%" and "חלב  3%" are one product. Uniqueness lives
  -- here rather than on \`name\` so the display name stays human.
  name_key          TEXT NOT NULL UNIQUE,
  unit              TEXT NOT NULL DEFAULT 'יח׳',
  category          TEXT NOT NULL DEFAULT 'כללי',   -- the aisle, for sorting the list
  min_qty           NUMERIC(10,2) NOT NULL DEFAULT 0,
  default_location  TEXT NOT NULL DEFAULT 'מזווה'
                    CHECK (default_location IN ('מזווה', 'מקרר', 'מקפיא', 'אמבטיה', 'ניקיון', 'אחר')),
  shelf_life_days   INTEGER,                        -- pre-fills expiry when stocking
  barcode           TEXT,
  note              TEXT,
  archived_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS products_category ON products (category) WHERE archived_at IS NULL;

-- One row per batch, not per product — because two cartons of milk bought a
-- week apart expire a week apart, and a single \`qty\` column on \`products\`
-- cannot say that. Quantity of a product is the SUM of its open entries.
CREATE TABLE IF NOT EXISTS stock_entries (
  id            SERIAL PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty           NUMERIC(10,2) NOT NULL CHECK (qty >= 0),
  location      TEXT NOT NULL DEFAULT 'מזווה',
  expires_on    DATE,
  opened_on     DATE,
  price         NUMERIC(10,2),
  purchased_on  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by    TEXT REFERENCES users(email) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stock_entries_product ON stock_entries (product_id) WHERE qty > 0;
CREATE INDEX IF NOT EXISTS stock_entries_expiry  ON stock_entries (expires_on) WHERE qty > 0;

-- Why the stock changed. Answers "we bought milk on Sunday, where did it go" —
-- and it is the only place a consumption history can come from later.
CREATE TABLE IF NOT EXISTS stock_log (
  id          BIGSERIAL PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  entry_id    INTEGER REFERENCES stock_entries(id) ON DELETE SET NULL,
  action      TEXT NOT NULL
              CHECK (action IN ('add', 'consume', 'open', 'discard', 'correct')),
  qty_delta   NUMERIC(10,2) NOT NULL,
  note        TEXT,
  actor       TEXT REFERENCES users(email) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stock_log_product ON stock_log (product_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- Shopping list
-- ─────────────────────────────────────────────────────────────────────────
--
-- An item may or may not be a known product. "לחם" that we track has a
-- product_id and feeds the pantry when bought; "סוללות AA" typed once at the
-- door does not, and forcing it to would make adding things slower than a
-- note app — which is how shared lists die.

CREATE TABLE IF NOT EXISTS shopping_items (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL,
  product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  qty         NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit        TEXT NOT NULL DEFAULT 'יח׳',
  category    TEXT NOT NULL DEFAULT 'כללי',
  note        TEXT,
  -- 'auto_min_stock' rows were written by the system, not by us. Keeping the
  -- source means the list can explain itself ("נוסף כי נגמר החלב") instead of
  -- appearing to have opinions of its own.
  source      TEXT NOT NULL DEFAULT 'manual'
              CHECK (source IN ('manual', 'auto_min_stock', 'recipe')),
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'bought', 'removed')),
  added_by    TEXT REFERENCES users(email) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  bought_at   TIMESTAMPTZ,
  bought_by   TEXT REFERENCES users(email) ON DELETE SET NULL
);

-- At most one OPEN row per product. Without this the auto-generator adds milk
-- again every night until someone shops, and the list becomes noise.
CREATE UNIQUE INDEX IF NOT EXISTS shopping_items_one_open_per_product
  ON shopping_items (product_id) WHERE status = 'open' AND product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shopping_items_one_open_per_name
  ON shopping_items (name_key) WHERE status = 'open' AND product_id IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- Notifications
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_email  TEXT REFERENCES users(email) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency for anything the daily cron sends: one "החלב נגמר" per day per
-- subject, however many times the cron is retried or manually poked.
CREATE TABLE IF NOT EXISTS sent_notifications (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  sent_on     DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kind, subject_key, sent_on)
);

-- ─────────────────────────────────────────────────────────────────────────
-- Columns added after the first deploy
-- ─────────────────────────────────────────────────────────────────────────
--
-- CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
-- a column added to a definition above never reaches a live database. That is
-- the failure this section exists to prevent, and it is a quiet one: the code
-- ships expecting a column, the migration reports success, and every query
-- touching it fails with 42703.
--
-- So every column added after the first deploy is repeated here as an
-- ADD COLUMN IF NOT EXISTS. Duplicating the definition is the price; the
-- alternative is a schema that is only correct on a database nobody has.

ALTER TABLE categories ADD COLUMN IF NOT EXISTS commitment TEXT NOT NULL DEFAULT 'flexible';

-- ─────────────────────────────────────────────────────────────────────────
-- Households — more than one home in one database
-- ─────────────────────────────────────────────────────────────────────────
--
-- The comment at the top of this file said there would deliberately never be a
-- household_id, because we were two. That was right until other couples asked
-- to use it. This section replaces that decision, and it is written to be the
-- *only* place isolation is decided.
--
-- The rule: **a query that forgets to filter by household must not leak.**
-- App-level scoping cannot promise that — it asks forty query sites to
-- remember, and the one that forgets is somebody else's salary on screen. So
-- the isolation lives in Postgres:
--
--   · every tenant table carries household_id, NOT NULL;
--   · its DEFAULT is the current household, so an INSERT never names it;
--   · ROW LEVEL SECURITY, FORCED, hides every other household's rows.
--
-- The current household is a transaction-local setting, \`casa.household_id\`,
-- set once per request in api/_lib/db.ts. When it is unset the policy compares
-- against NULL, which is never true — so an unscoped connection sees nothing
-- and can write nothing. Fail-closed in both directions, which is the only
-- acceptable default when the failure mode is one couple reading another's
-- money.
--
-- \`households\`, \`household_members\` and \`household_invites\` themselves are NOT
-- under RLS: answering "which homes does this person belong to" is precisely
-- the question asked *before* a household is known. Those three tables are
-- read from one file (api/_lib/auth.ts) and nowhere else.

CREATE TABLE IF NOT EXISTS households (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  created_by  TEXT REFERENCES users(email) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The role lives here, not on \`users\`: it is a property of a person *in a
-- home*, not of the person. The same email can be an owner of one and a viewer
-- of another, and on the day someone leaves a household their role there ends
-- without touching who they are.
CREATE TABLE IF NOT EXISTS household_members (
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  email         TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member'
                CHECK (role IN ('owner', 'member', 'viewer', 'pending')),
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (household_id, email)
);

CREATE INDEX IF NOT EXISTS household_members_email ON household_members (email);

-- An invitation is a one-time token, not an email address on a list. Inviting
-- by address means guessing which of a person's three Google accounts they
-- will actually use; a link they open while signed in cannot be guessed wrong.
CREATE TABLE IF NOT EXISTS household_invites (
  token         TEXT PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'viewer')),
  created_by    TEXT REFERENCES users(email) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  accepted_at   TIMESTAMPTZ,
  accepted_by   TEXT REFERENCES users(email) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS household_invites_household ON household_invites (household_id);

DO $$
DECLARE
  tenant_table TEXT;
  home         INTEGER;
  has_null     BOOLEAN;
  -- Every table holding data that belongs to one home. \`users\` is absent on
  -- purpose: a person is not owned by a household. \`push_subscriptions\` is
  -- absent too — a subscription belongs to a device, and it reaches the right
  -- home through the member who owns it.
  tenant_tables TEXT[] := ARRAY[
    'accounts', 'category_groups', 'categories', 'budget_allocations',
    'transactions', 'recurring_bills', 'settlements',
    'products', 'stock_entries', 'stock_log', 'shopping_items',
    'sent_notifications'
  ];
  scope_expr TEXT := 'nullif(current_setting(''casa.household_id'', true), '''')::int';
BEGIN
  -- The home everything that already exists belongs to.
  --
  -- Only ever created once, and only on a database that already has people in
  -- it: on a fresh database there is nothing to adopt, and the first person to
  -- sign in opens their own home instead (see api/_lib/auth.ts).
  SELECT id INTO home FROM households ORDER BY id LIMIT 1;

  IF home IS NULL AND EXISTS (SELECT 1 FROM users) THEN
    INSERT INTO households (name, created_by)
      VALUES (
        'הבית שלנו',
        (SELECT email FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1)
      )
      RETURNING id INTO home;

    -- Roles move from \`users\` to the membership, unchanged.
    INSERT INTO household_members (household_id, email, role)
      SELECT home, email, role FROM users
      ON CONFLICT (household_id, email) DO NOTHING;
  END IF;

  FOREACH tenant_table IN ARRAY tenant_tables LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS household_id INTEGER
         REFERENCES households(id) ON DELETE CASCADE', tenant_table);

    -- Adopt existing rows. On a re-run this updates nothing: either the column
    -- is already filled, or row-level security is already on and hides the rows
    -- from an unscoped connection — which is the same answer.
    IF home IS NOT NULL THEN
      EXECUTE format('UPDATE %I SET household_id = %L WHERE household_id IS NULL',
                     tenant_table, home);
    END IF;

    -- The default is what removes household_id from forty INSERT statements.
    -- Without it every insert site would have to name the column, and the one
    -- that forgot would fail — loudly, but only in production.
    EXECUTE format('ALTER TABLE %I ALTER COLUMN household_id SET DEFAULT %s',
                   tenant_table, scope_expr);

    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE household_id IS NULL)',
                   tenant_table) INTO has_null;
    IF NOT has_null THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN household_id SET NOT NULL', tenant_table);
    END IF;

    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (household_id)',
                   tenant_table || '_household', tenant_table);

    -- FORCE matters as much as ENABLE. Without it the role that owns the
    -- tables — which is the role this app connects as — bypasses every policy,
    -- and the isolation would be decoration.
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('DROP POLICY IF EXISTS casa_household_isolation ON %I', tenant_table);
    EXECUTE format(
      'CREATE POLICY casa_household_isolation ON %I
         USING (household_id = %s) WITH CHECK (household_id = %s)',
      tenant_table, scope_expr, scope_expr);
  END LOOP;
END $$;

-- Uniqueness that was global has to become per-home, or the second household
-- cannot have a category called «סופר» — and the failure would read as a
-- mysterious duplicate-key error rather than as a missing tenant column.
DO $$
BEGIN
  ALTER TABLE category_groups DROP CONSTRAINT IF EXISTS category_groups_name_key;
  ALTER TABLE products DROP CONSTRAINT IF EXISTS products_name_key_key;
  ALTER TABLE sent_notifications DROP CONSTRAINT IF EXISTS sent_notifications_kind_subject_key_sent_on_key;
END $$;

DROP INDEX IF EXISTS categories_unique_name;
DROP INDEX IF EXISTS shopping_items_one_open_per_name;

CREATE UNIQUE INDEX IF NOT EXISTS category_groups_unique_name
  ON category_groups (household_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS categories_unique_name
  ON categories (household_id, COALESCE(group_id, -1), lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS products_unique_name_key
  ON products (household_id, name_key);
CREATE UNIQUE INDEX IF NOT EXISTS shopping_items_one_open_per_name
  ON shopping_items (household_id, name_key) WHERE status = 'open' AND product_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sent_notifications_once
  ON sent_notifications (household_id, kind, subject_key, sent_on);

DO $$
BEGIN
  -- A CHECK cannot be added with IF NOT EXISTS, and re-adding one that is
  -- already there is an error — which would abort the whole migration, exactly
  -- the way a bad index expression once did.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'categories_commitment_check'
  ) THEN
    ALTER TABLE categories ADD CONSTRAINT categories_commitment_check
      CHECK (commitment IN ('rigid', 'flexible', 'liquid', 'unplanned'));
  END IF;
END $$;
`;
