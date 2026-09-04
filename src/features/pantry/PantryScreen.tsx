import { useState } from 'react';
import { api } from '../../lib/api.js';
import { AsyncForm, Empty, ErrorNote, Field, Sheet, Spinner, useAsync, useToast } from '../../ui/kit.js';
import { TopBar } from '../../ui/TopBar.js';
import { AISLES, expiryState } from '@shared/pantry.js';
import type { Product } from '@shared/types.js';

const LOCATIONS = ['מזווה', 'מקרר', 'מקפיא', 'אמבטיה', 'ניקיון', 'אחר'] as const;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * What is in the house, and what is about to not be.
 *
 * The number that matters on this screen is not "how much do we have" but
 * "how much compared to how much we want to have" — `min_qty` is the whole
 * mechanism, because it is what turns an inventory (a chore) into a shopping
 * list (a service).
 */
export function PantryScreen() {
  const [filter, setFilter] = useState<'all' | 'low' | 'expiring'>('all');
  const [search, setSearch] = useState('');
  const products = useAsync(() => api.get<Product[]>('/pantry/products'));
  const [editing, setEditing] = useState<Product | null>(null);
  const [creating, setCreating] = useState(false);
  const [stocking, setStocking] = useState<Product | null>(null);
  const toast = useToast();

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

  async function consume(product: Product, qty: number) {
    // Optimistic, then reconciled: the tile drops immediately, and the server's
    // answer replaces the guess. Waiting first makes "השתמשנו באחד" feel broken.
    products.set((prev) => (prev ?? []).map((p) => (p.id === product.id ? { ...p, in_stock: Math.max(0, p.in_stock - qty) } : p)));
    try {
      const res = await api.post<{ added_to_list: string[] }>(`/pantry/products/${product.id}/consume`, { qty });
      if (res.added_to_list.length > 0) toast.show(`נוסף לרשימת הקניות: ${res.added_to_list.join(', ')}`);
      products.reload();
    } catch (err) {
      products.reload();
      toast.show(err instanceof Error ? err.message : 'לא הצלחנו לעדכן', 'bad');
    }
  }

  return (
    <>
      <TopBar
        title="מזווה"
        subtitle={low.length ? `${low.length} נגמרים` : `${all.length} מוצרים`}
      />

      <div className="page">
        <div className="chips" style={{ marginBottom: 14 }}>
          <button className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>הכול · {all.length}</button>
          <button className="chip" aria-pressed={filter === 'low'} onClick={() => setFilter('low')}>נגמר · {low.length}</button>
          <button className="chip" aria-pressed={filter === 'expiring'} onClick={() => setFilter('expiring')}>תוקף · {expiring.length}</button>
        </div>

        <input
          className="input"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="חיפוש מוצר…"
          style={{ marginBottom: 16 }}
        />

        {products.loading && !products.data && <Spinner />}
        {products.error && <ErrorNote message={products.error} onRetry={products.reload} />}

        {!products.loading && shown.length === 0 && (
          <Empty
            glyph="🥫"
            title={filter === 'all' ? 'המזווה ריק' : 'אין כאן כלום'}
            hint={filter === 'all' ? 'הוסיפו מוצר, קבעו לו כמות מינימלית, והרשימה תכתוב את עצמה.' : undefined}
            action={filter === 'all' ? <button className="btn btn-primary" onClick={() => setCreating(true)}>הוספת מוצר</button> : undefined}
          />
        )}

        {Object.entries(byAisle).map(([aisle, aisleProducts]) => (
          <section className="section" key={aisle}>
            <h2>{aisle}</h2>
            <div className="card">
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
            </div>
          </section>
        ))}
      </div>

      <button className="fab" onClick={() => setCreating(true)} aria-label="הוספת מוצר">+</button>

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
      <div className="grow">
        <button className="btn btn-quiet" onClick={onEdit} style={{ padding: 0, minHeight: 0, display: 'block', textAlign: 'start' }}>
          <span className="title">{product.name}</span>
        </button>
        <div className="meta">
          <span className="num">{product.in_stock}</span> {product.unit}
          {product.min_qty > 0 && <> · מינימום <span className="num">{product.min_qty}</span></>}
          {product.below_min && <> · <span className="pill bad">נגמר</span></>}
          {expiry === 'soon' && <> · <span className="pill warn">תוקף קרוב</span></>}
          {expiry === 'expired' && <> · <span className="pill bad">פג תוקף</span></>}
        </div>
      </div>
      <button className="btn btn-sm btn-ghost" onClick={() => onConsume(1)} disabled={product.in_stock <= 0} aria-label={`השתמשנו ב${product.name}`}>−</button>
      <button className="btn btn-sm btn-ghost" onClick={onStock} aria-label={`הוספת ${product.name} למלאי`}>+</button>
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
        <Field label="ימי מדף (למילוי תפוגה אוטומטי)">
          <input className="input" type="number" inputMode="numeric" min="0" value={shelfLife} onChange={(e) => setShelfLife(e.target.value)} placeholder="למשל 7 לחלב" />
        </Field>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          כמות מינימלית 0 = לא נטריד אתכם. מספר גדול מ-0 = ברגע שנרד מתחת אליו, המוצר נכנס לרשימת הקניות לבד.
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
    <Sheet title={`הכנסת ${product.name} למזווה`} onClose={onClose}>
      <AsyncForm
        submitLabel="הכנסה"
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
          <Field label={`כמה (${product.unit})`}>
            <input className="input" type="number" inputMode="decimal" min="0.1" step="0.5" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus />
          </Field>
          <Field label="מחיר (לא חובה)">
            <input className="input" type="number" inputMode="decimal" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
        </div>
        <Field label="תאריך תפוגה">
          <input className="input" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </Field>
        {product.shelf_life_days && !expiresOn && (
          <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
            אם תשאירו ריק, נחשב תפוגה של {product.shelf_life_days} ימים מהיום.
          </p>
        )}
      </AsyncForm>
    </Sheet>
  );
}
