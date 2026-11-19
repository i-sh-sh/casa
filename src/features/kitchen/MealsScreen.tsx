import { useState } from 'react';
import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { Empty, ErrorNote, Loading, Sheet, useAsync, useToast } from '../../ui/kit.js';
import { Icon } from '../../ui/Icon.js';
import { TopBar } from '../../ui/TopBar.js';
import { KitchenTabs } from './KitchenTabs.js';
import { cookedLine } from './RecipesScreen.js';
import { addDays, dayLetter, dayName, weekStart, weekday } from '@shared/meals.js';
import type { MealEntry, MealHabits, Recipe } from '@shared/types.js';

interface WeekView { week: string; habits: MealHabits; entries: MealEntry[] }
interface Proposed { day: string; recipe_id: number; locked: boolean; reasons: string[]; relaxed: string | null }
interface ListResult { added: string[]; updated: number; removed: number }

const today = () => new Date().toISOString().slice(0, 10);
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

/** «15–21 בנובמבר», or across a month «29 בנובמבר – 5 בדצמבר». */
function weekLabel(week: string): string {
  const end = addDays(week, 6);
  const [, m1, d1] = week.split('-').map(Number) as [number, number, number];
  const [, m2, d2] = end.split('-').map(Number) as [number, number, number];
  return m1 === m2 ? `${d1}–${d2} ב${MONTHS[m1 - 1]}` : `${d1} ב${MONTHS[m1 - 1]} – ${d2} ב${MONTHS[m2 - 1]}`;
}

const dayDate = (day: string) => Number(day.slice(8, 10));

/** What the list did, said in one line — or nothing, when it did nothing. */
function listSentence(list: ListResult): string | null {
  const parts: string[] = [];
  if (list.added.length) parts.push(`נכנסו לרשימת הקניות: ${list.added.slice(0, 4).join(', ')}${list.added.length > 4 ? ` ועוד ${list.added.length - 4}` : ''}`);
  if (list.removed) parts.push(`${list.removed} יצאו מהרשימה`);
  return parts.length ? parts.join(' · ') : null;
}

/** «א׳–ה׳ · בשר עד 3 · צמחוני ב׳ · מהיר ד׳» — the habits, readable from the row that opens them. */
function habitsLine(h: MealHabits): string {
  const letters = (days: number[]) => days.map((d) => dayLetter(addDays('2026-11-15', d))).join(' ');
  const parts = [h.days.length ? letters(h.days) : 'אין ימים', `בשר עד ${h.meat_max}`];
  if (h.veggie_days.length) parts.push(`צמחוני ${letters(h.veggie_days)}`);
  if (h.quick_days.length) parts.push(`מהיר ${letters(h.quick_days)}`);
  return parts.join(' · ');
}

/**
 * The week's dinners.
 *
 * Two states, and the screen is honest about which one it is in. A
 * *proposal* is the planner's suggestion: nothing is saved, the list is not
 * touched, and «שוב» or «החלפה» cost nothing. The *plan* is what we agreed
 * on: approving it writes the days and puts what is missing on the shopping
 * list, and every change after that keeps the list in step.
 *
 * The planner says why it chose each dinner. A suggestion with no reason is
 * one you can only accept or reject; one that says «לפני שהשמנת תפוג» is one
 * you can agree with.
 */
