import { useState } from 'react';
import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { AsyncForm, Empty, ErrorNote, Field, Sheet, Spinner, useAsync, useToast } from '../../ui/kit.js';
import { TopBar } from '../../ui/TopBar.js';
import { formatILS, monthKey, nextMonth, previousMonth } from '@shared/money.js';
import type { BudgetMonth, EnvelopeRow } from '@shared/types.js';

const MONTH_NAMES = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

function monthLabel(month: string): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const now = new Date();
  const isThisYear = year === now.getFullYear();
  return isThisYear ? (MONTH_NAMES[m - 1] ?? month) : `${MONTH_NAMES[m - 1] ?? ''} ${year}`;
}

/**
 * The envelopes.
 *
 * The number the screen is built around is `available`, not `allocated` and not
 * `spent`. A bank app can already tell you what you spent; only this can tell
 * you what you may still spend on this particular thing — which is the number
 * that changes a decision at the till, and therefore the biggest thing on
 * every row.
 */
export function BudgetScreen() {
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const budget = useAsync(() => api.get<BudgetMonth>('/money/budget', { month }), [month]);
  const [editing, setEditing] = useState<EnvelopeRow | null>(null);
  const toast = useToast();

  const data = budget.data;
  const groups = (data?.envelopes ?? []).reduce<Record<string, EnvelopeRow[]>>((acc, env) => {
    (acc[env.group_name ?? 'ללא קבוצה'] ??= []).push(env);
    return acc;
  }, {});

  async function autofill() {
    try {
      const res = await api.post<{ filled: number }>('/money/budget/autofill', { month });
      toast.show(res.filled ? `מולאו ${res.filled} קטגוריות` : 'הכול כבר מלא');
      budget.reload();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'לא הצלחנו למלא', 'bad');
    }
  }

  return (
    <>
      <TopBar
        title="תקציב"
        subtitle={monthLabel(month)}
        action={<Link to="/transactions" className="btn btn-sm btn-ghost">תנועות</Link>}
      />

      <div className="page">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          {/* RTL: "previous" sits on the right, where the thumb expects the
              direction of travel to go back. */}
          <button className="btn btn-sm btn-ghost" onClick={() => setMonth(previousMonth(month))} aria-label="חודש קודם">›</button>
          <div style={{ flex: 1, textAlign: 'center', fontWeight: 500 }}>{monthLabel(month)}</div>
          <button className="btn btn-sm btn-ghost" onClick={() => setMonth(nextMonth(month))} aria-label="חודש הבא">‹</button>
        </div>

        {budget.loading && !data && <Spinner />}
        {budget.error && <ErrorNote message={budget.error} onRetry={budget.reload} />}

        {data && (
          <>
            <ToBeBudgeted amount={data.to_be_budgeted} />

            <div className="card card-pad" style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                <span className="muted">הוקצה החודש</span>
                <span className="num">{formatILS(data.allocated)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginTop: 6 }}>
                <span className="muted">הוצא החודש</span>
                <span className="num">{formatILS(data.spent)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginTop: 6 }}>
                <span className="muted">נכנס החודש</span>
                <span className="num pos">{formatILS(data.income)}</span>
              </div>
              <button className="btn btn-sm btn-ghost btn-block" style={{ marginTop: 14 }} onClick={() => void autofill()}>
                מילוי החודש לפי היעדים
              </button>
            </div>

            {data.envelopes.length === 0 && (
              <Empty
                glyph="💰"
                title="אין עדיין קטגוריות"
                hint="הריצו זריעת ברירת מחדל מ«הגדרות» כדי לקבל תקציב ישראלי מוכן."
              />
            )}

            {Object.entries(groups).map(([groupName, envelopes]) => (
              <section className="section" key={groupName}>
                <h2>{groupName}</h2>
                <div className="card">
                  <div className="rows">
                    {envelopes.map((env) => (
                      <EnvelopeRowView key={env.category_id} env={env} onEdit={() => setEditing(env)} />
                    ))}
                  </div>
                </div>
              </section>
            ))}
          </>
        )}
      </div>

      {editing && (
        <AllocateSheet
          env={editing}
          month={month}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); budget.reload(); }}
        />
      )}
    </>
  );
}

