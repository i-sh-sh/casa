import { useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { AsyncForm, Empty, ErrorNote, Field, Loading, Sheet, useAsync, useToast } from '../../ui/kit.js';
import { Icon } from '../../ui/Icon.js';
import { TopBar } from '../../ui/TopBar.js';
import { KitchenTabs } from './KitchenTabs.js';
import { EFFORTS, RECIPE_KINDS, nameCandidates, parseIngredients, unitLabel } from '@shared/meals.js';
import { daysBetween, normalizeName } from '@shared/pantry.js';
import type { Effort, Ingredient, Product, Recipe, RecipeKind } from '@shared/types.js';

export const LIKING_LABELS: Record<number, string> = { 1: 'בסדר', 2: 'טוב', 3: 'אוהבים במיוחד' };
const today = () => new Date().toISOString().slice(0, 10);

/** «בושל 4 פעמים · לפני 12 ימים», or that it never was. */
export function cookedLine(recipe: Recipe): string {
  if (!recipe.last_cooked) return 'עוד לא בישלנו';
  const days = daysBetween(recipe.last_cooked, today());
  const when = days <= 0 ? 'היום' : days === 1 ? 'אתמול' : days < 14 ? `לפני ${days} ימים` : `לפני ${Math.floor(days / 7)} שבועות`;
  return recipe.times_cooked === 1 ? `בושל פעם אחת · ${when}` : `בושל ${recipe.times_cooked} פעמים · ${when}`;
}

/**
 * The household's cookbook.
 *
 * Not a recipe site: the dishes this home actually makes, how much we like
 * each one, and — learned from «בישלנו», never typed — when we last had it.
 * Those are exactly the inputs the week's planner chooses from, so every line
 * on this screen earns its place by changing what gets planned.
 */
export function RecipesScreen() {
  const recipes = useAsync(() => api.get<Recipe[]>('/pantry/recipes'));
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Recipe | 'new' | null>(null);
  const toast = useToast();

  const all = recipes.data ?? [];
  const shown = all.filter((r) => !search || r.name.includes(search));

  return (
    <>
      <TopBar title="מטבח" subtitle={`${all.length} מתכונים`} />
      <div className="page">
        <KitchenTabs />

        {all.length > 6 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s2)', marginTop: 'var(--s4)' }}>
            <Icon name="search" size={18} />
            <input className="input" type="search" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="חיפוש מתכון" aria-label="חיפוש מתכון" />
          </div>
        )}

        {recipes.loading && !recipes.data && <Loading />}
        {recipes.error && <ErrorNote message={recipes.error} onRetry={recipes.reload} />}

        {!recipes.loading && all.length === 0 && (
          <Empty
            headline="עוד אין מתכונים"
            hint="הוסיפו את מה שאתם באמת מבשלים, ואת המצרכים בהדבקה. מכאן מתכננים את השבוע, וכל «בישלנו» מלמד את האפליקציה מה אוהבים."
            action={<button className="btn" onClick={() => setEditing('new')}>מתכון ראשון</button>}
          />
        )}

        {shown.length > 0 && (
          <section className="section">
            <h2>המתכונים שלנו <span className="count n">{shown.length}</span></h2>
            <div className="rows">
              {shown.map((r) => (
                <button key={r.id} className="row" onClick={() => setEditing(r)} aria-label={`עריכת ${r.name}`}>
                  <span className="grow">
                    <span className="title" style={{ display: 'block' }}>{r.name}</span>
                    <span className="meta">
                      {r.kind} · {r.effort}
                      {r.liking === 3 && <> · <span className="mark">אוהבים במיוחד</span></>}
                      {' · '}{cookedLine(r)}
                    </span>
                  </span>
                  <span className="meta n" style={{ minWidth: '2.5em', textAlign: 'center' }} aria-label={`${r.ingredients.length} מצרכים`}>
                    {r.ingredients.length}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {all.length > 0 && (
          <button className="btn btn-block" style={{ marginTop: 'var(--s6)' }} onClick={() => setEditing('new')}>
            <Icon name="plus" size={18} /> מתכון חדש
          </button>
        )}
      </div>

      {editing && (
        <RecipeSheet
          recipe={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={(message) => { setEditing(null); recipes.reload(); toast.show(message); }}
        />
      )}
    </>
  );
}

/** Back to text, so editing a recipe is editing the lines it was pasted as. */
function toLines(ingredients: Ingredient[]): string {
  return ingredients
    .map((i) => [i.qty ?? '', unitLabel(i.unit, i.qty) ?? '', i.name].filter((part) => part !== '').join(' '))
    .join('\n');
}

function Choice<T extends string | number>({ label, options, value, onChange, labels }: {
  label: string; options: readonly T[]; value: T; onChange: (v: T) => void; labels?: Record<string, string>;
}) {
  return (
    <div className="field" role="group" aria-label={label}>
      <span>{label}</span>
      <div className="chips" style={{ marginTop: 0 }}>
        {options.map((o) => (
          <button key={o} type="button" className="btn btn-sm" aria-pressed={value === o} onClick={() => onChange(o)}>
            {labels?.[String(o)] ?? o}
          </button>
        ))}
      </div>
    </div>
  );
}

export function RecipeSheet({ recipe, onClose, onDone }: {
  recipe: Recipe | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [name, setName] = useState(recipe?.name ?? '');
  const [kind, setKind] = useState<RecipeKind>(recipe?.kind ?? 'צמחוני');
  const [effort, setEffort] = useState<Effort>(recipe?.effort ?? 'רגיל');
  const [liking, setLiking] = useState(recipe?.liking ?? 2);
  const [text, setText] = useState(recipe ? toLines(recipe.ingredients) : '');
  const [source, setSource] = useState(recipe?.source ?? '');
  const [note, setNote] = useState(recipe?.note ?? '');
  // Per-line «always have» decisions, keyed by name so they survive re-typing
  // the amount. Seeded from the saved recipe; the parser guesses the rest.
  const [always, setAlways] = useState<Record<string, boolean>>(() =>
    Object.fromEntries((recipe?.ingredients ?? []).map((i) => [normalizeName(i.name), i.always_have])));
  const products = useAsync(() => api.get<Product[]>('/pantry/products'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => parseIngredients(text).map((i) => {
    const key = normalizeName(i.name);
    return { ...i, always_have: always[key] ?? i.always_have };
  }), [text, always]);

  const stockOf = useMemo(() => {
    const byKey = new Map((products.data ?? []).map((p) => [p.name_key, p]));
    return (ingredientName: string) => nameCandidates(ingredientName).map((k) => byKey.get(k)).find(Boolean);
  }, [products.data]);

  async function act(path: string, method: 'post' | 'del', message: string) {
    setBusy(true); setError(null);
    try {
      if (method === 'post') await api.post(path, {});
      else await api.del(path);
      onDone(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'משהו השתבש');
      setBusy(false);
    }
  }

  return (
    <Sheet title={recipe ? recipe.name : 'מתכון חדש'} onClose={onClose}>
      <AsyncForm
        submitLabel={recipe ? 'שמירה' : 'הוספה'}
        disabled={!name.trim() || busy}
        onSubmit={async () => {
          const payload = {
            name, kind, effort, liking, source, note,
            ingredients: parsed.map((i) => ({ name: i.name, qty: i.qty, unit: i.unit, always_have: i.always_have })),
          };
          if (recipe) await api.patch(`/pantry/recipes/${recipe.id}`, payload);
          else await api.post('/pantry/recipes', payload);
          onDone(recipe ? 'נשמר' : 'נוסף לספר המתכונים');
        }}
      >
        <Field label="שם">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!recipe} placeholder="שקשוקה" />
        </Field>
        <Choice label="על מה הארוחה" options={RECIPE_KINDS} value={kind} onChange={setKind} />
        <Choice label="זמן הכנה" options={EFFORTS} value={effort} onChange={setEffort} />
        <Choice label="כמה אוהבים" options={[1, 2, 3] as const} value={liking as 1 | 2 | 3} onChange={setLiking} labels={LIKING_LABELS} />

        <Field label="מצרכים · שורה לכל מצרך, אפשר להדביק">
          <textarea
            className="input" rows={6} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={'4 ביצים\n2 עגבניות\n1 כפית כמון\nקורט מלח'}
            style={{ minHeight: '9em', resize: 'vertical' }}
          />
        </Field>

        {parsed.length > 0 && (
          <div className="rows" style={{ marginBottom: 'var(--s4)' }} aria-label="המצרכים כפי שהבנו אותם">
            {parsed.map((i, idx) => {
              const product = stockOf(i.name);
              const key = normalizeName(i.name);
              return (
                <div className="row" key={`${key}-${idx}`} style={{ minHeight: 48 }}>
                  <span className="n" style={{ minWidth: '3.5em', textAlign: 'center' }}>{i.qty ?? '—'}</span>
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15 }}>{i.name}</span>
                    <span className="meta" style={{ display: 'block' }}>
                      {unitLabel(i.unit, i.qty) ?? (product ? product.unit : 'יח׳')}
                      {!i.always_have && product && product.in_stock > 0 && <> · במזווה <span className="n">{product.in_stock}</span></>}
                    </span>
                  </span>
                  <button
                    type="button" className="btn btn-sm" aria-pressed={i.always_have}
                    onClick={() => setAlways((prev) => ({ ...prev, [key]: !i.always_have }))}
                    title="מצרך שתמיד יש בבית לא נכנס לרשימת הקניות"
                  >
                    תמיד יש
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <Field label="קישור למתכון">
          <input className="input" type="url" inputMode="url" value={source} onChange={(e) => setSource(e.target.value)} placeholder="https://" dir="ltr" />
        </Field>
        <Field label="הערות · אופן הכנה">
          <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} style={{ resize: 'vertical' }} />
        </Field>
        {error && <p style={{ color: 'var(--red)', fontSize: 15, marginBottom: 'var(--s3)' }}>{error}</p>}
      </AsyncForm>

      {recipe && (
        <div className="chips" style={{ marginTop: 'var(--s4)' }}>
          <button className="btn btn-sm" disabled={busy}
            onClick={() => void act(`/pantry/recipes/${recipe.id}/cooked`, 'post', 'נרשם. המצרכים ירדו מהמזווה')}>
            בישלנו היום
          </button>
          {recipe.source && <a className="btn btn-sm" href={recipe.source} target="_blank" rel="noreferrer">פתיחת המתכון</a>}
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm btn-red" disabled={busy}
            onClick={() => void act(`/pantry/recipes/${recipe.id}`, 'del', 'המתכון הועבר לארכיון')}>
            לארכיון
          </button>
        </div>
      )}
    </Sheet>
  );
}
