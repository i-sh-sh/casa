import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { AsyncForm, Empty, ErrorNote, Field, Loading, Sheet, useAsync, useToast } from '../../ui/kit.js';
import { Icon } from '../../ui/Icon.js';
import { TopBar } from '../../ui/TopBar.js';
import { sortForShopping } from '@shared/pantry.js';
import { formatILS } from '@shared/money.js';
import type { Account, Category, ShoppingItem } from '@shared/types.js';

/**
 * The list, standing up, one hand, basket in the other.
 *
 * Two decisions here come straight from how it is actually used, and both are
 * the opposite of what looks tidiest:
 *
 * **A ticked item does not leave.** It stays exactly where it was, struck
 * through. A row that vanishes under the thumb destroys the sense of place on
 * a list you are walking down, and — worse — everything below it jumps up by
 * one row, which is how the next item gets ticked by accident. Bought items
 * are only separated out on the next visit.
 *
 * **The tick is optimistic and instantly reversible.** It writes to the
 * pantry, so it is the one destructive action in daily use; a confirmation
 * would be unusable in an aisle, but five seconds of undo is not. Nothing —
 * no spinner, no animation, no round trip — stands between the tap and the
 * mark.
 */
export function ShoppingScreen() {
  const list = useAsync(async () => {
    const [open, bought] = await Promise.all([
      api.get<ShoppingItem[]>('/shopping/items', { status: 'open' }),
      api.get<ShoppingItem[]>('/shopping/items', { status: 'bought' }),
    ]);
    return [...open, ...bought];
  });
  const [adding, setAdding] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const toast = useToast();

  const items = list.data ?? [];
  const open = items.filter((i) => i.status === 'open');
  const bought = items.filter((i) => i.status === 'bought');

  const byAisle = sortForShopping(items).reduce<Record<string, ShoppingItem[]>>((acc, item) => {
    (acc[item.category] ??= []).push(item);
    return acc;
  }, {});

  const setStatus = (id: number, status: ShoppingItem['status']) =>
    list.set((prev) => (prev ?? []).map((i) => (i.id === id ? { ...i, status } : i)));

  async function tick(item: ShoppingItem) {
    setStatus(item.id, 'bought');
    try {
      const result = await api.post<{ stocked: boolean }>(`/shopping/items/${item.id}/buy`);
      toast.show(
        result.stocked ? `${item.name} — נכנס למזווה` : `${item.name} — סומן`,
        { undo: () => void untick(item) },
      );
    } catch (err) {
      setStatus(item.id, 'open');
      toast.show(err instanceof Error ? err.message : 'לא הצלחנו לסמן', { tone: 'bad' });
    }
  }

  async function untick(item: ShoppingItem) {
    setStatus(item.id, 'open');
    try {
      await api.post(`/shopping/items/${item.id}/unbuy`);
    } catch {
      list.reload();
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
        subtitle={open.length ? `${open.length} עוד לא נקנו` : items.length ? 'הכול בסל' : 'הרשימה ריקה'}
        action={bought.length > 0 ? (
          <button className="btn btn-sm btn-primary" onClick={() => setCheckingOut(true)}>
            סיום ({bought.length})
          </button>
        ) : null}
      />

      <div className="page">
        {list.loading && !list.data && <Loading />}
        {list.error && <ErrorNote message={list.error} onRetry={list.reload} />}

        {!list.loading && items.length === 0 && (
          <Empty
            headline="אין מה לקנות"
            hint="פריטים ייכנסו לכאן לבד ברגע שמשהו במזווה יירד מתחת לכמות המינימלית שהגדרתם לו."
            action={<button className="btn" onClick={() => setAdding(true)}>הוספת פריט</button>}
          />
        )}

        {Object.entries(byAisle).map(([aisle, aisleItems]) => (
          <section className="section" key={aisle}>
            <h2>
              {aisle} <span className="count n">{aisleItems.filter((i) => i.status === 'open').length}</span>
            </h2>
            <div className="rows">
              {aisleItems.map((item) => (
                <Row
                  key={item.id}
                  item={item}
                  onToggle={() => void (item.status === 'open' ? tick(item) : untick(item))}
                  onRemove={() => void remove(item)}
                />
              ))}
            </div>
          </section>
        ))}

        {items.length > 0 && (
          <div style={{ marginTop: 'var(--s6)' }}>
            <button className="btn btn-block" onClick={() => setAdding(true)}>
              <Icon name="plus" size={18} /> הוספת פריט
            </button>
          </div>
        )}
      </div>

      {adding && <AddItemSheet onClose={() => setAdding(false)} onAdded={() => { setAdding(false); list.reload(); }} />}
      {checkingOut && (
        <CheckoutSheet
          count={bought.length}
          onClose={() => setCheckingOut(false)}
          onDone={() => { setCheckingOut(false); list.reload(); toast.show('הקנייה נסגרה'); }}
        />
      )}
    </>
  );
}

/**
 * One line of the list.
 *
 * The whole row is the tick target — 64px tall and full width — because the
 * alternative is a 24px checkbox aimed at while walking. The mark sits in the
 * right-hand margin where every mark in this app sits, and the quantity sits
 * at the left end where every number does.
 */
function Row({ item, onToggle, onRemove }: { item: ShoppingItem; onToggle: () => void; onRemove: () => void }) {
  const done = item.status === 'bought';
  return (
    <div className={`row ${item.source === 'auto_min_stock' && !done ? 'by-system' : ''}`}>
      <button
        onClick={onToggle}
        aria-pressed={done}
        aria-label={done ? `החזרת ${item.name} לרשימה` : `סימון ${item.name} כנקנה`}
        style={{
          flex: 1, display: 'flex', alignItems: 'center', gap: 'var(--s3)',
          minHeight: 'var(--row-h)', minWidth: 0,
        }}
      >
        <span className="margin-col" style={{ color: done ? 'var(--red)' : 'var(--ink)' }}>
          <Icon name={done ? 'box-ticked' : 'box'} size={22} />
        </span>
        <span className="grow">
          <span className={`title ${done ? 'struck' : ''}`} style={{ display: 'block' }}>{item.name}</span>
          <span className="meta">
            {item.source === 'auto_min_stock' && !done && <span className="mark mark-blue">נגמר במזווה · </span>}
            {item.note}
          </span>
        </span>
        <span className="n" style={{ fontSize: 20, fontWeight: 500, opacity: done ? .4 : 1 }}>
          {item.qty}
        </span>
        <span className="meta" style={{ opacity: done ? .4 : 1 }}>{item.unit}</span>
      </button>
      {!done && (
        <button className="btn btn-quiet" onClick={onRemove} aria-label={`הסרת ${item.name} מהרשימה`}>
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}

function AddItemSheet({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [qty, setQty] = useState('1');
  const [note, setNote] = useState('');

  return (
    <Sheet title="מה צריך" onClose={onClose}>
      <AsyncForm
        submitLabel="הוספה"
        disabled={!name.trim()}
        onSubmit={async () => {
          await api.post('/shopping/items', { name, qty: Number(qty) || 1, note: note || undefined });
          onAdded();
        }}
      >
        <Field label="פריט">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="חלב" />
        </Field>
        <div className="row-2">
          <Field label="כמות">
            <input className="input" type="number" inputMode="decimal" min="0.1" step="1" value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
          <Field label="הערה">
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="3%" />
          </Field>
        </div>
        <p className="meta" style={{ marginBottom: 'var(--s4)' }}>
          מוצר שמוכר לנו במזווה — סימון «נקנה» יכניס אותו למלאי מעצמו.
        </p>
      </AsyncForm>
    </Sheet>
  );
}

/** One trip closes to one line in the budget. Forty lines of ₪3.90 is a more precise budget that nobody reads. */
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
    <Sheet title={`סגירת קנייה · ${count} פריטים`} onClose={onClose}>
      <AsyncForm
        submitLabel={total ? 'סגירה ורישום בתקציב' : 'סגירה בלי רישום'}
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
        <Field label="כמה שילמנו · ₪">
          <input className="input" type="number" inputMode="decimal" min="0" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="0" autoFocus />
        </Field>
        {total && (
          <>
            <Field label="איפה">
              <input className="input" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="שופרסל" />
            </Field>
            <div className="row-2">
              <Field label="מחשבון">
                <select className="select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  {(accounts.data ?? []).filter((a) => !a.archived_at).map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="לקטגוריה">
                <select className="select" value={categoryId || grocery?.id || ''} onChange={(e) => setCategoryId(e.target.value)}>
                  {spending.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
            </div>
            <hr className="rule-2" style={{ margin: 'var(--s4) 0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--s4)' }}>
              <span className="label">סך הקנייה</span>
              <span className="n amount" style={{ fontSize: 20 }}>{formatILS(Number(total) || 0, { agorot: true })}</span>
            </div>
          </>
        )}
      </AsyncForm>
    </Sheet>
  );
}