export function MealsScreen() {
  const [week, setWeek] = useState(() => weekStart(today()));
  const view = useAsync(() => api.get<WeekView>('/pantry/meals', { week }), [week]);
  const recipes = useAsync(() => api.get<Recipe[]>('/pantry/recipes'));
  const [proposal, setProposal] = useState<Proposed[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [habitsOpen, setHabitsOpen] = useState(false);
  const [dayOpen, setDayOpen] = useState<string | null>(null);
  const toast = useToast();

  const byId = new Map((recipes.data ?? []).map((r) => [r.id, r]));
  const entries = view.data?.entries ?? [];
  const habits = view.data?.habits;
  const isPast = addDays(week, 6) < today();
  // Once a week has a plan, every planned day shows — including one left
  // empty — so a single day can be filled without planning the week again.
  const planDays = [...new Set([
    ...entries.map((e) => e.day),
    ...(habits?.days ?? []).map((d) => addDays(week, d)).filter((d) => d >= today()),
  ])].sort();

  async function run<T>(work: () => Promise<T>): Promise<T | null> {
    setBusy(true); setError(null);
    try { return await work(); } catch (err) {
      setError(err instanceof Error ? err.message : 'משהו השתבש');
      return null;
    } finally { setBusy(false); }
  }

  /** Locked days stay; everything else is chosen again. */
  const suggest = (locked: { day: string; recipe_id: number }[], avoid: { day: string; recipe_id: number }[] = []) =>
    run(async () => {
      const next = await api.post<Proposed[]>('/pantry/meals/suggest', { week, locked, avoid });
      setProposal(next);
    });

  function startProposal() {
    // What was already cooked this week is history, and the plan is built around it.
    const cooked = entries.filter((e) => e.status === 'cooked').map((e) => ({ day: e.day, recipe_id: e.recipe_id }));
    void suggest(cooked);
  }

  const lockedOf = (p: Proposed[]) => p.filter((d) => d.locked).map((d) => ({ day: d.day, recipe_id: d.recipe_id }));

  async function approve() {
    if (!proposal) return;
    const res = await run(() => api.put<{ list: ListResult }>('/pantry/meals/week', {
      week, entries: proposal.map((p) => ({ day: p.day, recipe_id: p.recipe_id })),
    }));
    if (!res) return;
    setProposal(null);
    view.reload();
    toast.show(listSentence(res.list) ?? 'השבוע נקבע. יש הכול בבית');
  }

  async function cook(entry: MealEntry) {
    const res = await run(() => api.post<{ taken: string[] }>(`/pantry/recipes/${entry.recipe_id}/cooked`, { day: entry.day }));
    if (!res) return;
    view.reload(); recipes.reload();
    toast.show(res.taken.length ? `בתאבון. ירד מהמזווה: ${res.taken.join(', ')}` : 'בתאבון');
  }

  const noRecipes = recipes.data !== null && recipes.data.length === 0;

  return (
    <>
      <TopBar title="מטבח" subtitle={`השבוע של ${weekLabel(week)}`} />
      <div className="page">
        <KitchenTabs />

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s2)', borderBottom: '1px solid var(--rule)' }}>
          <button className="btn btn-quiet" disabled={busy} onClick={() => { setProposal(null); setWeek(addDays(week, -7)); }}
            aria-label="השבוע הקודם" style={{ transform: 'scaleX(-1)' }}>
            <Icon name="back" size={18} />
          </button>
          <div style={{ flex: 1, textAlign: 'center', fontWeight: 700 }}>
            {week === weekStart(today()) ? 'השבוע' : weekLabel(week)}
          </div>
          <button className="btn btn-quiet" disabled={busy} onClick={() => { setProposal(null); setWeek(addDays(week, 7)); }} aria-label="השבוע הבא">
            <Icon name="back" size={18} />
          </button>
        </div>

        {(view.loading && !view.data) || (recipes.loading && !recipes.data) ? <Loading /> : null}
        {view.error && <ErrorNote message={view.error} onRetry={view.reload} />}
        {recipes.error && <ErrorNote message={recipes.error} onRetry={recipes.reload} />}

        {noRecipes && (
          <Empty
            headline="קודם צריך מתכונים"
            hint="התכנון בוחר מתוך מה שאתם מבשלים. הוסיפו כמה מתכונים, ואז אפשר לתת לו לתכנן את השבוע."
            action={<Link to="/recipes" className="btn">לספר המתכונים</Link>}
          />
        )}

        {habits && !noRecipes && (
          <div className="rows" style={{ marginTop: 'var(--s2)' }}>
            <button className="row" onClick={() => setHabitsOpen(true)}>
              <span className="grow">
                <span className="title" style={{ display: 'block' }}>הרגלי אכילה</span>
                <span className="meta">{habitsLine(habits)}</span>
              </span>
              <Icon name="more" size={18} />
            </button>
          </div>
        )}

        {/* ── The proposal ─────────────────────────────────────────── */}
        {proposal && (
          <section className="section">
            <h2>הצעה לשבוע <span className="count">· עוד לא נשמר</span></h2>
            {proposal.length === 0 && <p className="meta">אין ימים לתכנן בשבוע הזה. אפשר לשנות בהרגלי האכילה.</p>}
            <div className="rows">
              {proposal.map((p) => {
                const r = byId.get(p.recipe_id);
                return (
                  <div className="row" key={p.day}>
                    <span className="margin-col"><b>{dayLetter(p.day)}</b><br /><span className="n">{dayDate(p.day)}</span></span>
                    <span className="grow">
                      <span className="title" style={{ display: 'block' }}>{r?.name ?? '…'}</span>
                      <span className="meta">
                        {p.locked ? 'נשאר כמו שבחרתם' : p.reasons.join(' · ') || (r ? `${r.kind} · ${r.effort}` : '')}
                        {p.relaxed && <> · <span className="mark mark-red">ויתרנו על «{p.relaxed}»</span></>}
                      </span>
                    </span>
                    <button
                      className="btn btn-sm" aria-pressed={p.locked} disabled={busy}
                      aria-label={p.locked ? `שחרור ${dayName(weekday(p.day))}` : `לקבע את ${dayName(weekday(p.day))}`}
                      onClick={() => setProposal(proposal.map((d) => (d.day === p.day ? { ...d, locked: !d.locked } : d)))}
                    >
                      <Icon name="lock" size={16} />
                    </button>
                    {!p.locked && (
                      <button className="btn btn-sm" disabled={busy}
                        onClick={() => void suggest(
                          lockedOf(proposal).concat(proposal.filter((d) => d.day !== p.day && !d.locked).map((d) => ({ day: d.day, recipe_id: d.recipe_id }))),
                          [{ day: p.day, recipe_id: p.recipe_id }],
                        )}>
                        החלפה
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {error && <p style={{ color: 'var(--red)', fontSize: 15, marginTop: 'var(--s3)' }}>{error}</p>}
            <button className="btn btn-primary btn-block" style={{ marginTop: 'var(--s4)' }} disabled={busy || proposal.length === 0} onClick={() => void approve()}>
              {busy ? 'רגע…' : 'אישור השבוע ועדכון רשימת הקניות'}
            </button>
            <div className="chips">
              <button className="btn btn-sm" disabled={busy} onClick={() => void suggest(lockedOf(proposal))}>הצעה אחרת</button>
              <button className="btn btn-sm btn-quiet" disabled={busy} onClick={() => setProposal(null)}>ביטול</button>
            </div>
          </section>
        )}

        {/* ── The plan ─────────────────────────────────────────────── */}
        {!proposal && view.data && !noRecipes && (
          <section className="section">
            <h2>ארוחות ערב <span className="count n">{entries.length}</span></h2>
            {entries.length === 0 ? (
              <p className="meta" style={{ marginBottom: 'var(--s4)' }}>
                {isPast ? 'לא תוכננו ארוחות בשבוע הזה.' : 'השבוע עוד לא מתוכנן. התכנון בוחר לפי מה שאוהבים, מה שיש במזווה ומה שלא אכלנו מזמן, ושומר על ההרגלים.'}
              </p>
            ) : (
              <div className="rows">
                {planDays.map((day) => {
                  const e = entries.find((x) => x.day === day);
                  if (!e) {
                    return (
                      <div className="row" key={day}>
                        <span className="margin-col"><b>{dayLetter(day)}</b><br /><span className="n">{dayDate(day)}</span></span>
                        <button className="grow" style={{ minWidth: 0, textAlign: 'start' }} onClick={() => setDayOpen(day)} aria-label={`בחירת ארוחה ליום ${dayName(weekday(day))}`}>
                          <span className="title" style={{ display: 'block', color: 'var(--ink-3)' }}>בלי ארוחה</span>
                          <span className="meta">בחירה מספר המתכונים</span>
                        </button>
                      </div>
                    );
                  }
                  const cooked = e.status === 'cooked';
                  return (
                    <div className="row" key={e.day}>
                      <span className="margin-col"><b>{dayLetter(e.day)}</b><br /><span className="n">{dayDate(e.day)}</span></span>
                      <button className="grow" style={{ minWidth: 0, textAlign: 'start' }} onClick={() => setDayOpen(e.day)} aria-label={`${dayName(weekday(e.day))}: ${e.recipe_name}`}>
                        <span className={`title ${cooked ? 'struck' : ''}`} style={{ display: 'block' }}>{e.recipe_name}</span>
                        <span className="meta">
                          {cooked ? <span className="mark">בושל</span> : `${e.kind} · ${e.effort}`}
                        </span>
                      </button>
                      {!cooked && e.day <= today() && (
                        <button className="btn btn-sm" disabled={busy} onClick={() => void cook(e)}>בישלנו</button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {error && <p style={{ color: 'var(--red)', fontSize: 15, marginTop: 'var(--s3)' }}>{error}</p>}
            {!isPast && (
              <button className={`btn btn-block ${entries.length ? '' : 'btn-primary'}`} style={{ marginTop: 'var(--s4)' }}
                disabled={busy} onClick={startProposal}>
                {busy ? 'רגע…' : entries.length ? 'לתכנן מחדש' : 'תכננו לי את השבוע'}
              </button>
            )}
          </section>
        )}
      </div>

      {habitsOpen && habits && (
        <HabitsSheet
          habits={habits}
          onClose={() => setHabitsOpen(false)}
          onSaved={() => { setHabitsOpen(false); view.reload(); toast.show('ההרגלים נשמרו'); }}
        />
      )}
      {dayOpen && (
        <DaySheet
          day={dayOpen}
          entry={entries.find((e) => e.day === dayOpen) ?? null}
          recipes={recipes.data ?? []}
          onClose={() => setDayOpen(null)}
          onSaved={(list) => {
            setDayOpen(null); view.reload();
            toast.show(listSentence(list) ?? 'נשמר');
          }}
        />
      )}
    </>
  );
}

function DayToggles({ label, days, allowed, onChange }: {
  label: string; days: number[]; allowed: number[]; onChange: (days: number[]) => void;
}) {
  return (
    <div className="field" role="group" aria-label={label}>
      <span>{label}</span>
      <div className="chips" style={{ marginTop: 0 }}>
        {allowed.map((d) => (
          <button key={d} type="button" className="btn btn-sm" aria-pressed={days.includes(d)} aria-label={dayName(d)}
            onClick={() => onChange(days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort())}>
            {dayLetter(addDays('2026-11-15', d))}
          </button>
        ))}
      </div>
    </div>
  );
}

function HabitsSheet({ habits, onClose, onSaved }: { habits: MealHabits; onClose: () => void; onSaved: () => void }) {
  const [h, setH] = useState(habits);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = [0, 1, 2, 3, 4, 5, 6];

  return (
    <Sheet title="הרגלי אכילה" onClose={onClose}>
      <p className="meta" style={{ marginBottom: 'var(--s4)' }}>
        התכנון שומר על אלה כל עוד ספר המתכונים מאפשר. כשאין מתכון שמתאים, הוא אומר על מה ויתר.
      </p>
      <DayToggles label="באילו ימים מתכננים ארוחת ערב" days={h.days} allowed={all}
        onChange={(days) => setH({ ...h, days, veggie_days: h.veggie_days.filter((d) => days.includes(d)), quick_days: h.quick_days.filter((d) => days.includes(d)) })} />
      <div className="field">
        <span>בשר או עוף · עד כמה פעמים בשבוע</span>
        <div className="chips" style={{ marginTop: 0 }}>
          {[0, 1, 2, 3, 4, 5, 7].map((n) => (
            <button key={n} type="button" className="btn btn-sm" aria-pressed={h.meat_max === n} onClick={() => setH({ ...h, meat_max: n })}>
              {n === 7 ? 'בלי הגבלה' : n}
            </button>
          ))}
        </div>
      </div>
      <DayToggles label="ערבים צמחוניים" days={h.veggie_days} allowed={h.days} onChange={(veggie_days) => setH({ ...h, veggie_days })} />
      <DayToggles label="ערבים עמוסים · רק ארוחה מהירה" days={h.quick_days} allowed={h.days} onChange={(quick_days) => setH({ ...h, quick_days })} />
      <div className="field">
        <span>לא לחזור על מתכון לפני</span>
        <div className="chips" style={{ marginTop: 0 }}>
          {[0, 7, 10, 14, 21].map((n) => (
            <button key={n} type="button" className="btn btn-sm" aria-pressed={h.repeat_gap === n} onClick={() => setH({ ...h, repeat_gap: n })}>
              {n === 0 ? 'לא משנה' : `${n} ימים`}
            </button>
          ))}
        </div>
      </div>
      {error && <p style={{ color: 'var(--red)', fontSize: 15, marginBottom: 'var(--s3)' }}>{error}</p>}
      <button className="btn btn-primary btn-block" disabled={busy} onClick={async () => {
        setBusy(true); setError(null);
        try { await api.put('/pantry/meals/habits', { habits: h }); onSaved(); } catch (err) {
          setError(err instanceof Error ? err.message : 'משהו השתבש'); setBusy(false);
        }
      }}>
        {busy ? 'רגע…' : 'שמירה'}
      </button>
    </Sheet>
  );
}

/** One day: choose another dinner from the cookbook, or clear it. */
function DaySheet({ day, entry, recipes, onClose, onSaved }: {
  day: string; entry: MealEntry | null; recipes: Recipe[];
  onClose: () => void; onSaved: (list: ListResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cooked = entry?.status === 'cooked';

  async function set(recipeId: number | null) {
    setBusy(true); setError(null);
    try {
      const res = await api.put<{ list: ListResult }>(`/pantry/meals/day/${day}`, { recipe_id: recipeId });
      onSaved(res.list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'משהו השתבש'); setBusy(false);
    }
  }

  return (
    <Sheet title={`יום ${dayName(weekday(day))} · ${entry?.recipe_name ?? 'בלי ארוחה'}`} onClose={onClose}>
      {cooked ? (
        <p className="meta">הארוחה הזאת כבר בושלה, והיא נשארת בהיסטוריה כמו שהיא.</p>
      ) : (
        <>
          <p className="meta" style={{ marginBottom: 'var(--s3)' }}>בחירה אחרת מעדכנת את רשימת הקניות.</p>
          <div className="rows">
            {recipes.filter((r) => r.id !== entry?.recipe_id).map((r) => (
              <button key={r.id} className="row" disabled={busy} onClick={() => void set(r.id)}>
                <span className="grow">
                  <span className="title" style={{ display: 'block' }}>{r.name}</span>
                  <span className="meta">{r.kind} · {r.effort} · {cookedLine(r)}</span>
                </span>
              </button>
            ))}
          </div>
          {error && <p style={{ color: 'var(--red)', fontSize: 15, marginTop: 'var(--s3)' }}>{error}</p>}
          {entry && (
            <button className="btn btn-block btn-red" style={{ marginTop: 'var(--s4)' }} disabled={busy} onClick={() => void set(null)}>
              בלי ארוחה מתוכננת ביום הזה
            </button>
          )}
        </>
      )}
    </Sheet>
  );
}
