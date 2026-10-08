import { useState } from 'react';
import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { useSession } from '../../lib/session.js';
import { AsyncForm, ErrorNote, Loading, Sheet, useAsync, useToast } from '../../ui/kit.js';
import { AccountForm, InviteSection } from '../settings/SettingsScreen.js';
import { SUGGESTED_MIN } from '@shared/pantry.js';
import { setupDone, setupSteps, wantsAnotherCard, type SetupFacts, type SetupStepKey } from '@shared/setup.js';
import { firstName } from '../household/HouseholdGate.js';
import type { Product } from '@shared/types.js';

const hiddenKey = (household: number) => `casa-setup-hidden:${household}`;

function readHidden(household: number): boolean {
  try { return localStorage.getItem(hiddenKey(household)) === '1'; } catch { return false; }
}

/**
 * «Four things and the home is yours» — the first thing a new home sees.
 *
 * Opening a home used to land on the home screen and stop: categories, two
 * accounts and a pantry list were there, none of them the couple's own, and
 * nothing said what to do next. This is what to do next. Each step is read
 * from the data (shared/setup.ts), so a card added in settings or a budget
 * that came in from Excel ticks it here too, and nothing is stored but the
 * choice to hide the list.
 *
 * Every step can be skipped, and the whole list can be hidden: a household
 * that runs its money from Excel and never touches the pantry is still a
 * household this app is for. It goes away by itself when all four are done.
 */
export function SetupCard() {
  const { user } = useSession();
  const household = user?.household_id ?? 0;
  const facts = useAsync(() => api.get<SetupFacts>('/admin/setup'));
  const [hidden, setHidden] = useState(() => readHidden(household));
  const [open, setOpen] = useState<SetupStepKey | null>(null);

  if (hidden || !facts.data) return null;
  const steps = setupSteps(facts.data);
  const done = setupDone(steps);
  if (done === steps.length) return null;

  const hide = () => {
    try { localStorage.setItem(hiddenKey(household), '1'); } catch { /* the list just comes back next time */ }
    setHidden(true);
  };
  const close = () => { setOpen(null); facts.reload(); };
  const isOwner = user?.role === 'owner';

  return (
    <section className="section">
      <h2>להקים את הבית <span className="count n">{done}/{steps.length}</span></h2>
      <p className="meta" style={{ marginBottom: 'var(--s2)' }}>
        הבית פתוח. ארבעה דברים, וכל מה שרואים כאן יהיה שלכם. אפשר לדלג על כל אחד.
      </p>

      <div className="rows">
        {steps.map((step) => (
          <div className="row" key={step.key} style={{ minHeight: 56 }}>
            <span className="grow">
              <span className="title" style={{ display: 'block' }}>{step.label}</span>
              <span className="meta">
                {step.done && !(step.key === 'card' && wantsAnotherCard(facts.data!)) ? `נעשה · ${step.status}` : step.status}
              </span>
            </span>
            {(!step.done || (step.key === 'card' && wantsAnotherCard(facts.data!))) && (
              <StepAction step={step.key} isOwner={isOwner} onOpen={setOpen} />
            )}
          </div>
        ))}
      </div>

      <button className="btn btn-quiet btn-sm" style={{ marginTop: 'var(--s2)' }} onClick={hide}>
        להסתיר את הרשימה
      </button>

      {open === 'card' && (
        <Sheet title="כרטיס אשראי" onClose={close}>
          {/* Named for whoever is adding it: in a home with two cards, «כרטיס
              אשראי» twice is a choice nobody can make at the till. */}
          <AccountForm onSaved={close} initialName={firstName(user) ? `הכרטיס של ${firstName(user)}` : 'כרטיס אשראי'} initialKind="credit" />
        </Sheet>
      )}
      {open === 'pantry' && (
        <Sheet title="מה קונים באופן קבוע" onClose={close}>
          <PantrySetup onDone={close} />
        </Sheet>
      )}
      {open === 'partner' && (
        <Sheet title="להזמין את בן או בת הזוג" onClose={close}>
          <InviteSection />
        </Sheet>
      )}
    </section>
  );
}

