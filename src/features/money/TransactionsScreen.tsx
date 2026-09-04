import { useState } from 'react';
import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { useSession } from '../../lib/session.js';
import { AsyncForm, Empty, ErrorNote, Field, Sheet, Spinner, useAsync, useToast } from '../../ui/kit.js';
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

  return (
    <>
      <TopBar
        title="תנועות"
        subtitle={`${items.length} החודש`}
        action={<Link to="/budget" className="btn btn-sm btn-ghost">תקציב</Link>}
      />

      <div className="page">
        {balance.data && <BalanceCard balance={balance.data} onSettled={() => { balance.reload(); toast.show('נרשם'); }} />}

        <Field label="חודש">
          <input
            className="input"
            type="month"
            value={month.slice(0, 7)}
            onChange={(e) => setMonth(e.target.value ? `${e.target.value}-01` : month)}
          />
        </Field>

        {transactions.loading && !transactions.data && <Spinner />}
        {transactions.error && <ErrorNote message={transactions.error} onRetry={transactions.reload} />}

        {!transactions.loading && items.length === 0 && (
          <Empty glyph="🧾" title="אין תנועות בחודש הזה" action={<button className="btn btn-primary" onClick={() => setAdding(true)}>רישום הוצאה</button>} />
        )}

        {Object.entries(byDay).map(([day, dayItems]) => (
          <section className="section" key={day}>
            <h2>{new Date(`${day}T00:00:00`).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
            <div className="card">
              <div className="rows">
                {dayItems.map((t) => (
                  <div className="row" key={t.id}>
                    <div className="grow">
                      <div className="title">{t.payee || t.category_name || 'ללא שם'}</div>
                      <div className="meta">
                        {t.category_name ?? 'לא משויך'} · {t.account_name}
                        {t.split === 'personal' && <> · <span className="pill">אישי</span></>}
                      </div>
                    </div>
                    <div className="num" style={{ fontWeight: 600, color: t.amount > 0 ? 'var(--sage)' : 'var(--ink)' }}>
                      {formatILS(t.amount, { sign: true })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        ))}
      </div>

      <button className="fab" onClick={() => setAdding(true)} aria-label="רישום תנועה">+</button>

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
 * Deliberately one sentence and one button. The wedding system taught this the
 * hard way in the opposite direction: there, "who owes whom" was left out on
 * purpose because between two sets of parents it would have been a scoreboard.
 * Between two people sharing one household it is the opposite — leaving it out
 * is what turns "I got the shopping again" into a conversation nobody enjoys.
 */
function BalanceCard({ balance, onSettled }: { balance: BalanceBetweenUs; onSettled: () => void }) {
  const [settling, setSettling] = useState(false);
  const names = new Map(balance.per_person.map((p) => [p.email, p.display_name]));

  if (balance.amount === 0) {
    return (
      <div className="card card-pad" style={{ textAlign: 'center', background: 'var(--sage-soft)', borderColor: 'var(--sage)' }}>
        <strong style={{ color: 'var(--sage)' }}>אנחנו מסודרים ✓</strong>
      </div>
    );
  }

  return (
    <>
      <div className="card card-pad" style={{ background: 'var(--clay-soft)', borderColor: 'var(--clay)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="grow">
            <div style={{ fontSize: 13, color: 'var(--clay)', fontWeight: 500 }}>איזון בינינו</div>
            <div style={{ fontWeight: 600 }}>
              {names.get(balance.from_email ?? '') ?? 'מישהו'} חייב ל{names.get(balance.to_email ?? '') ?? 'מישהו'}{' '}
              <span className="num">{formatILS(balance.amount)}</span>
            </div>
          </div>
          <button className="btn btn-sm btn-primary" onClick={() => setSettling(true)}>סגירה</button>
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
      <Field label="כמה הועבר">
        <input className="input" type="number" inputMode="decimal" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
      </Field>
      <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
        זה לא נרשם כהוצאה חדשה — רק מאפס את מה שאחד חייב לשני.
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
      <div className="chips" style={{ marginBottom: 16 }}>
        <button type="button" className="chip" aria-pressed={kind === 'spend'} onClick={() => { setKind('spend'); setCategoryId(''); }}>הוצאה</button>
        <button type="button" className="chip" aria-pressed={kind === 'income'} onClick={() => { setKind('income'); setCategoryId(''); }}>הכנסה</button>
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
        <Field label="סכום">
          <input className="input" type="number" inputMode="decimal" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus placeholder="0.00" />
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
              <option value="">— ללא —</option>
              {usable.map((c) => <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ''}{c.name}</option>)}
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
          <div className="chips" style={{ marginBottom: 16 }}>
            <button type="button" className="chip" aria-pressed={split === 'shared'} onClick={() => setSplit('shared')}>משותף</button>
            <button type="button" className="chip" aria-pressed={split === 'personal'} onClick={() => setSplit('personal')}>אישי</button>
          </div>
        )}
        {!openAccounts.length && !accounts.loading && (
          <p style={{ color: 'var(--bad)', fontSize: 14, marginBottom: 12 }}>
            אין חשבונות. פתחו אחד ב«הגדרות» לפני רישום תנועה.
          </p>
        )}
      </AsyncForm>
    </Sheet>
  );
}
