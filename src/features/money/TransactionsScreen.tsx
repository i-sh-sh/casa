import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { AsyncForm, Empty, ErrorNote, Field, Fold, Loading, Sheet, useAsync, useFolds, useToast } from '../../ui/kit.js';
import { Icon } from '../../ui/Icon.js';
import { TopBar } from '../../ui/TopBar.js';
import { MonthStepper } from '../../ui/MonthStepper.js';
import { MoneyTabs, useMoneyMonth } from './MoneyTabs.js';
import { formatILS } from '@shared/money.js';
import { nameKey } from '@shared/budget-workbook.js';
import type { Account, Category, Transaction } from '@shared/types.js';

const todayISO = () => new Date().toISOString().slice(0, 10);

/**
 * A month of transactions, read as days.
 *
 * Flat, this screen was ninety rows in a scroll: every purchase of every day
 * with nothing between them but a date heading, and no way to answer the
 * question anybody actually opens it with — «כמה יצא ביום שישי». The rows are
 * the record; the days are what is read.
 *
 * So each day folds, and shut it says the two things worth knowing: how many
 * movements, and what they came to. Opening one is for when the total surprises
 * you, which is exactly when a list of payees is worth reading.
 */
export function TransactionsScreen() {
  const [month, setMonth] = useMoneyMonth();
  const transactions = useAsync(() => api.get<Transaction[]>('/money/transactions', { month }), [month]);
  // «לא שויך» on the budget lands here narrowed to exactly those rows: the
  // budget can say they exist, and this is the only screen that can file them.
  const [unfiledOnly, setUnfiledOnly] = useState(
    () => new URLSearchParams(location.search).get('show') === 'unfiled',
  );
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const toast = useToast();
  const folds = useFolds('transactions');

  const all = transactions.data ?? [];
  const isUnfiled = (t: Transaction) => t.category_id === null && t.transfer_id === null;
  const unfiledCount = all.filter(isUnfiled).length;
  const narrowed = unfiledOnly && unfiledCount > 0;
  const items = narrowed ? all.filter(isUnfiled) : all;
  const byDay = items.reduce<Record<string, Transaction[]>>((acc, t) => {
    (acc[t.occurred_on] ??= []).push(t);
    return acc;
  }, {});
  const total = items.reduce((sum, t) => sum + t.amount, 0);

  return (
    <>
      <TopBar title="כסף" />

      <div className="page">
        <MoneyTabs />
        <MonthStepper month={month} onChange={setMonth} />

        {/* The month's to-do, as a narrowing rather than a section: the rows
            are already on this screen, in their days. One ruled row, there
            only when something needs filing, so a tidy month shows nothing
            extra — a second strip of tabs under the money tabs was three
            rules stacked before the first transaction. */}
        {unfiledCount > 0 && (
          <div className="rows">
            <button className="row" style={{ minHeight: 52 }} aria-pressed={narrowed} onClick={() => setUnfiledOnly(!narrowed)}>
              <span className="margin-col figure-col n">{unfiledCount}</span>
              <span className="grow">לא שויכו לקטגוריה</span>
              <span className="mark mark-blue">{narrowed ? 'להציג הכול' : 'להציג רק אותן'}</span>
            </button>
          </div>
        )}

        {transactions.loading && !transactions.data && <Loading />}
        {transactions.error && <ErrorNote message={transactions.error} onRetry={transactions.reload} />}

        {!transactions.loading && all.length === 0 && (
          <Empty
            headline="אין תנועות בחודש הזה"
            action={<button className="btn" onClick={() => setAdding(true)}>רישום הוצאה</button>}
          />
        )}

        {Object.entries(byDay).map(([day, dayItems]) => {
          const dayTotal = dayItems.reduce((sum, t) => sum + t.amount, 0);
          return (
            <Fold
              key={day}
              id={day}
              title={new Date(`${day}T00:00:00`).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}
              count={<span className="n">{dayItems.length}</span>}
              // The day's total, in the same column the rows hang their amounts
              // in — so a shut month reads as one ruled column of days, which
              // is the view this screen never had.
              note={
                <span className={`n amount ${dayTotal < 0 ? 'over' : ''}`}>
                  {formatILS(dayTotal, { sign: true, symbol: false })}
                </span>
              }
              // Narrowed to the rows that need filing, every day is open: the
              // point of the filter is to see them, and it can only open.
              open={folds.isOpen(day, narrowed)}
              onToggle={() => folds.toggle(day, narrowed)}
            >
              <div className="rows">
                {dayItems.map((t) => (
                  // The whole row opens it, as every row in this app does. A
                  // transaction is the one thing here that is typed in a hurry
                  // — the wrong category, a digit short — and until now the
                  // only way to correct one was to know it could not be done.
                  <button className="row" key={t.id} onClick={() => setEditing(t)}>
                    <span className="grow" style={{ textAlign: 'start' }}>
                      <span className="title" style={{ display: 'block' }}>{t.payee || t.category_name || 'ללא שם'}</span>
                      <span className="meta">
                        {t.category_name ?? 'לא משויך'} · {t.account_name}
                        {t.installment_no && <> · תשלום <span className="n">{t.installment_no}/{t.installments_total}</span></>}
                        {t.paid_by && <> · שילם {t.paid_by.split('@')[0]}</>}
                      </span>
                    </span>
                    {/* Income is not green. It is simply not negative — which in a
                        ledger is the whole distinction, and the only one needed. */}
                    <span className="n amount">{formatILS(t.amount, { sign: true, agorot: true, symbol: false })}</span>
                  </button>
                ))}
              </div>
            </Fold>
          );
        })}

        {items.length > 0 && (
          <>
            <hr className="rule-2" style={{ marginTop: 'var(--s5)' }} />
            <div className="row" style={{ borderBottom: 0 }}>
              <span className="grow label">סך החודש</span>
              <span className={`n amount ${total < 0 ? 'over' : ''}`} style={{ fontSize: 20, fontWeight: 600 }}>
                {formatILS(total, { sign: true })}
              </span>
            </div>
          </>
        )}

        <button className="btn btn-block" style={{ marginTop: 'var(--s6)' }} onClick={() => setAdding(true)}>
          <Icon name="plus" size={18} /> תנועה חדשה
        </button>
      </div>

      {(adding || editing) && (
        <TransactionSheet
          transaction={editing}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={(what, day) => {
            setAdding(false); setEditing(null);
            // Before the reload, so the row is visible the moment it arrives.
            folds.reveal(day);
            transactions.reload();
            toast.show(what);
          }}
        />
      )}
    </>
  );
}

