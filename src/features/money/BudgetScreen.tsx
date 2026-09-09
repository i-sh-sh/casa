import { useState } from 'react';
import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { AsyncForm, Empty, ErrorNote, Field, Fold, Loading, Sheet, useAsync, useFolds, useToast } from '../../ui/kit.js';
import { Icon } from '../../ui/Icon.js';
import { TopBar } from '../../ui/TopBar.js';
import {
  COMMITMENTS, COMMITMENT_LABELS, COMMITMENT_NOTES,
  formatILS, monthKey, nextMonth, previousMonth,
} from '@shared/money.js';
import type { BudgetMonth, CategoryAverage, EnvelopeRow } from '@shared/types.js';

const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

function monthLabel(month: string): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const name = MONTHS[m - 1] ?? month;
  return year === new Date().getFullYear() ? name : `${name} ${year}`;
}

/**
 * The envelopes, and the three questions the method says to ask of them.
 *
 * The hero is **cash flow** — income minus spending — rather than the
 * envelope model's "to be budgeted". They answer different questions and only
 * one of them changes behaviour: a household shrugs at ₪1,200 short this
 * month and does not shrug at ₪43,200 over three years. "To be budgeted"
 * stays, one line down, where it belongs.
 */
export function BudgetScreen() {
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const budget = useAsync(() => api.get<BudgetMonth>('/money/budget', { month }), [month]);
  const averages = useAsync(() => api.get<CategoryAverage[]>('/money/averages', { month }), [month]);
  const [editing, setEditing] = useState<EnvelopeRow | null>(null);
  const toast = useToast();
  const folds = useFolds('budget');

  const data = budget.data;
  const groups = (data?.envelopes ?? []).reduce<Record<string, EnvelopeRow[]>>((acc, env) => {
    (acc[env.group_name ?? 'ללא קבוצה'] ??= []).push(env);
    return acc;
  }, {});
  const averageFor = new Map((averages.data ?? []).map((a) => [a.category_id, a]));

  async function autofill() {
    try {
      const res = await api.post<{ filled: number }>('/money/budget/autofill', { month });
      toast.show(res.filled ? `מולאו ${res.filled} קטגוריות` : 'הכול כבר מלא');
      budget.reload();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'לא הצלחנו למלא', { tone: 'bad' });
    }
  }

  const short = (data?.flow.monthly ?? 0) < 0;

  return (
    <>
      <TopBar
        title="תקציב"
        subtitle={monthLabel(month)}
        action={<Link to="/transactions" className="btn btn-sm">תנועות</Link>}
      />

      <div className="page">
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
            <div className="hero">
              <div className="label">תזרים חודשי</div>
              <div className={`figure ${short ? 'over' : ''}`}>{formatILS(data.flow.monthly, { sign: true })}</div>
              <div className="meta" style={{ marginTop: 'var(--s2)' }}>
                נכנס <span className="n">{formatILS(data.flow.income)}</span>
                {' · הוצא '}<span className="n">{formatILS(data.flow.spent)}</span>
              </div>
            </div>

            {short && <Projection flow={data.flow} />}

            <Ladder data={data} />

            <section className="section">
              <h2>החודש · ₪</h2>
              <div className="rows">
                <Line label="הוקצה" value={data.allocated} />
                <Line label="ממתין לייעוד" value={data.to_be_budgeted} />
              </div>
              <button className="btn btn-block" style={{ marginTop: 'var(--s4)' }} onClick={() => void autofill()}>
                מילוי החודש לפי היעדים
              </button>
            </section>

            {data.envelopes.length === 0 && (
              <Empty
                headline="אין עדיין קטגוריות"
                hint="אפשר לזרוע תקציב ישראלי מוכן מתוך «הגדרות» ← «מסד הנתונים», ולשנות ממנו הכול."
              />
            )}

            {Object.entries(groups).map(([groupName, envelopes]) => {
              const left = envelopes.reduce((s, e) => s + e.available, 0);
              const over = envelopes.filter((e) => e.available < 0).length;
              // A group holding an overspend is never shut by default, and the
              // judgement is settled on arrival — otherwise allocating money to
              // clear the overspend would fold the group being worked on.
              // Tidying
              // the screen by hiding the one line that says «חריגה» would be
              // the budget lying by omission — and an unfolded budget is eight
              // groups deep, which is precisely why most months only need the
              // eight totals.
              const fallback = folds.settle(groupName, over > 0 || Object.keys(groups).length <= 3);
              return (
                <Fold
                  key={groupName}
                  id={groupName}
                  title={groupName}
                  count={<>· נשאר ₪</>}
                  // Shut, the group still says what it comes to: the same
                  // number that sits under the double rule when it is open.
                  mark={over > 0 ? <span className="mark mark-red">חריגה</span> : null}
                  note={
                    <span className={`n amount ${left < 0 ? 'over' : ''}`}>
                      {formatILS(left, { symbol: false })}
                    </span>
                  }
                  open={folds.isOpen(groupName, fallback)}
                  onToggle={() => folds.toggle(groupName, fallback)}
                >
                  <div className="rows">
                    {envelopes.map((env) => (
                      <EnvelopeLine key={env.category_id} env={env} onEdit={() => setEditing(env)} />
                    ))}
                  </div>
                  <hr className="rule-2" />
                  <div className="row" style={{ minHeight: 44, borderBottom: 0 }}>
                    <span className="margin-col" />
                    <span className="grow label">סך הקבוצה</span>
                    <span className={`n amount ${left < 0 ? 'over' : ''}`} style={{ fontWeight: 600 }}>
                      {formatILS(left, { symbol: false })}
                    </span>
                  </div>
                </Fold>
              );
            })}
          </>
        )}
      </div>

      {editing && (
        <AllocateSheet
          env={editing}
          month={month}
          average={averageFor.get(editing.category_id) ?? null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); budget.reload(); }}
        />
      )}
    </>
  );
}

