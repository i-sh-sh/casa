import { useState } from 'react';
import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { AsyncForm, Empty, ErrorNote, Field, Fold, Loading, Sheet, useAsync, useFolds } from '../../ui/kit.js';
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
 * One month, and the subtraction it is made of.
 *
 * Everything on this screen is now a figure somebody typed or a difference
 * between two of them. What was taken out was a whole apparatus — a projection
 * of the deficit over one and three years, a ladder splitting the month by how
 * much control the household has over it, a 5% floor for the unforeseen, a
 * three-month average offered as a suggestion, and a button that filled the
 * month from targets shipped in the seed.
 *
 * None of it was wrong. All of it put numbers on the screen that nobody in the
 * house had chosen, next to numbers they had, in the same typeface — and a
 * budget nobody can recompute in their head is one they cannot argue with.
 * Arguing with it, out loud, between two people, is the entire product.
 */
export function BudgetScreen() {
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const budget = useAsync(() => api.get<BudgetMonth>('/money/budget', { month }), [month]);
  const [editing, setEditing] = useState<EnvelopeRow | null>(null);
  const folds = useFolds('budget');

  const data = budget.data;
  const groups = (data?.envelopes ?? []).reduce<Record<string, EnvelopeRow[]>>((acc, env) => {
    (acc[env.group_name ?? 'ללא קבוצה'] ??= []).push(env);
    return acc;
  }, {});

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

            <section className="section">
              <h2>החודש · ₪</h2>
              <div className="rows">
                <Line label="נכנס" value={data.income} />
                <Line label="תוקצב" value={data.allocated} />
                {/* Income minus what the budget claims. Not «to be budgeted»
                    across all of history — just this month against itself. */}
                <Line label="לא תוקצב" value={data.to_be_budgeted} />
              </div>
            </section>

            {data.envelopes.length === 0 && (
              <Empty
                headline="אין עדיין קטגוריות"
                hint="קטגוריה היא שם וסכום חודשי שאתם קובעים. אפשר להוסיף מ«הגדרות»."
              />
            )}

            {Object.entries(groups).map(([groupName, envelopes]) => {
              const left = envelopes.reduce((s, e) => s + e.available, 0);
              const over = envelopes.filter((e) => e.available < 0).length;
              // Eight groups, eight totals, and the month is legible without
              // opening anything. «חריגה» rides on the shut header beside the
              // group's remaining balance, so folding hides the envelopes and
              // never the fact that one of them is over.
              //
              // Constant, never derived from the envelopes: a default reading
              // `over` would fold the group under the thumb of whoever had just
              // allocated the money that cleared the overspend.
              const fallback = false;
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
          onClose={() => setEditing(null)}
          onSaved={() => {
            // The envelope that was just funded is inside a group that may be
            // shut, where the new number would be invisible. Nothing folds away
            // what somebody just did.
            folds.reveal(editing.group_name ?? 'ללא קבוצה');
            setEditing(null);
            budget.reload();
          }}
        />
      )}
    </>
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
      <span className="grow" style={{ textAlign: 'start' }}>
        <span className="title" style={{ display: 'block' }}>{env.category_name}</span>
        <span className="meter" style={{ maxWidth: 180 }} aria-hidden="true">
          <i style={{ width: `${ratio * 100}%`, background: over ? 'var(--red)' : undefined }} />
        </span>
        {/* The whole subtraction, on one line, in the order it is spoken:
            what left, out of what was put in. The figure at the end is the
            difference, and there is nowhere else it could have come from. */}
        <span className="meta">
          הוצא <span className="n">{formatILS(env.spent, { symbol: false })}</span>
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

/**
 * Putting money in one envelope, for one month.
 *
 * Everything this sheet used to offer besides the number is gone: the
 * commitment rung, a «בפועל» button carrying a three-month average, a «היעד»
 * button carrying a figure from the seed. Each of them typed into the box for
 * you, and each was a number the household had never chosen.
 *
 * What is left states the month's arithmetic and then asks for the one input
 * it needs. «נשאר» underneath is live: it is what the figure in the box would
 * leave, so the answer is visible before the save rather than after it.
 */
function AllocateSheet({ env, month, onClose, onSaved }: {
  env: EnvelopeRow;
  month: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [allocated, setAllocated] = useState(String(env.allocated));
  const willBe = (Number(allocated) || 0) - env.spent;

  return (
    <Sheet title={env.category_name} onClose={onClose}>
      <AsyncForm
        submitLabel="שמירה"
        onSubmit={async () => {
          await api.put(`/money/budget/${env.category_id}`, { month, allocated: Number(allocated) || 0 });
          onSaved();
        }}
      >
        <Field label="לתקצב החודש · ₪">
          <input className="input" type="number" inputMode="decimal" step="10" value={allocated} onChange={(e) => setAllocated(e.target.value)} autoFocus style={{ fontSize: 24 }} />
        </Field>

        <div className="rows" style={{ marginBottom: 'var(--s5)' }}>
          <div className="row" style={{ minHeight: 44 }}>
            <span className="grow label">הוצא החודש</span>
            <span className="n amount">{formatILS(env.spent, { symbol: false })}</span>
          </div>
          <hr className="rule-2" />
          <div className="row" style={{ minHeight: 48, borderBottom: 0 }}>
            <span className="grow label">יישאר</span>
            <span className={`n amount ${willBe < 0 ? 'over' : ''}`} style={{ fontSize: 24, fontWeight: 600 }}>
              {formatILS(willBe, { symbol: false })}
            </span>
          </div>
        </div>
      </AsyncForm>
    </Sheet>
  );
}
