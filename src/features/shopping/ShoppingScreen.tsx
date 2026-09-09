import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { actionId, useOutbox } from '../../lib/outbox.js';
import { useSession } from '../../lib/session.js';
import { AsyncForm, Empty, ErrorNote, Field, Fold, Loading, Sheet, useAsync, useFolds, useToast } from '../../ui/kit.js';
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
  const outbox = useOutbox();
  const folds = useFolds('shopping');

  // When the queue empties, the server is the truth again. Until then the
  // screen is showing what the person did, which is the whole point.
  useEffect(() => { if (outbox.drained > 0) list.reload(); }, [outbox.drained]);

  const items = list.data ?? [];
  const open = items.filter((i) => i.status === 'open');
  const bought = items.filter((i) => i.status === 'bought');

  const byAisle = sortForShopping(items).reduce<Record<string, ShoppingItem[]>>((acc, item) => {
    (acc[item.category] ??= []).push(item);
    return acc;
  }, {});

  const setStatus = (id: number, status: ShoppingItem['status']) =>
    list.set((prev) => (prev ?? []).map((i) => (i.id === id ? { ...i, status } : i)));

  // Every change goes through the queue rather than straight to the server.
  //
  // The old version awaited the request and reverted the row when it failed —
  // which is correct at a desk and exactly backwards in a supermarket, where a
  // failed request is the normal case and the tick is still true. Now the
  // screen changes immediately, the action waits its turn, and nothing is
  // undone because reception was bad in aisle four.
  function tick(item: ShoppingItem) {
    setStatus(item.id, 'bought');
    outbox.send({
      id: actionId(), verb: 'POST',
      path: `/shopping/items/${item.id}/buy`,
      subject: `item:${item.id}`,
    });
    // Whether it lands in the pantry is knowable from the item itself, so the
    // message stays true offline — where it used to come from the response.
    toast.show(
      item.product_id ? `${item.name} — נכנס למזווה` : `${item.name} — סומן`,
      { undo: () => untick(item) },
    );
  }

  function untick(item: ShoppingItem) {
    setStatus(item.id, 'open');
    outbox.send({
      id: actionId(), verb: 'POST',
      path: `/shopping/items/${item.id}/unbuy`,
      subject: `item:${item.id}`,
    });
  }

  function remove(item: ShoppingItem) {
    list.set((prev) => (prev ?? []).filter((i) => i.id !== item.id));
    outbox.send({
      id: actionId(), verb: 'DELETE',
      path: `/shopping/items/${item.id}`,
      subject: `item:${item.id}`,
    });
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
        <OfflineNote />
        {list.loading && !list.data && <Loading />}
        {list.error && <ErrorNote message={list.error} onRetry={list.reload} />}

        {!list.loading && items.length === 0 && (
          <Empty
            headline="אין מה לקנות"
            hint="פריטים ייכנסו לכאן לבד ברגע שמשהו במזווה יירד מתחת לכמות המינימלית שהגדרתם לו."
            action={<button className="btn" onClick={() => setAdding(true)}>הוספת פריט</button>}
          />
        )}

        {Object.entries(byAisle).map(([aisle, aisleItems]) => {
          const left = aisleItems.filter((i) => i.status === 'open').length;
          // Here the fold means something it means nowhere else in the app:
          // *done with this one*. So an aisle starts open — you are standing in
          // it — and an aisle with nothing left to pick up starts shut, which
          // is the list getting shorter as the trolley fills.
          //
          // `settle` is what keeps that from happening under a moving thumb:
          // the judgement is fixed when the aisle first appears, so ticking the
          // last item leaves it open — exactly as the list refuses to re-sort
          // itself mid-shop — and it opens folded on the next visit.
          const fallback = folds.settle(aisle, left > 0);
          return (
            <Fold
              key={aisle}
              id={aisle}
              title={aisle}
              count={<span className="n">{left}</span>}
              note={left === 0 ? <span className="meta">נלקח הכול</span> : null}
              open={folds.isOpen(aisle, fallback)}
              onToggle={() => folds.toggle(aisle, fallback)}
            >
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
            </Fold>
          );
        })}

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
          // client_id is what makes a replay safe: adding an item already on
          // the list bumps its quantity, so without it a lost response turns two
          // cartons into four. See db/schema.sql, "Working offline".
          await api.post('/shopping/items', {
            name, qty: Number(qty) || 1, note: note || undefined, client_id: actionId(),
          });
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


/**
 * What the list says about itself when the network is not cooperating.
 *
 * Deliberately not an error, and deliberately not a spinner: nothing has gone
 * wrong. The ticks are real, they are recorded, and they will be sent. The one
 * thing a person in a supermarket needs to know is that they can keep going —
 * so the quiet case says exactly that, and only a genuinely stuck action gets
 * the red pencil.
 */
function OfflineNote() {
  const { online, pending, parked, retry, discard } = useOutbox();

  if (parked.length === 0 && pending === 0 && online) return null;

  return (
    <section className="section" style={{ marginTop: 0 }}>
      {(!online || pending > 0) && parked.length === 0 && (
        <>
          <hr className="rule" style={{ margin: '0 0 var(--s3)' }} />
          <p className="meta" style={{ margin: 0 }}>
            {!online && pending > 0 && <>אין רשת. <span className="n">{pending}</span> פעולות מחכות וישלחו לבד.</>}
            {!online && pending === 0 && <>אין רשת. הרשימה עובדת, וכל סימון יישמר.</>}
            {online && pending > 0 && <>שולחים <span className="n">{pending}</span> פעולות…</>}
          </p>
          <hr className="rule" style={{ margin: 'var(--s3) 0 0' }} />
        </>
      )}

      {parked.length > 0 && (
        <div className="note-error" role="alert">
          <div style={{ marginBottom: 'var(--s2)' }}>
            <b>{parked.length} פעולות לא נשלחו.</b> הרשימה כאן עשויה להיות שונה ממה שיש בשרת.
          </div>
          {parked.slice(0, 4).map((a) => (
            <div className="row" key={a.id} style={{ minHeight: 40, borderBottom: 0 }}>
              <span className="grow meta">{a.failure}</span>
              <button className="btn btn-sm btn-quiet" onClick={() => discard(a.id)}>ביטול</button>
            </div>
          ))}
          <button className="btn btn-sm btn-red btn-block" style={{ marginTop: 'var(--s2)' }} onClick={retry}>
            לנסות שוב
          </button>
        </div>
      )}
    </section>
  );
}
