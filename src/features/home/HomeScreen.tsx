import { useState, type ReactNode } from 'react';
import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { useSession } from '../../lib/session.js';
import { ErrorNote, Loading, useAsync, useToast } from '../../ui/kit.js';
import { Icon } from '../../ui/Icon.js';
import { TransactionSheet } from '../money/TransactionsScreen.js';
import { SetupCard } from './SetupCard.js';
import { InstallHint } from './InstallHint.js';
import { firstName } from '../household/HouseholdGate.js';
import { TopBar } from '../../ui/TopBar.js';
import { formatILS, monthKey } from '@shared/money.js';
import { FlowHero } from '../money/FlowHero.js';
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
  const toast = useToast();
  const [adding, setAdding] = useState(false);

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


  return (
    <>
      {/* Recording a spend is the one thing the pilot asks a couple to keep
          doing, and it used to be three taps deep under the budget. It is one
          tap from the first screen now, wherever the page is scrolled to. */}
      <TopBar
        title={`${greeting()}${firstName(user ?? null) ? `, ${firstName(user ?? null)}` : ''}`}
        action={(
          <button className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> הוצאה
          </button>
        )}
      />

      <div className="page">
        <InstallHint />
        <SetupCard />

        {loading && <Loading />}
        {failure && <ErrorNote message={failure} onRetry={reloadAll} />}

        {budget.data && (
          <Link to="/budget" style={{ textDecoration: 'none', display: 'block' }}>
            <FlowHero flow={budget.data.flow} />
          </Link>
        )}

        {quiet && (
          <div className="empty">
            <div className="headline">אין מה לעשות היום.</div>
            <p>אין מה לקנות, שום דבר לא עומד להתקלקל, ואין חשבון שמחכה.</p>
          </div>
        )}

        {/* One section, one row per errand. These used to be three sections,
            each with its own heading and rule and 36px above it — three times
            the furniture for three lines of content, and the eye had to find
            where each began. The count sits in the margin column, where every
            screen keeps its marks. */}
        {!quiet && !settling && (
          <section className="section">
            <h2>היום</h2>
            <div className="rows">
              {(shopping.data?.length ?? 0) > 0 && (
                <Entry
                  to="/shopping"
                  label="לקנות"
                  count={shopping.data?.length ?? 0}
                  body={run((shopping.data ?? []).map((i) => i.name))}
                  note={(low.data?.length ?? 0) > 0 ? `${low.data?.length} נגמרו במזווה` : undefined}
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
          </section>
        )}
      </div>

      {adding && (
        <TransactionSheet
          transaction={null}
          onClose={() => setAdding(false)}
          onSaved={(message) => { setAdding(false); toast.show(message); budget.reload(); }}
        />
      )}
    </>
  );
}

/**
 * One errand in the day's ledger: how many in the margin, what in the body.
 *
 * Not a card — a ruled row, the whole of it the link, exactly like every
 * other row in the app.
 */
function Entry({ to, label, body, note, count, tone }: {
  to: string; label: string; body: string; note?: string; count: number; tone?: 'red';
}): ReactNode {
  return (
    <Link to={to} className="row" style={{ textDecoration: 'none' }}>
      <span className={`margin-col figure-col n ${tone === 'red' ? 'over' : ''}`}>{count}</span>
      <span className="grow">
        <span className="label" style={{ display: 'block', ...(tone === 'red' ? { color: 'var(--red)' } : {}) }}>{label}</span>
        <span style={{ display: 'block', fontSize: 16, lineHeight: 1.45 }}>{body}</span>
        {note && <span className="mark mark-blue">{note}</span>}
      </span>
    </Link>
  );
}
