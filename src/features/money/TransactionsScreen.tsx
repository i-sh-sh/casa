import { useState } from 'react';
import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { useSession } from '../../lib/session.js';
import { AsyncForm, Empty, ErrorNote, Field, Fold, Loading, Sheet, useAsync, useFolds, useToast } from '../../ui/kit.js';
import { Icon } from '../../ui/Icon.js';
import { TopBar } from '../../ui/TopBar.js';
import { formatILS, monthKey } from '@shared/money.js';
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
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const transactions = useAsync(() => api.get<Transaction[]>('/money/transactions', { month }), [month]);
  const [adding, setAdding] = useState(false);
  const toast = useToast();
  const folds = useFolds('transactions');

  const items = transactions.data ?? [];
  const byDay = items.reduce<Record<string, Transaction[]>>((acc, t) => {
    (acc[t.occurred_on] ??= []).push(t);
    return acc;
  }, {});
  const total = items.reduce((sum, t) => sum + t.amount, 0);

  return (
    <>
      <TopBar
        title="תנועות"
        subtitle={`${items.length} החודש`}
        action={<Link to="/budget" className="btn btn-sm">תקציב</Link>}
      />

      <div className="page">
        <Field label="חודש">
          <input
            className="input"
            type="month"
            value={month.slice(0, 7)}
            onChange={(e) => setMonth(e.target.value ? `${e.target.value}-01` : month)}
          />
        </Field>

        {transactions.loading && !transactions.data && <Loading />}
        {transactions.error && <ErrorNote message={transactions.error} onRetry={transactions.reload} />}

        {!transactions.loading && items.length === 0 && (
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
              open={folds.isOpen(day, false)}
              onToggle={() => folds.toggle(day, false)}
            >
              <div className="rows">
                {dayItems.map((t) => (
                  <div className="row" key={t.id}>
                    <span className="grow">
                      <span className="title" style={{ display: 'block' }}>{t.payee || t.category_name || 'ללא שם'}</span>
                      <span className="meta">
                        {t.category_name ?? 'לא משויך'} · {t.account_name}
                      </span>
                    </span>
                    {/* Income is not green. It is simply not negative — which in a
                        ledger is the whole distinction, and the only one needed. */}
                    <span className="n amount">{formatILS(t.amount, { sign: true, agorot: true, symbol: false })}</span>
                  </div>
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

      {adding && (
        <TransactionSheet
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); transactions.reload(); toast.show('נרשם'); }}
        />
      )}
    </>
  );
}

function TransactionSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { user } = useSession();
  const accounts = useAsync(() => api.get<Account[]>('/money/accounts'));
  const categories = useAsync(() => api.get<Category[]>('/money/categories'));

  const [kind, setKind] = useState<'spend' | 'income'>('spend');
  const [amount, setAmount] = useState('');
  const [payee, setPayee] = useState('');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [occurredOn, setOccurredOn] = useState(todayISO());

  const usable = (categories.data ?? []).filter((c) => !c.archived_at && (kind === 'income' ? c.kind === 'income' : c.kind !== 'income'));
  const openAccounts = (accounts.data ?? []).filter((a) => !a.archived_at);

  return (
    <Sheet title="תנועה חדשה" onClose={onClose}>
      <div className="tabs" style={{ marginBottom: 'var(--s5)' }}>
        <button type="button" className="tab" aria-pressed={kind === 'spend'} onClick={() => { setKind('spend'); setCategoryId(''); }}>הוצאה</button>
        <button type="button" className="tab" aria-pressed={kind === 'income'} onClick={() => { setKind('income'); setCategoryId(''); }}>הכנסה</button>
      </div>

      <AsyncForm
        submitLabel="שמירה"
        disabled={!amount || !openAccounts.length}
        onSubmit={async () => {
          const magnitude = Math.abs(Number(amount));
          await api.post('/money/transactions', {
            occurred_on: occurredOn,
            account_id: Number(accountId) || openAccounts[0]?.id,
            category_id: categoryId ? Number(categoryId) : null,
            amount: kind === 'income' ? magnitude : -magnitude,
            payee,
            paid_by: user?.email ?? '',
            split: 'shared',
          });
          onSaved();
        }}
      >
        <Field label="סכום · ₪">
          <input className="input" type="number" inputMode="decimal" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus placeholder="0" style={{ fontSize: 24 }} />
        </Field>
        <Field label={kind === 'income' ? 'ממי' : 'למי'}>
          <input className="input" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder={kind === 'income' ? 'משכורת' : 'שופרסל'} />
        </Field>
        <div className="row-2">
          <Field label="חשבון">
            <select className="select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {openAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="קטגוריה">
            <select className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">ללא</option>
              {usable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="תאריך">
          <input className="input" type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />
        </Field>
        {!openAccounts.length && !accounts.loading && (
          <p style={{ color: 'var(--red)', fontSize: 15, marginBottom: 'var(--s3)' }}>
            אין חשבונות. פתחו אחד ב«הגדרות» לפני רישום תנועה.
          </p>
        )}
      </AsyncForm>
    </Sheet>
  );
}
