import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { AsyncForm, Empty, ErrorNote, Field, Sheet, Spinner, useAsync, useToast } from '../../ui/kit.js';
import { TopBar } from '../../ui/TopBar.js';
import type { Account, Category, ShoppingItem } from '@shared/types.js';

/**
 * The list, standing up, one-handed, in an aisle.
 *
 * Everything on this screen is sized for that: taps are large, the tick is
 * optimistic (the row moves the instant it is touched, not when the server
 * agrees), and items are grouped by aisle in walking order rather than by when
 * they were typed — the order they were typed in is the one order guaranteed
 * to walk the shop twice.
 */
export function ShoppingScreen() {
  const list = useAsync(() => api.get<ShoppingItem[]>('/shopping/items', { status: 'open' }));
  const bought = useAsync(() => api.get<ShoppingItem[]>('/shopping/items', { status: 'bought' }));
  const [adding, setAdding] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const toast = useToast();

  const items = list.data ?? [];
  const boughtItems = bought.data ?? [];

  const byAisle = items.reduce<Record<string, ShoppingItem[]>>((acc, item) => {
    (acc[item.category] ??= []).push(item);
    return acc;
  }, {});

  async function tick(item: ShoppingItem) {
    // Optimistic: the row leaves the open list immediately. A tick that waits
    // for the network reads as a dead button on supermarket wifi, and gets
    // tapped again.
    list.set((prev) => (prev ?? []).filter((i) => i.id !== item.id));
    try {
      const result = await api.post<{ stocked: boolean }>(`/shopping/items/${item.id}/buy`);
      bought.reload();
      if (result.stocked) toast.show(`${item.name} — נוסף למזווה`);
    } catch (err) {
      list.reload();
      toast.show(err instanceof Error ? err.message : 'לא הצלחנו לסמן', 'bad');
    }
  }

  async function untick(item: ShoppingItem) {
    bought.set((prev) => (prev ?? []).filter((i) => i.id !== item.id));
    try {
      await api.post(`/shopping/items/${item.id}/unbuy`);
      list.reload();
    } catch {
      bought.reload();
    }
  }

  async function remove(item: ShoppingItem) {
    list.set((prev) => (prev ?? []).filter((i) => i.id !== item.id));
    await api.del(`/shopping/items/${item.id}`).catch(() => list.reload());
  }

  return (
    <>
      <TopBar
        title="רשימת קניות"
        subtitle={items.length ? `${items.length} פריטים` : 'הרשימה ריקה'}
        action={boughtItems.length > 0 ? (
          <button className="btn btn-sm btn-primary" onClick={() => setCheckingOut(true)}>
            סיום ({boughtItems.length})
          </button>
        ) : null}
      />

      <div className="page">
        {list.loading && !list.data && <Spinner />}
        {list.error && <ErrorNote message={list.error} onRetry={list.reload} />}

        {!list.loading && items.length === 0 && boughtItems.length === 0 && (
          <Empty
            glyph="🛒"
            title="אין מה לקנות"
            hint="פריטים ייכנסו לכאן לבד כשמשהו במזווה יירד מתחת למינימום."
            action={<button className="btn btn-primary" onClick={() => setAdding(true)}>הוספת פריט</button>}
          />
        )}

        {Object.entries(byAisle).map(([aisle, aisleItems]) => (
          <section className="section" key={aisle}>
            <h2>{aisle}</h2>
            <div className="card">
              <div className="rows">
                {aisleItems.map((item) => (
                  <div className="row" key={item.id}>
                    <button
                      className="btn btn-quiet"
                      onClick={() => void tick(item)}
                      aria-label={`סמנו ${item.name} כנקנה`}
                      style={{ fontSize: 22, minWidth: 34, padding: 0 }}
                    >
                      ⬜
                    </button>
                    <div className="grow">
                      <div className="title">{item.name}</div>
                      <div className="meta">
                        <span className="num">{item.qty}</span> {item.unit}
                        {item.source === 'auto_min_stock' && <> · <span className="pill warn">נגמר במזווה</span></>}
                        {item.note && <> · {item.note}</>}
                      </div>
                    </div>
                    <button className="btn btn-quiet muted" onClick={() => void remove(item)} aria-label={`הסרת ${item.name}`}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          </section>
        ))}

        {boughtItems.length > 0 && (
          <section className="section">
            <h2>בסל ({boughtItems.length})</h2>
            <div className="card">
              <div className="rows">
                {boughtItems.map((item) => (
                  <div className="row" key={item.id} style={{ opacity: .6 }}>
                    <button className="btn btn-quiet" onClick={() => void untick(item)} aria-label={`החזרת ${item.name} לרשימה`} style={{ fontSize: 22, minWidth: 34, padding: 0 }}>✅</button>
                    <div className="grow">
                      <div className="title" style={{ textDecoration: 'line-through' }}>{item.name}</div>
                      <div className="meta"><span className="num">{item.qty}</span> {item.unit}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
      </div>

      <button className="fab" onClick={() => setAdding(true)} aria-label="הוספת פריט">+</button>

      {adding && <AddItemSheet onClose={() => setAdding(false)} onAdded={() => { setAdding(false); list.reload(); }} />}
      {checkingOut && (
        <CheckoutSheet
          count={boughtItems.length}
          onClose={() => setCheckingOut(false)}
          onDone={() => { setCheckingOut(false); bought.reload(); list.reload(); toast.show('הקנייה נסגרה'); }}
        />
      )}
    </>
  );
}

function AddItemSheet({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [qty, setQty] = useState('1');
  const [note, setNote] = useState('');

  return (
    <Sheet title="הוספת פריט" onClose={onClose}>
      <AsyncForm
        submitLabel="הוספה"
        disabled={!name.trim()}
        onSubmit={async () => {
          await api.post('/shopping/items', { name, qty: Number(qty) || 1, note: note || undefined });
          onAdded();
        }}
      >
        <Field label="מה צריך">
          {/* autoFocus is right here and almost nowhere else: the sheet was
              opened by pressing "+", so typing is unambiguously the next step. */}
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="חלב, נייר טואלט…" />
        </Field>
        <div className="row-2">
          <Field label="כמה">
            <input className="input" type="number" inputMode="decimal" min="0.1" step="0.5" value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
          <Field label="הערה">
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="3% / גדול" />
          </Field>
        </div>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          אם המוצר מוכר לנו במזווה, סימון «נקנה» יכניס אותו למלאי לבד.
        </p>
      </AsyncForm>
    </Sheet>
  );
}

/**
 * Closing a trip: the basket empties, and one line lands in the budget.
 *
 * One transaction for the whole run, not one per item. ₪412 in the grocery
 * envelope is a number somebody reads; forty lines of ₪3.90 is a more precise
 * budget that nobody ever opens.
 */
function CheckoutSheet({ count, onClose, onDone }: { count: number; onClose: () => void; onDone: () => void }) {
  const { user } = useSession();
  const accounts = useAsync(() => api.get<Account[]>('/money/accounts'));
  const categories = useAsync(() => api.get<Category[]>('/money/categories'));
  const [total, setTotal] = useState('');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [payee, setPayee] = useState('');

  const spending = (categories.data ?? []).filter((c) => c.kind === 'spending' && !c.archived_at);
  const grocery = spending.find((c) => c.name.includes('סופר'));

  return (
    <Sheet title={`סיום קנייה — ${count} פריטים`} onClose={onClose}>
      <AsyncForm
        submitLabel={total ? 'סגירה ורישום בתקציב' : 'סגירה בלי לרשום'}
        onSubmit={async () => {
          await api.post('/shopping/checkout', {
            total: total ? Number(total) : undefined,
            account_id: accountId || (accounts.data?.[0]?.id ?? undefined),
            category_id: categoryId || grocery?.id,
            payee: payee || undefined,
            paid_by: user?.email,
          });
          onDone();
        }}
      >
        <Field label="כמה שילמנו (אפשר לדלג)">
          <input className="input" type="number" inputMode="decimal" min="0" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="412.90" />
        </Field>
        {total && (
          <>
            <Field label="איפה">
              <input className="input" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="שופרסל" />
            </Field>
            <div className="row-2">
              <Field label="מאיזה חשבון">
                <select className="select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  {(accounts.data ?? []).filter((a) => !a.archived_at).map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="לאיזו קטגוריה">
                <select className="select" value={categoryId || grocery?.id || ''} onChange={(e) => setCategoryId(e.target.value)}>
                  {spending.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
            </div>
          </>
        )}
      </AsyncForm>
    </Sheet>
  );
}