/**
 * One sheet, for writing a transaction and for correcting one.
 *
 * A transaction is the thing in this app that is typed fastest and wrongest: in
 * a queue, one-handed, with a receipt in the other hand. The wrong category, a
 * digit short, the wrong person marked as having paid. The API has accepted
 * PATCH and DELETE since the beginning; the screen simply never offered a way
 * in, so the only remedy for a mistyped ₪450 was to live with it.
 *
 * **Editing sends every field, because the endpoint replaces every field.**
 * That is why `paid_by` and `split` are carried through rather than defaulted:
 * a PATCH that quietly re-stamped every corrected transaction with whoever
 * happened to be holding the phone would silently rewrite the balance between
 * the two of them — the one number in the app they are most likely to be
 * keeping score with, corrupted by the act of fixing a typo.
 */
export function TransactionSheet({ transaction, onClose, onSaved }: {
  transaction: Transaction | null;
  onClose: () => void;
  /** `day` is the date it landed on, so the screen can open that day. */
  onSaved: (message: string, day: string) => void;
}) {
  const { user, members } = useSession();
  const accounts = useAsync(() => api.get<Account[]>('/money/accounts'));
  const categories = useAsync(() => api.get<Category[]>('/money/categories'));
  const rules = useAsync(() => api.get<{ payee_key: string; category_id: number }[]>('/money/payee-rules'));

  const editing = transaction !== null;
  const [kind, setKind] = useState<'spend' | 'income'>(
    transaction && transaction.amount > 0 ? 'income' : 'spend',
  );
  const [amount, setAmount] = useState(transaction ? String(Math.abs(transaction.amount)) : '');
  const [payee, setPayee] = useState(transaction?.payee ?? '');
  const [accountId, setAccountId] = useState(transaction ? String(transaction.account_id) : '');
  const [categoryId, setCategoryId] = useState(transaction?.category_id ? String(transaction.category_id) : '');
  const [occurredOn, setOccurredOn] = useState(transaction?.occurred_on ?? todayISO());
  const [paidBy, setPaidBy] = useState(transaction?.paid_by ?? user?.email ?? '');
  const [installmentNo, setInstallmentNo] = useState(transaction?.installment_no ? String(transaction.installment_no) : '');
  const [installmentsTotal, setInstallmentsTotal] = useState(transaction?.installments_total ? String(transaction.installments_total) : '');
  // Set when the category was filled from an earlier decision about this
  // payee, and cleared the moment the person picks one themselves — so the
  // note under the field is only ever true.
  const [suggested, setSuggested] = useState(false);

  const changePayee = (value: string) => {
    setPayee(value);
    if (categoryId && !suggested) return;
    const learned = (rules.data ?? []).find((r) => r.payee_key === nameKey(value));
    const fits = learned && (categories.data ?? []).some((c) => c.id === learned.category_id
      && !c.archived_at && (kind === 'income' ? c.kind === 'income' : c.kind !== 'income'));
    if (fits) { setCategoryId(String(learned.category_id)); setSuggested(true); }
    else if (suggested) { setCategoryId(''); setSuggested(false); }
  };
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const usable = (categories.data ?? []).filter((c) => !c.archived_at && (kind === 'income' ? c.kind === 'income' : c.kind !== 'income'));
  const openAccounts = (accounts.data ?? []).filter((a) => !a.archived_at);
  // Most of a household's spending is on a card, so a new spend starts there
  // once one exists; the bank account the seed opens is the fallback.
  const fallbackAccount = (kind === 'spend' ? openAccounts.find((a) => a.kind === 'credit') : undefined) ?? openAccounts[0];

  async function remove() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.del(`/money/transactions/${transaction!.id}`);
      onSaved('נמחקה', transaction!.occurred_on);
    } catch (err) {
      setDeleting(false);
      setDeleteError(err instanceof Error ? err.message : 'לא הצלחנו למחוק');
    }
  }

  return (
    <Sheet title={editing ? 'עריכת תנועה' : 'תנועה חדשה'} onClose={onClose}>
      <div className="tabs" style={{ marginBottom: 'var(--s5)' }}>
        <button type="button" className="tab" aria-pressed={kind === 'spend'} onClick={() => { setKind('spend'); setCategoryId(''); }}>הוצאה</button>
        <button type="button" className="tab" aria-pressed={kind === 'income'} onClick={() => { setKind('income'); setCategoryId(''); }}>הכנסה</button>
      </div>

      <AsyncForm
        submitLabel={editing ? 'שמירה' : 'רישום'}
        disabled={!amount || !openAccounts.length}
        onSubmit={async () => {
          const magnitude = Math.abs(Number(amount));
          const body = {
            occurred_on: occurredOn,
            account_id: Number(accountId) || fallbackAccount?.id,
            category_id: categoryId ? Number(categoryId) : null,
            amount: kind === 'income' ? magnitude : -magnitude,
            payee,
            paid_by: paidBy || user?.email || '',
            // Preserved rather than defaulted: PATCH replaces the row, and a
            // personal expense corrected for a typo must not become shared.
            split: transaction?.split ?? 'shared',
            installment_no: kind === 'spend' && installmentNo && installmentsTotal ? Number(installmentNo) : null,
            installments_total: kind === 'spend' && installmentNo && installmentsTotal ? Number(installmentsTotal) : null,
          };
          if (editing) {
            await api.patch(`/money/transactions/${transaction.id}`, body);
            onSaved('עודכנה', occurredOn);
          } else {
            await api.post('/money/transactions', body);
            onSaved('נרשמה', occurredOn);
          }
        }}
      >
        <Field label="סכום · ₪">
          <input className="input" type="number" inputMode="decimal" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus placeholder="0" style={{ fontSize: 24 }} />
        </Field>
        <Field label={kind === 'income' ? 'ממי' : 'למי'}>
          <input className="input" value={payee} onChange={(e) => changePayee(e.target.value)} placeholder={kind === 'income' ? 'משכורת' : 'שופרסל'} />
        </Field>
        <div className="row-2">
          <Field label="חשבון">
            <select className="select" value={accountId || String(fallbackAccount?.id ?? '')} onChange={(e) => setAccountId(e.target.value)}>
              {openAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="קטגוריה">
            <select className="select" value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setSuggested(false); }}>
              <option value="">ללא</option>
              {usable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>
        {suggested && (
          <p className="meta" style={{ marginTop: 'calc(-1 * var(--s3))', marginBottom: 'var(--s3)' }}>
            הקטגוריה לפי הפעם הקודמת ש«{payee.trim()}» נרשם. אפשר לשנות.
          </p>
        )}
        {/* A purchase in installments is one row per charge. Which one this
            is, of how many, is what lets the budget say what is still owed. */}
        {kind === 'spend' && (
          <div className="row-2">
            <Field label="תשלום מספר">
              <input className="input" type="number" inputMode="numeric" min="1" value={installmentNo} onChange={(e) => setInstallmentNo(e.target.value)} placeholder="—" />
            </Field>
            <Field label="מתוך">
              <input className="input" type="number" inputMode="numeric" min="2" value={installmentsTotal} onChange={(e) => setInstallmentsTotal(e.target.value)} placeholder="—" />
            </Field>
          </div>
        )}
        <div className="row-2">
          <Field label="תאריך">
            <input className="input" type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />
          </Field>
          {/* The field the balance between the two of them is built from, and
              the one most often wrong — the phone that records the shop is not
              always the card that paid for it. */}
          <Field label="מי שילם">
            <select className="select" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
              {members.map((m) => <option key={m.email} value={m.email}>{m.display_name}</option>)}
              {!members.some((m) => m.email === paidBy) && paidBy && (
                <option value={paidBy}>{paidBy.split('@')[0]}</option>
              )}
            </select>
          </Field>
        </div>
        {!openAccounts.length && !accounts.loading && (
          <p style={{ color: 'var(--red)', fontSize: 15, marginBottom: 'var(--s3)' }}>
            אין חשבונות. פתחו אחד ב«כסף» ← «חשבונות» לפני רישום תנועה.
          </p>
        )}
      </AsyncForm>

      {editing && (
        // Two steps, not a native confirm(): a browser dialog is the one piece
        // of chrome this app cannot style, and it would be the only rounded
        // thing on the screen. The delete is soft — api/money keeps the row and
        // stamps deleted_at — but there is no way back from inside the app, so
        // it is worth asking once.
        <div style={{ marginTop: 'var(--s5)', paddingTop: 'var(--s4)', borderTop: '1px solid var(--rule)' }}>
          {deleteError && <p style={{ color: 'var(--red)', fontSize: 15 }}>{deleteError}</p>}
          {confirmingDelete ? (
            <>
              <p className="meta" style={{ marginBottom: 'var(--s3)' }}>
                למחוק את התנועה? היא תרד מהתקציב ומהאיזון.
              </p>
              <div className="row-2">
                <button type="button" className="btn btn-red" onClick={() => void remove()} disabled={deleting}>
                  {deleting ? 'רגע…' : 'מחיקה'}
                </button>
                <button type="button" className="btn" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
                  השארה
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="btn btn-block btn-quiet" onClick={() => setConfirmingDelete(true)}>
              מחיקת התנועה
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}
