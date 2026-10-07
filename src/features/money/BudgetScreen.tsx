import { useState } from 'react';
import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { AsyncForm, Empty, ErrorNote, Field, Fold, Loading, Sheet, useAsync, useFolds } from '../../ui/kit.js';
import { Icon } from '../../ui/Icon.js';
import { TopBar } from '../../ui/TopBar.js';
import {
  COMMITMENTS, COMMITMENT_LABELS, COMMITMENT_NOTES,
  formatILS, monthKey, nextMonth, previousMonth,
} from '@shared/money.js';
import type { BudgetMonth, Commitment, EnvelopeRow } from '@shared/types.js';

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
 *
 * Two of them came back, on a distinction worth keeping: **the ladder and the
 * 5% floor invent nothing.** They read the household's own allocations and
 * group them, or check one part against the whole. What stayed out are the
 * three that actually typed a figure into somebody's budget — the seeded
 * targets, the button that filled a month from them, and the three-month
 * average — along with rollover, which was never from the method at all.
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

            <Ladder data={data} />

            {/* Spent with no category, so in no envelope. Named rather than
                merely counted: it is in the month's flow either way, and the
                only way to see which rows they are is to be told they exist. */}
            {data.unfiled !== 0 && (
              <section className="section">
                <h2>לא שויך לקטגוריה</h2>
                <div className="rows">
                  <div className="row" style={{ borderBottom: 0 }}>
                    <span className="grow meta">
                      יצא מהחשבון ונספר בתזרים, אבל לא נכנס לשום מעטפה.
                      {' '}<Link to="/transactions">לפתוח את התנועות</Link> ולשייך.
                    </span>
                    <span className="n amount">{formatILS(data.unfiled, { symbol: false })}</span>
                  </div>
                </div>
              </section>
            )}

            <Ahead data={data} />

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

        {/* At the foot, with the other things done once a month rather than
            at the till. */}
        <Link to="/budget/excel" className="btn btn-block" style={{ marginTop: 'var(--gap-over)' }}>
          ייבוא וייצוא לאקסל
        </Link>
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

/**
 * Where the give is.
 *
 * Not a figure the app invented — a regrouping of the household's own
 * allocations by how much control they have over each one. «לצמצם הוצאות» is
 * not advice; «מתוך ₪9,700, ₪3,570 קשיחות ו-₪1,450 נזילות» is, because it
 * names the part that can actually move.
 *
 * It draws nothing before the first allocation: a ladder of four zeroes teaches
 * people to skip the section, and by the time it has something to say they have
 * learned to.
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
              מומלץ <span className="n">5%</span> לפחות — חסרים{' '}
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

/**
 * What installment purchases have already spent of the months to come.
 *
 * Every figure is a recorded installment and a count the card statement
 * printed — «2 מתוך 3» leaves one. Nothing appears until a row says it is an
 * installment, so a household that never splits a purchase never sees this.
 */
function Ahead({ data }: { data: BudgetMonth }) {
  const ahead = data.ahead;
  if (!ahead || ahead.series.length === 0) return null;
  return (
    <section className="section">
      <h2>כבר מחויב לחודשים הבאים <span className="count">· ₪</span></h2>
      <div className="rows">
        {ahead.series.map((s) => (
          <div className="row" key={`${s.payee}|${s.per_month}|${s.installments_total}`}>
            <span className="grow">
              <span className="title" style={{ display: 'block' }}>{s.payee}</span>
              <span className="meta">
                נשארו <span className="n">{s.remaining}</span> מתוך <span className="n">{s.installments_total}</span>
                {' · '}<span className="n">{formatILS(s.per_month, { symbol: false })}</span> לחודש
                {s.category_name && <> · {s.category_name}</>}
              </span>
            </span>
            <span className="n amount">{formatILS(s.remaining_total, { symbol: false })}</span>
          </div>
        ))}
      </div>
      <hr className="rule-2" />
      <div className="row" style={{ minHeight: 44, borderBottom: 0 }}>
        <span className="margin-col" />
        <span className="grow label">סך הכול עוד לחייב</span>
        <span className="n amount">{formatILS(ahead.total, { symbol: false })}</span>
      </div>
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
      <span className="grow" style={{ textAlign: 'start' }}>
        <span className="title" style={{ display: 'block' }}>{env.category_name}</span>
        <span className="meter" style={{ maxWidth: 180 }} aria-hidden="true">
          <i style={{ width: `${ratio * 100}%`, background: over ? 'var(--red)' : undefined }} />
        </span>
        {/* The whole subtraction, on one line, in the order it is spoken:
            what left, out of what was put in. The figure at the end is the
            difference, and there is nowhere else it could have come from. */}
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
  const [commitment, setCommitment] = useState<Commitment>(env.commitment);
  const willBe = (Number(allocated) || 0) - env.spent;

  return (
    <Sheet title={env.category_name} onClose={onClose}>
      <AsyncForm
        submitLabel="שמירה"
        onSubmit={async () => {
          await api.put(`/money/budget/${env.category_id}`, { month, allocated: Number(allocated) || 0 });
          // The rung belongs to the category, not to the month, so it is a
          // separate write — and only when it actually changed.
          if (commitment !== env.commitment) {
            await api.patch(`/money/categories/${env.category_id}`, { commitment });
          }
          onSaved();
        }}
      >
        <Field label="לתקצב החודש · ₪">
          <input className="input" type="number" inputMode="decimal" step="10" value={allocated} onChange={(e) => setAllocated(e.target.value)} autoFocus style={{ fontSize: 24 }} />
        </Field>

        {/* The classification the ladder groups by, editable here.
            It used to arrive from the seed and could not be changed anywhere —
            which made the ladder a statement about a list somebody else wrote.
            Whether שכירות is rigid for this household is theirs to say. */}
        <Field label="מה אפשר לעשות עם זה">
          <select className="select" value={commitment} onChange={(e) => setCommitment(e.target.value as Commitment)}>
            {COMMITMENTS.map((c) => (
              <option key={c} value={c}>{COMMITMENT_LABELS[c]} — {COMMITMENT_NOTES[c]}</option>
            ))}
          </select>
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