/**
 * The single most important number, and the only one rendered big.
 *
 * Positive means there is money with no job yet. Negative means we have
 * promised more than came in — which is worth shouting about, because it is
 * the failure mode the envelope model exists to make visible.
 */
function ToBeBudgeted({ amount }: { amount: number }) {
  const over = amount < 0;
  return (
    <div
      className="card card-pad"
      style={{
        textAlign: 'center',
        background: over ? 'var(--bad-soft)' : 'var(--sage-soft)',
        borderColor: over ? 'var(--bad)' : 'var(--sage)',
      }}
    >
      <div style={{ fontSize: 13, color: over ? 'var(--bad)' : 'var(--sage)', fontWeight: 500 }}>
        {over ? 'הקצינו יותר ממה שנכנס' : 'ממתין לייעוד'}
      </div>
      <div className="num" style={{ fontSize: 34, fontWeight: 700, color: over ? 'var(--bad)' : 'var(--sage)', letterSpacing: '-.02em' }}>
        {formatILS(amount)}
      </div>
    </div>
  );
}

function EnvelopeRowView({ env, onEdit }: { env: EnvelopeRow; onEdit: () => void }) {
  const spentRatio = env.allocated > 0 ? Math.min(env.spent / env.allocated, 1) : env.spent > 0 ? 1 : 0;
  const tone = env.available < 0 ? 'bad' : spentRatio > 0.85 ? 'warn' : '';

  return (
    <button className="row" onClick={onEdit}>
      <span aria-hidden="true" style={{ fontSize: 20, width: 26, textAlign: 'center' }}>{env.icon ?? '•'}</span>
      <div className="grow">
        <div className="title">{env.category_name}</div>
        <div className={`bar ${tone}`} style={{ marginTop: 6, marginBottom: 5 }}>
          <i style={{ width: `${spentRatio * 100}%` }} />
        </div>
        <div className="meta">
          הוצא <span className="num">{formatILS(env.spent)}</span> מתוך <span className="num">{formatILS(env.allocated)}</span>
        </div>
      </div>
      <div style={{ textAlign: 'end' }}>
        <div className="num" style={{ fontWeight: 700, color: env.available < 0 ? 'var(--bad)' : 'var(--ink)' }}>
          {formatILS(env.available)}
        </div>
        <div className="meta">נשאר</div>
      </div>
    </button>
  );
}

function AllocateSheet({ env, month, onClose, onSaved }: { env: EnvelopeRow; month: string; onClose: () => void; onSaved: () => void }) {
  const [allocated, setAllocated] = useState(String(env.allocated));

  return (
    <Sheet title={env.category_name} onClose={onClose}>
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span className="muted">הוצא החודש</span><span className="num">{formatILS(env.spent)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
          <span className="muted">זמין (כולל גלגול מחודשים קודמים)</span>
          <span className="num" style={{ fontWeight: 700, color: env.available < 0 ? 'var(--bad)' : 'var(--ink)' }}>
            {formatILS(env.available)}
          </span>
        </div>
      </div>

      <AsyncForm
        submitLabel="שמירה"
        onSubmit={async () => {
          await api.put(`/money/budget/${env.category_id}`, { month, allocated: Number(allocated) || 0 });
          onSaved();
        }}
      >
        <Field label="כמה להקצות החודש">
          <input className="input" type="number" inputMode="decimal" step="10" value={allocated} onChange={(e) => setAllocated(e.target.value)} autoFocus />
        </Field>
        {env.monthly_target != null && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={{ marginBottom: 14 }}
            onClick={() => setAllocated(String(env.monthly_target))}
          >
            היעד הרגיל: {formatILS(env.monthly_target)}
          </button>
        )}
      </AsyncForm>
    </Sheet>
  );
}
