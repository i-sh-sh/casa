import { useState } from 'react';
import { api } from '../../lib/api.js';
import { AsyncForm, Empty, ErrorNote, Field, Fold, Loading, Sheet, useAsync, useFolds, useToast } from '../../ui/kit.js';
import { Icon } from '../../ui/Icon.js';
import { TopBar } from '../../ui/TopBar.js';
import { AISLES, expiryState } from '@shared/pantry.js';
import type { Product } from '@shared/types.js';

const LOCATIONS = ['מזווה', 'מקרר', 'מקפיא', 'אמבטיה', 'ניקיון', 'אחר'] as const;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * What is in the house, and what is about to not be.
 *
 * The figure that matters is not "how much" but "how much against how much we
 * want" — `min_qty` is the whole mechanism, because it is what turns an
 * inventory (a chore nobody keeps up) into a shopping list (a service).
 *
 * The minus button is the most important control in the entire app. Ten
 * seconds after finishing the milk is the only moment it will ever be
 * recorded, and if that costs a search box and a form it will not happen —
 * and once the stock is wrong, the list that depends on it is worthless.
 */
export function PantryScreen() {
  const [filter, setFilter] = useState<'all' | 'low' | 'expiring'>('all');
  const [search, setSearch] = useState('');
  const products = useAsync(() => api.get<Product[]>('/pantry/products'));
  const [editing, setEditing] = useState<Product | null>(null);
  const [creating, setCreating] = useState(false);
  const [stocking, setStocking] = useState<Product | null>(null);
  const toast = useToast();
  const folds = useFolds('pantry');

  const all = products.data ?? [];
  const low = all.filter((p) => p.below_min);
  const expiring = all.filter((p) => {
    const state = expiryState(p.next_expiry, today());
    return state === 'soon' || state === 'expired';
  });

  const shown = (filter === 'low' ? low : filter === 'expiring' ? expiring : all)
    .filter((p) => !search || p.name.includes(search));

  const byAisle = shown.reduce<Record<string, Product[]>>((acc, p) => {
    (acc[p.category] ??= []).push(p);
    return acc;
  }, {});

  /**
   * Which aisles start shut.
   *
   * A pantry of fifteen products is a list and reads fine open; a pantry of
   * sixty is eight aisles deep, and the two things that need doing are
   * somewhere in the middle of them. So the fold earns its tap only past a
   * threshold — below it, shutting sections would be a tax with nothing bought.
   *
   * Two exceptions, and they are the point of the whole screen. **An aisle
   * holding something that ran out or is going off is never shut by default**,
   * because hiding exactly what the screen exists to surface would be a worse
   * screen with a tidier first impression. And a deliberate narrowing — a
   * filter, a search — opens everything: somebody who typed «חלב» is asking to
   * see it, not to be told which aisle it is in.
   */
  const narrowing = filter !== 'all' || search.trim() !== '';
  const crowded = shown.length > 12;
  const defaultOpen = (needsAttention: boolean) =>
    narrowing || !crowded || needsAttention;

  async function consume(product: Product, qty: number) {
    // Optimistic, then reconciled. Nothing stands between the tap and the
    // number changing: a wait here gets tapped twice, and a double decrement
    // corrupts the count that the shopping list is generated from.
    products.set((prev) => (prev ?? []).map((p) => (p.id === product.id ? { ...p, in_stock: Math.max(0, p.in_stock - qty) } : p)));
    try {
      const res = await api.post<{ added_to_list: string[] }>(`/pantry/products/${product.id}/consume`, { qty });
      if (res.added_to_list.length > 0) toast.show(`נכנס לרשימת הקניות · ${res.added_to_list.join(', ')}`);
      products.reload();
    } catch (err) {
      products.reload();
      toast.show(err instanceof Error ? err.message : 'לא הצלחנו לעדכן', { tone: 'bad' });
    }
  }

  return (
    <>
      <TopBar title="מזווה" subtitle={low.length ? `${low.length} נגמרים` : `${all.length} מוצרים`} />

      <div className="page">
        <div className="tabs">
          <button className="tab" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            הכול <span className="n">{all.length}</span>
          </button>
          <button className="tab" aria-pressed={filter === 'low'} onClick={() => setFilter('low')}>
            נגמר <span className="n">{low.length}</span>
          </button>
          <button className="tab" aria-pressed={filter === 'expiring'} onClick={() => setFilter('expiring')}>
            תוקף <span className="n">{expiring.length}</span>
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s2)', marginTop: 'var(--s4)' }}>
          <Icon name="search" size={18} />
          <input
            className="input"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש מוצר"
            aria-label="חיפוש מוצר"
          />
        </div>

        {products.loading && !products.data && <Loading />}
        {products.error && <ErrorNote message={products.error} onRetry={products.reload} />}

        {!products.loading && shown.length === 0 && (
          <Empty
            headline={filter === 'all' ? 'המזווה ריק' : 'אין כאן כלום'}
            hint={filter === 'all' ? 'הוסיפו מוצר, קבעו לו כמות מינימלית, והרשימה תכתוב את עצמה מכאן והלאה.' : undefined}
            action={filter === 'all' ? <button className="btn" onClick={() => setCreating(true)}>הוספת מוצר</button> : undefined}
          />
        )}

        {Object.entries(byAisle).map(([aisle, aisleProducts]) => {
          const needs = aisleProducts.filter(
            (p) => p.below_min || expiryState(p.next_expiry, today()) !== 'ok',
          ).length;
          const fallback = defaultOpen(folds.settle(aisle, needs > 0));
          return (
            <Fold
              key={aisle}
              id={aisle}
              title={aisle}
              count={<span className="n">{aisleProducts.length}</span>}
              // The reason to open it, kept visible while it is shut. A fold
              // that hides the signal along with the detail has made the
              // screen worse rather than shorter.
              note={needs > 0 ? <span className="mark mark-red">{needs} לטיפול</span> : null}
              open={folds.isOpen(aisle, fallback)}
              onToggle={() => folds.toggle(aisle, fallback)}
            >
              <div className="rows">
                {aisleProducts.map((product) => (
                  <ProductRow
                    key={product.id}
                    product={product}
                    onConsume={(qty) => void consume(product, qty)}
                    onStock={() => setStocking(product)}
                    onEdit={() => setEditing(product)}
                  />
                ))}
              </div>
            </Fold>
          );
        })}

        <button className="btn btn-block" style={{ marginTop: 'var(--s6)' }} onClick={() => setCreating(true)}>
          <Icon name="plus" size={18} /> הוספת מוצר
        </button>
      </div>

      {(creating || editing) && (
        <ProductSheet
          product={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); products.reload(); }}
        />
      )}
      {stocking && (
        <StockSheet
          product={stocking}
          onClose={() => setStocking(null)}
          onSaved={() => { setStocking(null); products.reload(); toast.show('נכנס למזווה'); }}
        />
      )}
    </>
  );
}