/**
 * The same subtraction, said out loud.
 *
 * Not a forecast — ₪1,200 multiplied by 12 and 36. That is the entire device,
 * and it is the one part of the method that reliably changes what people do.
 * It appears only for a deficit: multiplying a good month by 36 to promise
 * ₪43,200 of savings would be the same arithmetic used dishonestly.
 */
function Projection({ flow }: { flow: BudgetMonth['flow'] }) {
  return (
    <section className="section">
      <h2 style={{ color: 'var(--red)', borderBottomColor: 'var(--red)' }}>
        אם שום דבר לא ישתנה
      </h2>
      <div className="rows">
        {[
          ['בחודש', flow.monthly],
          ['בשנה', flow.yearly],
          ['בשלוש שנים', flow.three_year],
        ].map(([label, value]) => (
          <div className="row" key={label as string} style={{ minHeight: 44 }}>
            <span className="grow label">{label as string}</span>
            <span className="n amount over" style={{ fontSize: 20, fontWeight: 600 }}>
              {formatILS(value as number)}
            </span>
          </div>
        ))}
      </div>
      <p className="meta" style={{ marginTop: 'var(--s2)' }}>
        זה לא תחזית. זה אותו חיסור, כפול שתים־עשרה וכפול שלושים ושש.
      </p>
    </section>
  );
}

/**
 * Where the flexibility is.
 *
 * "Spend less" is not advice. Naming which part of the month can actually be
 * moved is: a household whose rigid share eats its income has a different
 * problem, and a different remedy, from one whose liquid share does.
 */
