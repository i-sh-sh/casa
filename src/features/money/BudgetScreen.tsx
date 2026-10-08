import { useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { AsyncForm, Empty, ErrorNote, Field, Fold, Loading, Sheet, useAsync, useFolds } from '../../ui/kit.js';
import { Explainable } from '../../ui/Explain.js';
import { Icon } from '../../ui/Icon.js';
import { TopBar } from '../../ui/TopBar.js';
import { Bar, type Tone } from '../../ui/Bar.js';
import { MonthStepper } from '../../ui/MonthStepper.js';
import { FlowHero } from './FlowHero.js';
import {
  COMMITMENTS, COMMITMENT_LABELS, COMMITMENT_NOTES,
  formatILS, monthKey,
} from '@shared/money.js';
import {
  explainAhead, explainCommitment, explainEnvelopeSpent, explainFlow,
  explainGroup, explainIncome, explainSpent, explainUnbudgeted, explainUnfiled, explainUnplanned,
} from '@shared/explain.js';
import type { BudgetMonth, Category, Commitment, EnvelopeRow, Transaction } from '@shared/types.js';

interface Details { txs: Transaction[]; incomeIds: number[] }

/**
 * The month's rows, fetched the first time somebody asks what a figure is made
 * of — not with the screen. Most visits never open a slip, and the ones that do
 * open several, so one request per month serves them all.
 */
function useDetails(month: string) {
  const cache = useRef<{ month: string; p: Promise<Details> } | null>(null);
  return () => {
    if (!cache.current || cache.current.month !== month) {
      const p = Promise.all([
        api.get<Transaction[]>('/money/transactions', { month, limit: 500 }),
        api.get<Category[]>('/money/categories'),
      ]).then(([txs, cats]) => ({ txs, incomeIds: cats.filter((c) => c.kind === 'income').map((c) => c.id) }));
      // A failed fetch must not be remembered as the answer for the month.
      p.catch(() => { if (cache.current?.p === p) cache.current = null; });
      cache.current = { month, p };
    }
    return cache.current.p;
  };
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
  const [classifying, setClassifying] = useState(false);
  const folds = useFolds('budget');
  const details = useDetails(month);

  const data = budget.data;
  const groups = (data?.envelopes ?? []).reduce<Record<string, EnvelopeRow[]>>((acc, env) => {
    (acc[env.group_name ?? 'ללא קבוצה'] ??= []).push(env);
    return acc;
  }, {});

  return (
    <>
      <TopBar
        title="תקציב"
        action={<Link to="/transactions" className="btn btn-sm">תנועות</Link>}
      />

      <div className="page">
        <MonthStepper month={month} onChange={setMonth} />

        {budget.loading && !data && <Loading />}
        {budget.error && <ErrorNote message={budget.error} onRetry={budget.reload} />}

        {data && (
          <>
            <FlowHero
              flow={data.flow}
              wrap={(key, node) => (
                <Explainable
                  inline
                  className=""
                  style={key === 'flow' ? { display: 'block' } : undefined}
                  explain={key === 'flow'
                    ? () => explainFlow(data)
                    : key === 'spent'
                      ? () => explainSpent(data)
                      : async () => { const d = await details(); return explainIncome(data, d.txs, d.incomeIds); }}
                >
                  {node}
                </Explainable>
              )}
            />

            <Warnings data={data} details={details} />

            {data.envelopes.length === 0 && (
              <Empty
                headline="אין עדיין קטגוריות"
                hint="קטגוריה היא שם וסכום חודשי שאתם קובעים. אפשר להוסיף מ«הגדרות»."
              />
            )}

            {/* The groups come straight after the month's figure: they are
                what this screen is opened to change. The analysis that used
                to sit between them — three rows of totals, the ladder, its
                notes — is below, where it is read once a month. */}
            {data.envelopes.length > 0 && (
              <div className="label" style={{ marginTop: 'var(--s5)', display: 'flex' }}>
                <span style={{ flex: 1 }}>מעטפות</span>
                <span>נשאר · ₪</span>
              </div>
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
                  count={<span className="n">{envelopes.length}</span>}
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
                  <Explainable style={{ minHeight: 44, borderBottom: 0 }} explain={() => explainGroup(groupName, envelopes)}>
                    <span className="margin-col" />
                    <span className="grow label">סך הקבוצה</span>
                    <span className={`n amount ${left < 0 ? 'over' : ''}`} style={{ fontWeight: 600 }}>
                      {formatILS(left, { symbol: false })}
                    </span>
                  </Explainable>
                </Fold>
              );
            })}

            <Split data={data} details={details} onClassify={() => setClassifying(true)} />

            <Ahead data={data} />
          </>
        )}

        {/* At the foot, with the other things done once a month rather than
            at the till. */}
        <Link to="/budget/excel" className="btn btn-block" style={{ marginTop: 'var(--gap-over)' }}>
          ייבוא וייצוא לאקסל
        </Link>
      </div>

      {classifying && data && (
        <ClassifySheet
          envelopes={data.envelopes}
          onClose={() => { setClassifying(false); budget.reload(); }}
        />
      )}

      {editing && data && (
        <AllocateSheet
          env={editing}
          month={month}
          explainSpent={async () => { const d = await details(); return explainEnvelopeSpent(data, editing, d.txs); }}
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

const RUNG_TONES: Record<Commitment, Tone> = {
  rigid: 'tone-1', flexible: 'tone-2', liquid: 'tone-ink3', unplanned: 'tone-3',
};

/**
 * Where the month's income went, drawn as one bar.
 *
 * It replaces two sections that said the same thing in two vocabularies: three
 * rows of totals (נכנס, תוקצב, לא תוקצב) and the ladder, four rows each with a
 * meter, a percentage and a sentence. Here the bar is the income, split by the
 * rung of everything allocated out of it, with what is left unallocated as the
 * blank paper at the end. One glance answers both old questions — how much is
 * spoken for, and how much of that could move.
 *
 * Every rung is still the household's own allocations regrouped, nothing
 * invented, and every figure still opens its slip. The rung descriptions moved
 * to the classify sheet, which is the one place they are needed.
 */
function Split({ data, details, onClassify }: {
  data: BudgetMonth;
  details: () => Promise<Details>;
  onClassify: () => void;
}) {
  const { commitments } = data;
  if (data.allocated === 0 && data.income === 0) return null;
  const free = Math.max(0, data.to_be_budgeted);
  // Everything on one rung is almost never a decision; it is the default
  // every new category gets (an import from a file whose «קשיחות» column was
  // left empty does exactly this). Said once, with the way to fix it.
  const oneRung = commitments.filter((c) => c.allocated > 0).length === 1;

  return (
    <section className="section">
      <h2>לאן הולכת ההכנסה <span className="count">· ₪</span></h2>
      <Bar
        label="חלוקת ההכנסה לפי סוג ההוצאה"
        parts={[
          ...COMMITMENTS.map((key) => ({
            value: commitments.find((c) => c.commitment === key)?.allocated ?? 0,
            tone: RUNG_TONES[key],
          })),
          // The paper left blank: income nothing has claimed yet.
          { value: free, tone: 'tone-blank' as Tone },
        ]}
      />
      <div className="rows">
        {COMMITMENTS.map((key) => {
          const slice = commitments.find((c) => c.commitment === key);
          if (!slice || slice.allocated === 0) return null;
          return (
            <Explainable key={key} style={{ minHeight: 44 }} explain={() => explainCommitment(data, key)}>
              <span className={`swatch ${RUNG_TONES[key]}`} />
              <span className="grow">{COMMITMENT_LABELS[key]}</span>
              <span className="n meta" style={{ fontSize: 13 }}>{Math.round(slice.share * 100)}%</span>
              <span className="n amount">{formatILS(slice.allocated, { symbol: false })}</span>
            </Explainable>
          );
        })}
        {/* Income minus what the budget claims. Not «to be budgeted»
            across all of history — just this month against itself. */}
        <Explainable style={{ minHeight: 44 }} explain={() => explainUnbudgeted(data)}>
          <span className="swatch tone-blank" />
          <span className="grow">{data.to_be_budgeted < 0 ? 'תוקצב מעבר להכנסה' : 'לא תוקצב'}</span>
          <span className={`n amount ${data.to_be_budgeted < 0 ? 'over' : ''}`}>{formatILS(data.to_be_budgeted, { symbol: false })}</span>
        </Explainable>
      </div>
      <hr className="rule-2" />
      <Explainable style={{ minHeight: 44, borderBottom: 0 }} explain={async () => { const d = await details(); return explainIncome(data, d.txs, d.incomeIds); }}>
        <span className="grow label">נכנס החודש</span>
        <span className="n amount" style={{ fontWeight: 600 }}>{formatILS(data.income, { symbol: false })}</span>
      </Explainable>

      {oneRung && (
        <p className="meta" style={{ marginTop: 'var(--s2)' }}>
          כל הסעיפים באותה דרגה. כנראה שעוד לא סווגו.
        </p>
      )}
      <button type="button" className="btn btn-sm btn-block" style={{ marginTop: 'var(--s3)' }} onClick={onClassify}>
        לסווג את הסעיפים
      </button>
    </section>
  );
}

/**
 * The two things the month is asking for, each in one line.
 *
 * Both used to be whole sections — a heading, a paragraph and a button — and
 * the paragraph was the same every month. What changes is the figure, so the
 * figure is what stays, with the verb that fixes it.
 */
function Warnings({ data, details }: { data: BudgetMonth; details: () => Promise<Details> }) {
  const { unplanned } = data;
  const lowFloor = !unplanned.meets_floor && data.allocated > 0;
  if (!lowFloor && data.unfiled === 0) return null;

  return (
    <div className="rows">
      {lowFloor && (
        <div className="row" style={{ minHeight: 48, color: 'var(--red)' }}>
          <Icon name="alert" size={18} />
          <span className="grow" style={{ lineHeight: 1.4 }}>
            <span style={{ display: 'block', fontSize: 15 }}>
              לא צפויות{' '}
              <Explainable inline className="" explain={() => explainUnplanned(data)}>
                <span className="n">{Math.round(unplanned.share * 100)}%</span>
              </Explainable>
              {' '}מהחודש
            </span>
            <span style={{ fontSize: 13 }}>מומלץ <span className="n">5%</span> לפחות · חסר</span>
          </span>
          <span className="n amount over">{formatILS(-unplanned.shortfall, { symbol: false })}</span>
        </div>
      )}
      {/* Spent with no category, so in no envelope. Named rather than
          merely counted: it is in the month's flow either way, and the
          only way to see which rows they are is to be told they exist. */}
      {data.unfiled !== 0 && (
        <Explainable style={{ minHeight: 48 }} explain={async () => { const d = await details(); return explainUnfiled(data, d.txs, d.incomeIds); }}>
          <span className="grow" style={{ fontSize: 15 }}>
            לא שויך לקטגוריה · <Link to="/transactions" style={{ color: 'var(--blue)' }}>לשייך</Link>
          </span>
          <span className="n amount">{formatILS(data.unfiled, { symbol: false })}</span>
        </Explainable>
      )}
    </div>
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
      <Explainable style={{ minHeight: 44, borderBottom: 0 }} explain={() => explainAhead(data)}>
        <span className="margin-col" />
        <span className="grow label">סך הכול עוד לחייב</span>
        <span className="n amount">{formatILS(ahead.total, { symbol: false })}</span>
      </Explainable>
    </section>
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
function AllocateSheet({ env, month, explainSpent, onClose, onSaved }: {
  env: EnvelopeRow;
  month: string;
  explainSpent: Parameters<typeof Explainable>[0]['explain'];
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
          <Explainable style={{ minHeight: 48 }} explain={explainSpent}>
            <span className="grow label">הוצא החודש</span>
            <span className="n amount">{formatILS(env.spent, { symbol: false })}</span>
          </Explainable>
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

/**
 * Every spending category and its rung, on one page.
 *
 * The ladder is only as true as the classification under it, and the only
 * other place to set it is one category at a time inside the allocation
 * sheet — forty taps through forty sheets for a household that just imported
 * its file. Each change saves on its own, so leaving halfway keeps what was
 * done.
 */
function ClassifySheet({ envelopes, onClose }: { envelopes: EnvelopeRow[]; onClose: () => void }) {
  const [values, setValues] = useState<Record<number, Commitment>>(
    () => Object.fromEntries(envelopes.map((e) => [e.category_id, e.commitment])),
  );
  const [error, setError] = useState<string | null>(null);

  const change = async (id: number, commitment: Commitment) => {
    const before = values[id]!;
    setValues((v) => ({ ...v, [id]: commitment }));
    setError(null);
    try {
      await api.patch(`/money/categories/${id}`, { commitment });
    } catch (err) {
      setValues((v) => ({ ...v, [id]: before }));
      setError(err instanceof Error ? err.message : 'השמירה נכשלה');
    }
  };

  return (
    <Sheet title="סיווג הסעיפים" onClose={onClose}>
      <p className="meta" style={{ marginBottom: 'var(--s3)' }}>
        {COMMITMENTS.map((c) => `${COMMITMENT_LABELS[c]}: ${COMMITMENT_NOTES[c]}`).join('. ')}.
      </p>
      {error && <ErrorNote message={error} />}
      <div className="rows">
        {envelopes.map((e) => (
          <label className="row" key={e.category_id} style={{ minHeight: 56 }}>
            <span className="grow">
              <span className="title" style={{ display: 'block' }}>{e.category_name}</span>
              {e.group_name && <span className="meta">{e.group_name}</span>}
            </span>
            <select
              className="select"
              style={{ width: 'auto', minWidth: 120 }}
              value={values[e.category_id]}
              onChange={(ev) => { void change(e.category_id, ev.target.value as Commitment); }}
            >
              {COMMITMENTS.map((c) => <option key={c} value={c}>{COMMITMENT_LABELS[c]}</option>)}
            </select>
          </label>
        ))}
      </div>
      <button type="button" className="btn btn-primary btn-block" style={{ marginTop: 'var(--s4)' }} onClick={onClose}>
        סיום
      </button>
    </Sheet>
  );
}