function ProductRow({ product, onConsume, onStock, onEdit }: {
  product: Product;
  onConsume: (qty: number) => void;
  onStock: () => void;
  onEdit: () => void;
}) {
  const expiry = expiryState(product.next_expiry, today());
  return (
    <div className="row">
      <button onClick={onEdit} className="grow" style={{ minWidth: 0 }} aria-label={`עריכת ${product.name}`}>
        <span className="title" style={{ display: 'block' }}>{product.name}</span>
        <span className="meta">
          {product.min_qty > 0 && <>מינימום <span className="n">{product.min_qty}</span></>}
          {/* A state is never carried by colour or a glyph alone — two people
              who see a private symbol once a week will never learn it. */}
          {product.below_min && <> · <span className="mark mark-red">נגמר</span></>}
          {expiry === 'soon' && <> · <span className="mark mark-red">תוקף קרוב</span></>}
          {expiry === 'expired' && <> · <span className="mark mark-red">פג תוקף</span></>}
        </span>
      </button>

      <span className="n" style={{ fontSize: 20, fontWeight: 500, minWidth: '2.5em', textAlign: 'right' }}>
        {product.in_stock}
      </span>
      <span className="meta" style={{ minWidth: '2.5em' }}>{product.unit}</span>

      <button className="btn btn-sm" onClick={() => onConsume(1)} disabled={product.in_stock <= 0} aria-label={`השתמשנו באחד — ${product.name}`}>
        <Icon name="minus" size={16} />
      </button>
      <button className="btn btn-sm" onClick={onStock} aria-label={`הכנסה למזווה — ${product.name}`}>
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}

function ProductSheet({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(product?.name ?? '');
  const [unit, setUnit] = useState(product?.unit ?? 'יח׳');
  const [category, setCategory] = useState(product?.category ?? 'כללי');
  const [minQty, setMinQty] = useState(String(product?.min_qty ?? 0));
  const [location, setLocation] = useState<string>(product?.default_location ?? 'מזווה');
  const [shelfLife, setShelfLife] = useState(product?.shelf_life_days ? String(product.shelf_life_days) : '');

  return (
    <Sheet title={product ? product.name : 'מוצר חדש'} onClose={onClose}>
      <AsyncForm
        submitLabel={product ? 'שמירה' : 'הוספה'}
        disabled={!name.trim()}
        onSubmit={async () => {
          const payload = {
            name, unit, category,
            min_qty: Number(minQty) || 0,
            default_location: location,
            shelf_life_days: shelfLife ? Number(shelfLife) : null,
          };
          if (product) await api.patch(`/pantry/products/${product.id}`, payload);
          else await api.post('/pantry/products', payload);
          onSaved();
        }}
      >
        <Field label="שם">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!product} />
        </Field>
        <div className="row-2">
          <Field label="יחידה">
            <input className="input" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="יח׳ / ק״ג / ליטר" />
          </Field>
          <Field label="מדף">
            <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
              {AISLES.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
        </div>
        <div className="row-2">
          <Field label="כמות מינימלית">
            <input className="input" type="number" inputMode="decimal" min="0" step="1" value={minQty} onChange={(e) => setMinQty(e.target.value)} />
          </Field>
          <Field label="איפה נשמר">
            <select className="select" value={location} onChange={(e) => setLocation(e.target.value)}>
              {LOCATIONS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </Field>
        </div>
        <Field label="ימי מדף · למילוי תפוגה אוטומטי">
          <input className="input" type="number" inputMode="numeric" min="0" value={shelfLife} onChange={(e) => setShelfLife(e.target.value)} placeholder="7" />
        </Field>
        <p className="meta" style={{ marginBottom: 'var(--s4)' }}>
          כמות מינימלית 0 — לא נטריד אתכם על המוצר הזה. מספר גדול מ־0 — ברגע שנרד מתחתיו הוא נכנס לרשימת הקניות מעצמו.
        </p>
      </AsyncForm>
    </Sheet>
  );
}

function StockSheet({ product, onClose, onSaved }: { product: Product; onClose: () => void; onSaved: () => void }) {
  const [qty, setQty] = useState('1');
  const [expiresOn, setExpiresOn] = useState('');
  const [price, setPrice] = useState('');

  return (
    <Sheet title={`הכנסת ${product.name}`} onClose={onClose}>
      <AsyncForm
        submitLabel="הכנסה למזווה"
        onSubmit={async () => {
          await api.post(`/pantry/products/${product.id}/stock`, {
            qty: Number(qty),
            expires_on: expiresOn || undefined,
            price: price ? Number(price) : undefined,
          });
          onSaved();
        }}
      >
        <div className="row-2">
          <Field label={`כמה · ${product.unit}`}>
            <input className="input" type="number" inputMode="decimal" min="0.1" step="1" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus />
          </Field>
          <Field label="מחיר · ₪">
            <input className="input" type="number" inputMode="decimal" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
        </div>
        <Field label="תאריך תפוגה">
          <input className="input" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </Field>
        {product.shelf_life_days && !expiresOn && (
          <p className="meta" style={{ marginBottom: 'var(--s4)' }}>
            ריק — נחשב <span className="n">{product.shelf_life_days}</span> ימים מהיום.
          </p>
        )}
      </AsyncForm>
    </Sheet>
  );
}
