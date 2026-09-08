import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { useSession } from '../../lib/session.js';
import { ErrorNote, Spinner, useAsync } from '../../ui/kit.js';
import { TopBar } from '../../ui/TopBar.js';
import { formatILS, monthKey } from '@shared/money.js';
import type { BalanceBetweenUs, BudgetMonth, Product, RecurringBill, ShoppingItem } from '@shared/types.js';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'לילה טוב';
  if (hour < 11) return 'בוקר טוב';
  if (hour < 17) return 'צהריים טובים';
  if (hour < 21) return 'ערב טוב';
  return 'לילה טוב';
}

interface ExpiringEntry { product_name: string; days_left: number; unit: string; qty: number }

/**
 * What needs attention today, and nothing else.
 *
 * The temptation on a home dashboard is to show everything the system knows —
 * six charts, twelve totals — and the result is a screen that is glanced at
 * once and then skipped forever. Every card here answers a question with a
 * verb attached: something to buy, something to use before it turns, something
 * to pay, someone to pay back. A card with nothing to say does not render.
 */
export function HomeScreen() {
  const { user } = useSession();
  const month = monthKey(new Date());

  const budget = useAsync(() => api.get<BudgetMonth>('/money/budget', { month }));
  const shopping = useAsync(() => api.get<ShoppingItem[]>('/shopping/items', { status: 'open' }));
  const expiring = useAsync(() => api.get<ExpiringEntry[]>('/pantry/expiring', { days: 5 }));
  const bills = useAsync(() => api.get<RecurringBill[]>('/money/bills'));
  const balance = useAsync(() => api.get<BalanceBetweenUs>('/money/balance'));
  const low = useAsync(() => api.get<Product[]>('/pantry/products', { below_min: '1' }));

  const loading = budget.loading && shopping.loading && expiring.loading;
  const soonBills = (bills.data ?? []).filter((b) => {
    if (!b.active || b.autopay) return false;
    const days = Math.round((new Date(b.next_due).getTime() - Date.now()) / 86_400_000);
    return days <= b.remind_days;
  });

  const names = new Map((balance.data?.per_person ?? []).map((p) => [p.email, p.display_name]));

  // "Nothing to report" and "we could not find out" are different answers, and
  // this screen used to give the first one for both: every `?? 0` reads a failed
  // panel as an empty one, so a totally broken dashboard announced that the
  // house was calm. A screen that reassures you when it is blind is worse than
  // one that admits it is blind.
  const failure = budget.error ?? shopping.error ?? expiring.error ?? bills.error ?? balance.error ?? low.error;
  const reloadAll = () => {
    budget.reload(); shopping.reload(); expiring.reload();
    bills.reload(); balance.reload(); low.reload();
  };

  const quiet = !loading && !failure
    && (shopping.data?.length ?? 0) === 0
    && (expiring.data?.length ?? 0) === 0
    && soonBills.length === 0
    && (balance.data?.amount ?? 0) === 0;

  return (
    <>
      <TopBar title={`${greeting()}${user?.display_name ? `, ${user.display_name}` : ''}`} subtitle="מה קורה בבית" />

      <div className="page">
        {loading && <Spinner />}
        {failure && <ErrorNote message={failure} onRetry={reloadAll} />}

        {budget.data && (
          <Link to="/budget" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
            <div
              className="card card-pad"
              style={{
                textAlign: 'center',
                background: budget.data.to_be_budgeted < 0 ? 'var(--bad-soft)' : 'var(--sage-soft)',
                borderColor: budget.data.to_be_budgeted < 0 ? 'var(--bad)' : 'var(--sage)',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 500, color: budget.data.to_be_budgeted < 0 ? 'var(--bad)' : 'var(--sage)' }}>
                {budget.data.to_be_budgeted < 0 ? 'הקצינו יותר ממה שנכנס' : 'ממתין לייעוד'}
              </div>
              <div
                className="num"
                style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-.02em', color: budget.data.to_be_budgeted < 0 ? 'var(--bad)' : 'var(--sage)' }}
              >
                {formatILS(budget.data.to_be_budgeted)}
              </div>
              <div className="meta" style={{ marginTop: 4 }}>
                הוצאנו החודש <span className="num">{formatILS(budget.data.spent)}</span>
              </div>
            </div>
          </Link>
        )}

        {quiet && (
          <div className="card card-pad" style={{ marginTop: 12, textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 6 }}>🌿</div>
            <strong>הכול רגוע.</strong>
            <p className="muted" style={{ fontSize: 14, marginTop: 4 }}>אין מה לקנות, אין מה לשלם, ואף אחד לא חייב לאף אחד.</p>
          </div>
        )}

        {(shopping.data?.length ?? 0) > 0 && (
          <Card
            to="/shopping"
            glyph="🛒"
            title={`${shopping.data?.length} פריטים לקנות`}
            body={(shopping.data ?? []).slice(0, 4).map((i) => i.name).join(' · ')}
            note={(low.data?.length ?? 0) > 0 ? `${low.data?.length} מהם נגמרו במזווה` : undefined}
          />
        )}

        {(expiring.data?.length ?? 0) > 0 && (
          <Card
            to="/pantry"
            glyph="⏳"
            title="להשתמש לפני שיתקלקל"
            tone="warn"
            body={(expiring.data ?? []).slice(0, 4).map((e) =>
              `${e.product_name} (${e.days_left <= 0 ? 'היום' : `${e.days_left} ימים`})`).join(' · ')}
          />
        )}

        {soonBills.length > 0 && (
          <Card
            to="/budget"
            glyph="💳"
            title="חשבונות שמגיעים"
            tone="warn"
            body={soonBills.map((b) => `${b.name}${b.amount_estimate ? ` — ${formatILS(b.amount_estimate)}` : ''}`).join(' · ')}
          />
        )}

        {balance.data && balance.data.amount > 0 && (
          <Card
            to="/transactions"
            glyph="⚖️"
            title={`${names.get(balance.data.from_email ?? '') ?? ''} חייב ל${names.get(balance.data.to_email ?? '') ?? ''} ${formatILS(balance.data.amount)}`}
            body="לחצו כדי לסגור את החשבון"
          />
        )}
      </div>
    </>
  );
}

function Card({ to, glyph, title, body, note, tone }: {
  to: string; glyph: string; title: string; body?: string; note?: string; tone?: 'warn';
}) {
  return (
    <Link to={to} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
      <div className="card card-pad" style={{ marginTop: 12, borderColor: tone === 'warn' ? 'var(--warn)' : undefined }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <span aria-hidden="true" style={{ fontSize: 22 }}>{glyph}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{title}</div>
            {body && <div className="meta" style={{ marginTop: 3 }}>{body}</div>}
            {note && <div className="pill warn" style={{ marginTop: 8 }}>{note}</div>}
          </div>
          <span aria-hidden="true" className="muted">‹</span>
        </div>
      </div>
    </Link>
  );
}