function StepAction({ step, isOwner, onOpen }: { step: SetupStepKey; isOwner: boolean; onOpen: (s: SetupStepKey) => void }) {
  switch (step) {
    case 'card':
      return <button className="btn btn-sm" onClick={() => onOpen('card')}>הוספה</button>;
    case 'budget':
      return (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s1)' }}>
          <Link to="/budget" className="btn btn-sm">לתקציב</Link>
          <Link to="/budget/excel" className="btn btn-sm btn-quiet">מאקסל</Link>
        </span>
      );
    case 'pantry':
      return <button className="btn btn-sm" onClick={() => onOpen('pantry')}>לסמן</button>;
    case 'partner':
      // Only an owner can mint an invite; anyone else would get a refusal.
      return isOwner ? <button className="btn btn-sm" onClick={() => onOpen('partner')}>קישור</button> : null;
  }
}

/**
 * The pantry's starting point, in one sheet: which staples this home buys
 * regularly, and how many of each is in the house tonight.
 *
 * Marking a staple gives it its suggested minimum, which is what makes the
 * shopping list write itself; a count adds a batch to the shelf. Stock goes in
 * before the minimum, so a staple marked with nothing at home lands on the
 * list at once — which is exactly right — and one with enough at home does not.
 */
function PantrySetup({ onDone }: { onDone: () => void }) {
  const products = useAsync(() => api.get<Product[]>('/pantry/products'));
  const toast = useToast();
  const [regular, setRegular] = useState<Record<number, boolean>>({});
  const [have, setHave] = useState<Record<number, string>>({});

  if (products.loading) return <Loading />;
  if (products.error) return <ErrorNote message={products.error} onRetry={products.reload} />;

  const list = (products.data ?? []).filter((p) => !p.archived_at);
  const isRegular = (p: Product) => regular[p.id] ?? p.min_qty > 0;

  return (
    <AsyncForm
      submitLabel="שמירה"
      onSubmit={async () => {
        let marked = 0;
        for (const p of list) {
          const qty = Number(have[p.id]);
          if (qty > 0) await api.post(`/pantry/products/${p.id}/stock`, { qty });
          const wants = isRegular(p);
          const min = wants ? (p.min_qty > 0 ? p.min_qty : SUGGESTED_MIN[p.name_key] ?? 1) : 0;
          if (min !== p.min_qty) {
            await api.patch(`/pantry/products/${p.id}`, { ...p, min_qty: min });
          }
          if (wants) marked++;
        }
        toast.show(marked ? `${marked} מוצרים ייכנסו לרשימה לבד כשייגמרו` : 'נשמר');
        onDone();
      }}
    >
      <p className="meta" style={{ marginBottom: 'var(--s3)' }}>
        סמנו מה אתם קונים באופן קבוע. כשמשהו מסומן נגמר, הוא נכנס לרשימת הקניות לבד.
        אם יש ממנו בבית עכשיו, כתבו כמה.
      </p>
      <div className="row label" style={{ minHeight: 32 }} aria-hidden="true">
        <span className="grow">קונים קבוע</span>
        <span style={{ width: 112 }}>יש עכשיו</span>
      </div>
      <div className="rows">
        {list.map((p) => (
          <div className="row" key={p.id} style={{ minHeight: 52 }}>
            <label className="grow" style={{ display: 'flex', alignItems: 'center', gap: 'var(--s2)', minHeight: 44 }}>
              <input
                type="checkbox"
                checked={isRegular(p)}
                onChange={(e) => setRegular((r) => ({ ...r, [p.id]: e.target.checked }))}
                style={{ width: 22, height: 22 }}
              />
              <span>{p.name}</span>
            </label>
            <input
              className="input"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              aria-label={`כמה ${p.name} יש בבית, ב${p.unit}`}
              placeholder={p.in_stock > 0 ? String(p.in_stock) : '0'}
              value={have[p.id] ?? ''}
              onChange={(e) => setHave((h) => ({ ...h, [p.id]: e.target.value }))}
              style={{ width: 72 }}
            />
            <span className="meta" style={{ minWidth: 40 }}>{p.unit}</span>
          </div>
        ))}
      </div>
    </AsyncForm>
  );
}