function Ladder({ data }: { data: BudgetMonth }) {
  const { commitments, unplanned } = data;
  if (commitments.every((c) => c.allocated === 0)) return null;

  return (
    <section className="section">
      <h2>איפה יש גמישות <span className="count">· הוקצה ₪</span></h2>
      <div className="rows">
        {COMMITMENTS.map((key) => {
          const slice = commitments.find((c) => c.commitment === key);
          if (!slice) return null;
          return (
            <div className="row" key={key}>
              <span className="grow">
                <span className="title" style={{ display: 'block' }}>{COMMITMENT_LABELS[key]}</span>
                <span className="meter" style={{ maxWidth: 180 }} aria-hidden="true">
                  <i style={{ width: `${Math.round(slice.share * 100)}%` }} />
                </span>
                <span className="meta">{COMMITMENT_NOTES[key]}</span>
              </span>
              <span className="margin-col n">{Math.round(slice.share * 100)}%</span>
              <span className="n amount">{formatILS(slice.allocated, { symbol: false })}</span>
            </div>
          );
        })}
      </div>

      {!unplanned.meets_floor && (
        <div className="note-error" role="status">
          <div style={{ display: 'flex', gap: 'var(--s2)', alignItems: 'flex-start' }}>
            <Icon name="alert" size={18} />
            <div style={{ flex: 1 }}>
              לבלת״מ מוקצים <span className="n">{Math.round(unplanned.share * 100)}%</span> מהחודש.
              השיטה ממליצה על <span className="n">5%</span> לפחות — חסרים{' '}
              <span className="n">{formatILS(unplanned.shortfall)}</span>.
              <div style={{ marginTop: 'var(--s1)', fontSize: 14 }}>
                תמיד יש בלת״מ. חתונה, רופא שיניים, טלפון שנשבר — אף פעם לא אותו דבר,
                ואף פעם לא באמת הפתעה ש<em>משהו</em> קרה.
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Line({ label, value }: { label: string; value: number }) {
  return (
    <div className="row" style={{ minHeight: 40 }}>
      <span className="grow label">{label}</span>
      <span className={`n amount ${value < 0 ? 'over' : ''}`}>{formatILS(value)}</span>
    </div>
  );
}

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
          {COMMITMENT_LABELS[env.commitment]}
          {' · הוצא '}<span className="n">{formatILS(env.spent, { symbol: false })}</span>
          {' מתוך '}<span className="n">{formatILS(env.allocated, { symbol: false })}</span>
          {over && <> · <span className="mark mark-red">חריגה</span></>}
        </span>
      </span>
      <span className={`n amount ${over ? 'over' : ''}`} style={{ fontSize: 20 }}>
        {formatILS(env.available, { symbol: false })}
      </span>
    </button>
  );
}

function AllocateSheet({ env, month, average, onClose, onSaved }: {
  env: EnvelopeRow;
  month: string;
  average: CategoryAverage | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [allocated, setAllocated] = useState(String(env.allocated));
  const over = env.available < 0;

  return (
    <Sheet title={env.category_name} onClose={onClose}>
      <div className="rows" style={{ marginBottom: 'var(--s5)' }}>
        <div className="row" style={{ minHeight: 40 }}>
          <span className="grow label">רמת מחויבות</span>
          <span>{COMMITMENT_LABELS[env.commitment]}</span>
        </div>
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

        <div style={{ display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap', marginBottom: 'var(--s4)' }}>
          {/* What it actually cost beats what we meant it to cost. The method's
              first stage is to map real months before budgeting a shekel; we
              hold every transaction, so the mapping is already done. */}
          {average && average.months_observed > 0 && (
            <button type="button" className="btn btn-sm" onClick={() => setAllocated(String(Math.round(average.average)))}>
              בפועל · {formatILS(average.average)}
              <span className="meta" style={{ marginInlineStart: 4 }}>
                ({average.months_observed === 1 ? 'חודש אחד' : `${average.months_observed} חודשים`})
              </span>
            </button>
          )}
          {env.monthly_target != null && (
            <button type="button" className="btn btn-sm" onClick={() => setAllocated(String(env.monthly_target))}>
              היעד · {formatILS(env.monthly_target)}
            </button>
          )}
        </div>

        {average && average.months_observed > 0 && average.months_observed < 3 && (
          <p className="meta" style={{ marginBottom: 'var(--s4)' }}>
            הממוצע מבוסס על {average.months_observed === 1 ? 'חודש אחד בלבד' : 'חודשיים בלבד'}.
            אחרי שלושה חודשי מעקב הוא ייצג את הבית הרבה יותר טוב.
          </p>
        )}
      </AsyncForm>
    </Sheet>
  );
}
