import { useState } from 'react';
import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { useSession } from '../../lib/session.js';
import { AsyncForm, Empty, ErrorNote, Field, Loading, Sheet, useAsync, useToast } from '../../ui/kit.js';
import { Icon } from '../../ui/Icon.js';
import { TopBar } from '../../ui/TopBar.js';
import { formatILS, monthKey } from '@shared/money.js';
import type { Account, BalanceBetweenUs, Category, Transaction } from '@shared/types.js';

const todayISO = () => new Date().toISOString().slice(0, 10);

export function TransactionsScreen() {
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const transactions = useAsync(() => api.get<Transaction[]>('/money/transactions', { month }), [month]);
  const balance = useAsync(() => api.get<BalanceBetweenUs>('/money/balance'));
  const [adding, setAdding] = useState(false);
  const toast = useToast();

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
        {balance.data && <Balance balance={balance.data} onSettled={() => { balance.reload(); toast.show('ההחזר נרשם'); }} />}

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

        {Object.entries(byDay).map(([day, dayItems]) => (
          <section className="section" key={day}>
            <h2>
              {new Date(`${day}T00:00:00`).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}
              <span className="count">· ₪</span>
            </h2>
            <div className="rows">
              {dayItems.map((t) => (
                <div className="row" key={t.id}>
                  <span className="grow">
                    <span className="title" style={{ display: 'block' }}>{t.payee || t.category_name || 'ללא שם'}</span>
                    <span className="meta">
                      {t.category_name ?? 'לא משויך'} · {t.account_name}
                      {t.split === 'personal' && ' · אישי'}
                    </span>
                  </span>
                  {/* Income is not green. It is simply not negative — which in a
                      ledger is the whole distinction, and the only one needed. */}
                  <span className="n amount">{formatILS(t.amount, { sign: true, agorot: true, symbol: false })}</span>
                </div>
              ))}
            </div>
          </section>
        ))}

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
          onSaved={() => { setAdding(false); transactions.reload(); balance.reload(); toast.show('נרשם'); }}
        />
      )}
    </>
  );
}

/**
 * Who is out of pocket.
 *
 * One sentence with two names in it and one button. Never a bare ±number the
 * reader has to interpret — a signed figure in an RTL line is genuinely
 * ambiguous, and this is the one screen where a misreading turns into an
 * argument.
 */
function Balance({ balance, onSettled }: { balance: BalanceBetweenUs; onSettled: () => void }) {
  const [settling, setSettling] = useState(false);
  const names = new Map(balance.per_person.map((p) => [p.email, p.display_name]));

  if (balance.amount === 0) {
    return (
      <div className="row" style={{ borderBottom: '1px solid var(--ink)' }}>
        <span className="grow label">איזון בינינו</span>
        <span>מסודרים</span>
      </div>
    );
  }

  return (
    <>
      <div className="hero" style={{ paddingTop: 'var(--s3)' }}>
        <div className="label">איזון בינינו</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--s3)', marginTop: 'var(--s2)' }}>
          <div style={{ flex: 1, fontSize: 17, lineHeight: 1.4 }}>
            {names.get(balance.from_email ?? '') ?? 'מישהו'} חייב ל{names.get(balance.to_email ?? '') ?? 'מישהו'}
            <div className="figure" style={{ fontSize: 'var(--t-head)' }}>{formatILS(balance.amount)}</div>
          </div>
          <button className="btn btn-primary" onClick={() => setSettling(true)}>סגירה</button>
        </div>
      </div>
      {settling && (
        <Sheet title="החזר בינינו" onClose={() => setSettling(false)}>
          <SettleForm balance={balance} onDone={() => { setSettling(false); onSettled(); }} />
        </Sheet>
      )}
    </>
  );
}

function SettleForm({ balance, onDone }: { balance: BalanceBetweenUs; onDone: () => void }) {
  const [amount, setAmount] = useState(String(balance.amount));
  return (
    <AsyncForm
      submitLabel="רישום ההחזר"
      onSubmit={async () => {
        await api.post('/money/settlements', {
          from_email: balance.from_email,
          to_email: balance.to_email,
          amount: Number(amount),
          occurred_on: todayISO(),
        });
        onDone();
      }}
    >
      <Field label="כמה הועבר · ₪">
        <input className="input" type="number" inputMode="decimal" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
      </Field>
      <p className="meta" style={{ marginBottom: 'var(--s4)' }}>
        לא נרשם כהוצאה חדשה. זה רק מאפס את מה שאחד חייב לשני.
      </p>
    </AsyncForm>
  );
}

function TransactionSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { user, members } = useSession();
  const accounts = useAsync(() => api.get<Account[]>('/money/accounts'));
  const categories = useAsync(() => api.get<Category[]>('/money/categories'));

  const [kind, setKind] = useState<'spend' | 'income'>('spend');
  const [amount, setAmount] = useState('');
  const [payee, setPayee] = useState('');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [paidBy, setPaidBy] = useState(user?.email ?? '');
  const [split, setSplit] = useState<'shared' | 'personal'>('shared');
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
            paid_by: paidBy,
            split: kind === 'income' ? 'personal' : split,
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
        <div className="row-2">
          <Field label="תאריך">
            <input className="input" type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />
          </Field>
          <Field label="מי שילם">
            <select className="select" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
              {members.map((m) => <option key={m.email} value={m.email}>{m.display_name}</option>)}
            </select>
          </Field>
        </div>
        {kind === 'spend' && (
          <div className="tabs" style={{ marginBottom: 'var(--s4)' }}>
            <button type="button" className="tab" aria-pressed={split === 'shared'} onClick={() => setSplit('shared')}>משותף</button>
            <button type="button" className="tab" aria-pressed={split === 'personal'} onClick={() => setSplit('personal')}>אישי</button>
          </div>
        )}
        {!openAccounts.length && !accounts.loading && (
          <p style={{ color: 'var(--red)', fontSize: 15, marginBottom: 'var(--s3)' }}>
            אין חשבונות. פתחו אחד ב«הגדרות» לפני רישום תנועה.
          </p>
        )}
      </AsyncForm>
    </Sheet>
  );
}
