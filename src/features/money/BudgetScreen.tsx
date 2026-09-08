import { useState } from 'react';
import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { AsyncForm, Empty, ErrorNote, Field, Loading, Sheet, useAsync, useToast } from '../../ui/kit.js';
import { Icon } from '../../ui/Icon.js';
import { TopBar } from '../../ui/TopBar.js';
import { formatILS, monthKey, nextMonth, previousMonth } from '@shared/money.js';
import type { BudgetMonth, EnvelopeRow } from '@shared/types.js';

const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

function monthLabel(month: string): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const name = MONTHS[m - 1] ?? month;
  return year === new Date().getFullYear() ? name : `${name} ${year}`;
}

/**
 * The envelopes.
 *
 * The screen is built around `available` — not what was allocated, not what
 * was spent. A bank app already tells you what you spent; only this can tell
 * you what you may still spend on *this particular thing*, which is the
 * number that changes a decision at the till.
 *
 * There is no green anywhere. An envelope in credit is set in plain ink,
 * because that is what "in the black" means and it is a real accounting
 * convention rather than a UI palette. The red pencil is reserved for the one
 * state that needs acting on, and because it is reserved, it carries.
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
      toast.show(err instanceof Error ? err.message : 'לא הצלחנו למלא', { tone: 'bad' });
    }
  }

  const over = (data?.to_be_budgeted ?? 0) < 0;

  return (
    <>
      <TopBar
        title="תקציב"
        subtitle={monthLabel(month)}
        action={<Link to="/transactions" className="btn btn-sm">תנועות</Link>}
      />

      <div className="page">
        {/* RTL: travelling back in time is rightward, so the older month sits
            on the right and its chevron points that way. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s2)' }}>
          <button className="btn btn-quiet" onClick={() => setMonth(nextMonth(month))} aria-label="החודש הבא">
            <Icon name="back" size={18} />
          </button>
          <div style={{ flex: 1, textAlign: 'center' }} className="label">{monthLabel(month)}</div>
          <button className="btn btn-quiet" onClick={() => setMonth(previousMonth(month))} aria-label="החודש הקודם" style={{ transform: 'scaleX(-1)' }}>
            <Icon name="back" size={18} />
          </button>
        </div>

        {budget.loading && !data && <Loading />}
        {budget.error && <ErrorNote message={budget.error} onRetry={budget.reload} />}

        {data && (
          <>
            {/* The one typographic event on this screen. */}
            <div className="hero">
              <div className="label">{over ? 'הקצינו יותר ממה שנכנס' : 'ממתין לייעוד'}</div>
              <div className={`figure ${over ? 'over' : ''}`}>{formatILS(data.to_be_budgeted)}</div>
            </div>

            <div className="rows" style={{ marginTop: 'var(--s4)' }}>
              <Line label="נכנס החודש" value={data.income} />
              <Line label="הוקצה" value={data.allocated} />
              <Line label="הוצא" value={data.spent} />
            </div>

            <button className="btn btn-block" style={{ marginTop: 'var(--s4)' }} onClick={() => void autofill()}>
              מילוי החודש לפי היעדים
            </button>

            {data.envelopes.length === 0 && (
              <Empty
                headline="אין עדיין קטגוריות"
                hint="אפשר לזרוע תקציב ישראלי מוכן מתוך «הגדרות» ← «מסד הנתונים», ולשנות ממנו הכול."
              />
            )}

            {Object.entries(groups).map(([groupName, envelopes]) => (
              <section className="section" key={groupName}>
                <h2>{groupName} <span className="count">· נשאר ₪</span></h2>
                <div className="rows">
                  {envelopes.map((env) => (
                    <EnvelopeLine key={env.category_id} env={env} onEdit={() => setEditing(env)} />
                  ))}
                </div>
                <hr className="rule-2" />
                <div className="row" style={{ minHeight: 44, borderBottom: 0 }}>
                  <span className="margin-col" />
                  <span className="grow label">סך הקבוצה</span>
                  <span className="n amount" style={{ fontWeight: 600 }}>
                    {formatILS(envelopes.reduce((s, e) => s + e.available, 0), { symbol: false })}
                  </span>
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

function Line({ label, value }: { label: string; value: number }) {
  return (
    <div className="row" style={{ minHeight: 40 }}>
      <span className="grow label">{label}</span>
      <span className="n amount">{formatILS(value)}</span>
    </div>
  );
}

/**
 * One envelope.
 *
 * Inverted pairing, on purpose: the label is the small heavy tracked thing and
 * the value is the large light one. And `available` is the only figure given
 * the money column — spent and allocated are context, set small underneath,
 * so the eye never has to choose between three numbers on one line.
 */
function EnvelopeLine({ env, onEdit }: { env: EnvelopeRow; onEdit: () => void }) {
  const over = env.available < 0;
  const ratio = env.allocated > 0 ? Math.min(env.spent / env.allocated, 1) : env.spent > 0 ? 1 : 0;

  return (
    <button className="row" onClick={onEdit}>
      <span className="grow">
        <span className="title" style={{ display: 'block' }}>{env.category_name}</span>
        <span className="meter" style={{ maxWidth: 180 }} aria-hidden="true">
          <i style={{ width: `${ratio * 100}%`, background: over ? 'var(--red)' : undefined }} />
        </span>
        <span className="meta">
          הוצא <span className="n">{formatILS(env.spent, { symbol: false })}</span>
          {' מתוך '}
          <span className="n">{formatILS(env.allocated, { symbol: false })}</span>
          {over && <> · <span className="mark mark-red">חריגה</span></>}
        </span>
      </span>
      <span className={`n amount ${over ? 'over' : ''}`} style={{ fontSize: 20 }}>
        {formatILS(env.available, { symbol: false })}
      </span>
    </button>
  );
}

function AllocateSheet({ env, month, onClose, onSaved }: { env: EnvelopeRow; month: string; onClose: () => void; onSaved: () => void }) {
  const [allocated, setAllocated] = useState(String(env.allocated));
  const over = env.available < 0;

  return (
    <Sheet title={env.category_name} onClose={onClose}>
      <div className="rows" style={{ marginBottom: 'var(--s5)' }}>
        <div className="row" style={{ minHeight: 40 }}>
          <span className="grow label">הוצא החודש</span>
          <span className="n amount">{formatILS(env.spent)}</span>
        </div>
        <hr className="rule-2" />
        <div className="row" style={{ minHeight: 48, borderBottom: 0 }}>
          <span className="grow label">זמין · כולל גלגול מחודשים קודמים</span>
          <span className={`n amount ${over ? 'over' : ''}`} style={{ fontSize: 24, fontWeight: 600 }}>
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
        <Field label="להקצות החודש · ₪">
          <input className="input" type="number" inputMode="decimal" step="10" value={allocated} onChange={(e) => setAllocated(e.target.value)} autoFocus />
        </Field>
        {env.monthly_target != null && (
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginBottom: 'var(--s4)' }}
            onClick={() => setAllocated(String(env.monthly_target))}
          >
            היעד הרגיל · {formatILS(env.monthly_target)}
          </button>
        )}
      </AsyncForm>
    </Sheet>
  );
}
