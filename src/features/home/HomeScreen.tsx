import type { ReactNode } from 'react';
import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { useSession } from '../../lib/session.js';
import { ErrorNote, Loading, useAsync } from '../../ui/kit.js';
import { TopBar } from '../../ui/TopBar.js';
import { formatILS, monthKey } from '@shared/money.js';
import type { BudgetMonth, Product, RecurringBill, ShoppingItem } from '@shared/types.js';

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
 * A run of names, and an honest account of the ones left out.
 *
 * Five names is as much as one line of an entry can hold before it stops being
 * readable at a glance. Cutting silently at five was the wrong half of that
 * trade: the count in the margin said eleven and the line showed five, which
 * reads as a bug rather than as a summary.
 */
function run(names: string[], max = 5): string {
  if (names.length <= max) return names.join(' · ');
  return `${names.slice(0, max).join(' · ')} · ועוד ${names.length - max}`;
}

/**
 * The front page of the ledger: what needs attention today, and nothing else.
 *
 * The temptation on a home dashboard is to show everything the system knows —
 * six panels, twelve totals — and the result is a screen that is glanced at
 * once and skipped forever. Every entry here answers a question with a verb
 * attached: something to buy, something to use before it turns, something to
 * pay, someone to pay back. An entry with nothing to say does not print.
 */
export function HomeScreen() {
  const { user } = useSession();
  const month = monthKey(new Date());

  const budget = useAsync(() => api.get<BudgetMonth>('/money/budget', { month }));
  const shopping = useAsync(() => api.get<ShoppingItem[]>('/shopping/items', { status: 'open' }));
  const expiring = useAsync(() => api.get<ExpiringEntry[]>('/pantry/expiring', { days: 5 }));
  const bills = useAsync(() => api.get<RecurringBill[]>('/money/bills'));
  const low = useAsync(() => api.get<Product[]>('/pantry/products', { below_min: '1' }));

  const loading = budget.loading && shopping.loading && expiring.loading;
  // Every panel, not three of them. `quiet` used to be gated on `loading`,
  // which ignored bills and low stock — so a house with a bill due tomorrow
  // announced «אין מה לעשות היום» for as long as that request took, and then
  // contradicted itself. The comment below already forbade exactly this; the
  // gate simply did not cover the panels added after it was written.
  const settling = budget.loading || shopping.loading || expiring.loading
    || bills.loading || low.loading;
  const soonBills = (bills.data ?? []).filter((b) => {
    if (!b.active || b.autopay) return false;
    const days = Math.round((new Date(b.next_due).getTime() - Date.now()) / 86_400_000);
    return days <= b.remind_days;
  });

  // "Nothing to report" and "we could not find out" are different answers, and
  // every `?? 0` below would otherwise read a failed panel as an empty one —
  // a blind dashboard announcing that the house is calm.
  const failure = budget.error ?? shopping.error ?? expiring.error ?? bills.error ?? low.error;
  const reloadAll = () => {
    budget.reload(); shopping.reload(); expiring.reload();
    bills.reload(); low.reload();
  };

  const quiet = !settling && !failure
    && (shopping.data?.length ?? 0) === 0
    && (expiring.data?.length ?? 0) === 0
    && soonBills.length === 0;

  // The same number the budget screen leads with. Two screens that disagree
  // about what the headline figure is are two screens nobody trusts.
  const short = (budget.data?.flow.monthly ?? 0) < 0;

  return (
    <>
      <TopBar title={`${greeting()}${user?.display_name ? `, ${user.display_name}` : ''}`} />

      <div className="page">
        {loading && <Loading />}
        {failure && <ErrorNote message={failure} onRetry={reloadAll} />}

        {budget.data && (
          <Link to="/budget" style={{ textDecoration: 'none', display: 'block' }}>
            <div className="hero">
              <div className="label">תזרים החודש</div>
              <div className={`figure ${short ? 'over' : ''}`}>
                {formatILS(budget.data.flow.monthly, { sign: true })}
              </div>
              <div className="meta" style={{ marginTop: 'var(--s2)' }}>
                נכנס <span className="n">{formatILS(budget.data.flow.income)}</span>
                {' · הוצא '}<span className="n">{formatILS(budget.data.flow.spent)}</span>
              </div>
              {/* Said once, on the screen opened most often. The projection is
                  the intervention; burying it a tab away wastes it. */}
              {short && (
                <div className="meta" style={{ marginTop: 'var(--s2)', color: 'var(--red)' }}>
                  בקצב הזה — <span className="n">{formatILS(budget.data.flow.yearly)}</span> בשנה,
                  {' '}<span className="n">{formatILS(budget.data.flow.three_year)}</span> בשלוש
                </div>
              )}
            </div>
          </Link>
        )}

        {quiet && (
          <div className="empty">
            <div className="headline">אין מה לעשות היום.</div>
            <p>אין מה לקנות, שום דבר לא עומד להתקלקל, ואין חשבון שמחכה.</p>
          </div>
        )}

        {(shopping.data?.length ?? 0) > 0 && (
          <Entry
            to="/shopping"
            label="לקנות"
            count={shopping.data?.length ?? 0}
            body={run((shopping.data ?? []).map((i) => i.name))}
            note={(low.data?.length ?? 0) > 0 ? `${low.data?.length} מהם נגמרו במזווה` : undefined}
          />
        )}

        {(expiring.data?.length ?? 0) > 0 && (
          <Entry
            to="/pantry"
            label="להשתמש לפני שיתקלקל"
            count={expiring.data?.length ?? 0}
            tone="red"
            body={run((expiring.data ?? []).map((e) =>
              `${e.product_name} (${e.days_left <= 0 ? 'היום' : `${e.days_left} ימים`})`))}
          />
        )}

        {soonBills.length > 0 && (
          <Entry
            to="/budget"
            label="חשבונות שמגיעים"
            count={soonBills.length}
            tone="red"
            body={run(soonBills.map((b) => `${b.name}${b.amount_estimate ? ` · ${formatILS(b.amount_estimate)}` : ''}`))}
          />
        )}
      </div>
    </>
  );
}

/**
 * One entry in the day's ledger.
 *
 * Not a card — a ruled section with its count in the reserved right margin,
 * exactly like every other row in the app. The label is the small tracked
 * thing; the content is what you read.
 */
function Entry({ to, label, body, note, count, amount, tone }: {
  to: string; label: string; body: string; note?: string;
  count?: number; amount?: number; tone?: 'red';
}): ReactNode {
  return (
    <Link to={to} style={{ textDecoration: 'none', display: 'block' }}>
      <section className="section">
        <h2 style={tone === 'red' ? { color: 'var(--red)', borderBottomColor: 'var(--red)' } : undefined}>
          {label} {count != null && <span className="count n">{count}</span>}
        </h2>
        <div className="row">
          <span className="grow">
            <span style={{ display: 'block', fontSize: 17, lineHeight: 1.45 }}>{body}</span>
            {note && <span className="mark mark-blue">{note}</span>}
          </span>
          {amount != null && <span className="n amount" style={{ fontSize: 20 }}>{formatILS(amount)}</span>}
        </div>
      </section>
    </Link>
  );
}
