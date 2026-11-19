import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { AsyncForm, ErrorNote, Field, Loading, Sheet, useAsync, useToast } from '../../ui/kit.js';
import { Icon } from '../../ui/Icon.js';
import { TopBar } from '../../ui/TopBar.js';
import { MoneyTabs } from './MoneyTabs.js';
import { billsPerMonth, CADENCE_LABELS, daysUntil, dueLabel, formatILS } from '@shared/money.js';
import type { Account, BalanceBetweenUs, Cadence, Category, RecurringBill } from '@shared/types.js';

const KIND_LABELS: Record<string, string> = {
  bank: 'בנק', cash: 'מזומן', credit: 'אשראי', savings: 'חיסכון',
};

const todayISO = () => new Date().toISOString().slice(0, 10);

/**
 * Where the money sits, what arrives whether or not anyone remembers it, and
 * who owes whom.
 *
 * The last two had a whole API — recurring bills with a «paid» action that
 * writes the transaction and moves the due date, a running balance between the
 * two of them with settlements — and no screen. The home page warned that a
 * bill was due and linked to the budget, where there was no bill to be found.
 *
 * The three answer the same kind of question, the one asked about the
 * household's money rather than about a month of it, so they share a page and
 * none of them has a month stepper.
 */
export function AccountsScreen() {
  const accounts = useAsync(() => api.get<Account[]>('/money/accounts'));
  const bills = useAsync(() => api.get<RecurringBill[]>('/money/bills'));
  const balance = useAsync(() => api.get<BalanceBetweenUs>('/money/balance'));
  const [addingAccount, setAddingAccount] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const toast = useToast();
  const [bill, setBill] = useState<RecurringBill | 'new' | null>(null);
  const [settling, setSettling] = useState(false);

  const all = accounts.data ?? [];
  const open = all.filter((a) => !a.archived_at);
  // An archived account that still holds money stays in the list and in the
  // total: archiving says «we stopped using it», not «that money is gone».
  // Only an empty one moves to the archive line at the bottom.
  const shown = all.filter((a) => !a.archived_at || a.balance !== 0);
  const shelved = all.filter((a) => a.archived_at && a.balance === 0);
  const net = shown.reduce((sum, a) => sum + a.balance, 0);

  return (
    <>
      <TopBar title="כסף" />

      <div className="page">
        <MoneyTabs />

        <section className="section">
          <h2>יתרות <span className="count">· ₪</span></h2>
          {accounts.error && <ErrorNote message={accounts.error} onRetry={accounts.reload} />}
          <div className="rows">
            {shown.map((a) => (
              <button className="row" key={a.id} onClick={() => setEditingAccount(a)}>
                <span className="grow" style={{ textAlign: 'start' }}>
                  <span className="title" style={{ display: 'block' }}>{a.name}</span>
                  <span className="meta">{KIND_LABELS[a.kind] ?? a.kind}{a.archived_at && ' · בארכיון'}</span>
                </span>
                <span className={`n amount ${a.balance < 0 ? 'over' : ''}`}>
                  {formatILS(a.balance, { symbol: false })}
                </span>
              </button>
            ))}
            {accounts.loading && <Loading />}
          </div>
          {shown.length > 0 && (
            <>
              <hr className="rule-2" />
              <div className="row" style={{ borderBottom: 0, minHeight: 44 }}>
                <span className="grow label">סך הכול</span>
                <span className={`n amount ${net < 0 ? 'over' : ''}`} style={{ fontWeight: 600 }}>
                  {formatILS(net, { symbol: false })}
                </span>
              </div>
            </>
          )}
          <button className="btn btn-block btn-sm" style={{ marginTop: 'var(--s3)' }} onClick={() => setAddingAccount(true)}>
            <Icon name="plus" size={16} /> הוספת חשבון
          </button>
          {shelved.length > 0 && (
            <div className="rows" style={{ marginTop: 'var(--s5)' }}>
              <div className="label" style={{ paddingBottom: 'var(--s2)', borderBottom: '1px solid var(--rule)' }}>
                בארכיון <span className="n" style={{ color: 'var(--ink-3)', fontWeight: 400 }}>· {shelved.length}</span>
              </div>
              {shelved.map((a) => (
                <div className="row" key={a.id} style={{ minHeight: 52, color: 'var(--ink-2)' }}>
                  <span className="grow">{a.name}</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => { void api.patch(`/money/accounts/${a.id}`, { archived: false }).then(accounts.reload); }}
                  >
                    להחזיר
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <Bills
          bills={bills.data}
          loading={bills.loading}
          error={bills.error}
          onRetry={bills.reload}
          onOpen={setBill}
        />

        {balance.data && balance.data.per_person.length >= 2 && (
          <Between balance={balance.data} onSettle={() => setSettling(true)} />
        )}
      </div>

      {editingAccount && (
        <Sheet title={editingAccount.name} onClose={() => setEditingAccount(null)}>
          <AccountForm
            account={editingAccount}
            onSaved={() => { setEditingAccount(null); accounts.reload(); }}
            onArchived={() => {
              const archived = editingAccount;
              setEditingAccount(null);
              accounts.reload();
              toast.show(`${archived.name} הועבר לארכיון`, {
                undo: () => { void api.patch(`/money/accounts/${archived.id}`, { archived: false }).then(accounts.reload); },
              });
            }}
          />
        </Sheet>
      )}

      {addingAccount && (
        <Sheet title="חשבון חדש" onClose={() => setAddingAccount(false)}>
          <AccountForm onSaved={() => { setAddingAccount(false); accounts.reload(); }} />
        </Sheet>
      )}

      {bill && (
        <BillSheet
          bill={bill === 'new' ? null : bill}
          accounts={open}
          onClose={() => setBill(null)}
          onSaved={() => {
            setBill(null);
            bills.reload();
            // Paying writes a transaction, which moves an account balance and,
            // when the bill is shared, the balance between the two of them.
            accounts.reload();
            balance.reload();
          }}
        />
      )}

      {settling && balance.data && (
        <SettleSheet
          balance={balance.data}
          onClose={() => setSettling(false)}
          onSaved={() => { setSettling(false); balance.reload(); }}
        />
      )}
    </>
  );
}

/**
 * The bills, soonest first, each with its date said in words.
 *
 * The figure under the double rule is what they take out of an average month,
 * so a yearly insurance does not read as if it were charged every month.
 * Red is kept for the one case the palette reserves it for: a date that has
 * passed and nobody marked paid. A direct debit pays itself and is never late.
 */
function Bills({ bills, loading, error, onRetry, onOpen }: {
  bills: RecurringBill[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpen: (bill: RecurringBill | 'new') => void;
}) {
  const today = todayISO();
  const list = bills ?? [];
  const active = list.filter((b) => b.active);
  const paused = list.filter((b) => !b.active);

  return (
    <section className="section">
      <h2>חיובים קבועים <span className="count">· ₪</span></h2>
      {error && <ErrorNote message={error} onRetry={onRetry} />}
      <div className="rows">
        {[...active, ...paused].map((b) => {
          const days = daysUntil(b.next_due, today);
          const late = b.active && !b.autopay && days < 0;
          return (
            <button className="row" key={b.id} onClick={() => onOpen(b)}>
              <span className="grow" style={{ textAlign: 'start' }}>
                <span className="title" style={{ display: 'block' }}>{b.name}</span>
                <span className="meta">
                  {b.active ? CADENCE_LABELS[b.cadence] : 'מושהה'}
                  {b.active && <> · {late ? <span className="mark mark-red">באיחור · {dueLabel(days)}</span> : dueLabel(days)}</>}
                  {b.active && b.autopay && ' · הוראת קבע'}
                </span>
              </span>
              <span className="n amount">{formatILS(b.amount_estimate, { symbol: false })}</span>
            </button>
          );
        })}
        {loading && !bills && <Loading />}
      </div>
      {active.length > 0 && (
        <>
          <hr className="rule-2" />
          <div className="row" style={{ borderBottom: 0, minHeight: 44 }}>
            <span className="grow label">בממוצע לחודש</span>
            <span className="n amount" style={{ fontWeight: 600 }}>{formatILS(billsPerMonth(active), { symbol: false })}</span>
          </div>
        </>
      )}
      {bills && list.length === 0 && (
        <p className="meta" style={{ marginTop: 'var(--s2)' }}>
          ארנונה, חשמל, ועד בית, ביטוח. רושמים פעם אחת, וקאסה מזכירה כמה ימים לפני.
        </p>
      )}
      <button className="btn btn-block btn-sm" style={{ marginTop: 'var(--s3)' }} onClick={() => onOpen('new')}>
        <Icon name="plus" size={16} /> הוספת חיוב קבוע
      </button>
    </section>
  );
}

/**
 * Who owes whom, as one sentence and the arithmetic under it.
 *
 * Shared spending splits evenly; what each paid is beside what each share
 * came to, so the sentence at the top can be checked by subtraction.
 */
function Between({ balance, onSettle }: { balance: BalanceBetweenUs; onSettle: () => void }) {
  const name = (email: string | null) =>
    balance.per_person.find((p) => p.email === email)?.display_name ?? email?.split('@')[0] ?? '';
  const square = balance.amount < 1;

  return (
    <section className="section">
      <h2>בינינו <span className="count">· ₪</span></h2>
      <div className="rows">
        {balance.per_person.map((p) => (
          <div className="row" key={p.email} style={{ minHeight: 56 }}>
            <span className="grow">
              <span className="title" style={{ display: 'block' }}>{p.display_name}</span>
              <span className="meta">
                שילם <span className="n">{formatILS(p.paid, { symbol: false })}</span>
                {' · '}חלק <span className="n">{formatILS(p.owes, { symbol: false })}</span>
              </span>
            </span>
            <span className="n amount">{formatILS(p.net, { sign: true, symbol: false })}</span>
          </div>
        ))}
      </div>
      <hr className="rule-2" />
      <div className="row" style={{ borderBottom: 0, minHeight: 48 }}>
        <span className="grow label">
          {square ? 'אנחנו מאוזנים' : `${name(balance.from_email)} מעביר ל${name(balance.to_email)}`}
        </span>
        {!square && (
          <span className="n amount" style={{ fontWeight: 600 }}>{formatILS(balance.amount, { symbol: false })}</span>
        )}
      </div>
      {!square && (
        <button className="btn btn-block btn-sm" style={{ marginTop: 'var(--s3)' }} onClick={onSettle}>
          רישום העברה בינינו
        </button>
      )}
    </section>
  );
}

function SettleSheet({ balance, onClose, onSaved }: {
  balance: BalanceBetweenUs; onClose: () => void; onSaved: () => void;
}) {
  const [amount, setAmount] = useState(String(Math.round(balance.amount)));
  const name = (email: string | null) =>
    balance.per_person.find((p) => p.email === email)?.display_name ?? '';

  return (
    <Sheet title={`${name(balance.from_email)} מעביר ל${name(balance.to_email)}`} onClose={onClose}>
      <AsyncForm
        submitLabel="רישום ההעברה"
        disabled={!(Number(amount) > 0)}
        onSubmit={async () => {
          await api.post('/money/settlements', {
            from_email: balance.from_email, to_email: balance.to_email, amount: Number(amount),
          });
          onSaved();
        }}
      >
        <Field label="כמה הועבר · ₪">
          <input className="input" type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus style={{ fontSize: 24 }} />
        </Field>
        <p className="meta" style={{ marginBottom: 'var(--s4)' }}>
          ההעברה עצמה קורית בבנק או בביט. כאן רק רושמים אותה, כדי שהחשבון בינינו יתאפס.
        </p>
      </AsyncForm>
    </Sheet>
  );
}

/**
 * Writing a bill, correcting it, and marking it paid.
 *
 * Paid is the action that matters: it writes the transaction and moves the
 * bill to its next date in one step, so it is offered first when the bill is
 * not a direct debit. There is no delete — a bill nobody pays any more is
 * paused, which keeps the transactions it wrote pointing at something.
 */
function BillSheet({ bill, accounts, onClose, onSaved }: {
  bill: RecurringBill | null;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { user } = useSession();
  const categories = useAsync(() => api.get<Category[]>('/money/categories'));
  const [name, setName] = useState(bill?.name ?? '');
  const [amount, setAmount] = useState(bill ? String(bill.amount_estimate) : '');
  const [cadence, setCadence] = useState<Cadence>(bill?.cadence ?? 'monthly');
  const [nextDue, setNextDue] = useState(bill?.next_due ?? todayISO());
  const [accountId, setAccountId] = useState(bill?.account_id ? String(bill.account_id) : String(accounts[0]?.id ?? ''));
  const [categoryId, setCategoryId] = useState(bill?.category_id ? String(bill.category_id) : '');
  const [autopay, setAutopay] = useState(bill?.autopay ?? false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const body = (active: boolean) => ({
    name, cadence, next_due: nextDue, autopay, active,
    amount_estimate: Number(amount) || 0,
    account_id: accountId ? Number(accountId) : null,
    category_id: categoryId ? Number(categoryId) : null,
    remind_days: bill?.remind_days ?? 3,
    note: bill?.note ?? null,
  });

  const act = async (what: () => Promise<string>) => {
    setBusy(true);
    setFailure(null);
    try {
      toast.show(await what());
      onSaved();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'משהו השתבש');
    } finally {
      setBusy(false);
    }
  };

  const pay = () => act(async () => {
    const res = await api.post<{ next_due: string }>(`/money/bills/${bill!.id}/pay`, {
      amount: Number(amount) || undefined,
      account_id: accountId ? Number(accountId) : undefined,
      occurred_on: todayISO(),
    });
    return `נרשם ששולם · הבא ב־${new Date(`${res.next_due}T00:00:00`).toLocaleDateString('he-IL', { day: 'numeric', month: 'long' })}`;
  });

  const spending = (categories.data ?? []).filter((c) => c.kind !== 'income' && !c.archived_at);
  const canWrite = user?.role !== 'viewer';

  return (
    <Sheet title={bill ? bill.name : 'חיוב קבוע חדש'} onClose={onClose}>
      {bill && bill.active && !bill.autopay && canWrite && (
        <>
          <button className="btn btn-primary btn-block" disabled={busy || !accountId} onClick={() => void pay()}>
            שולם · <span className="n">{formatILS(Number(amount) || 0)}</span>
          </button>
          <p className="meta" style={{ margin: 'var(--s2) 0 var(--s5)' }}>
            נרשמת הוצאה להיום, והחיוב עובר לתאריך הבא.
          </p>
        </>
      )}
      {failure && <ErrorNote message={failure} />}

      <AsyncForm
        submitLabel={bill ? 'שמירה' : 'הוספה'}
        disabled={!name.trim() || busy}
        onSubmit={async () => {
          if (bill) await api.patch(`/money/bills/${bill.id}`, body(bill.active));
          else await api.post('/money/bills', body(true));
          toast.show(bill ? 'נשמר' : 'החיוב נוסף');
          onSaved();
        }}
      >
        <Field label="שם">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="ארנונה" autoFocus={!bill} />
        </Field>
        <div className="row-2">
          <Field label="סכום משוער · ₪">
            <input className="input" type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="כל כמה זמן">
            <select className="select" value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
              {Object.entries(CADENCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
        </div>
        <div className="row-2">
          <Field label="החיוב הבא">
            <input className="input" type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} />
          </Field>
          <Field label="מאיזה חשבון">
            <select className="select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">—</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="קטגוריה">
          <select className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">לא משויך</option>
            {spending.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <label className="row" style={{ minHeight: 48, borderBottom: 0, marginBottom: 'var(--s3)' }}>
          <input type="checkbox" checked={autopay} onChange={(e) => setAutopay(e.target.checked)} style={{ width: 22, height: 22 }} />
          <span className="grow">הוראת קבע · יורד לבד, בלי תזכורת</span>
        </label>
      </AsyncForm>

      {bill && canWrite && (
        <button
          className="btn btn-block btn-sm"
          style={{ marginTop: 'var(--s3)' }}
          disabled={busy}
          onClick={() => void act(async () => {
            await api.patch(`/money/bills/${bill.id}`, body(!bill.active));
            return bill.active ? 'החיוב הושהה' : 'החיוב חזר';
          })}
        >
          {bill.active ? 'להשהות · לא משלמים את זה יותר' : 'להחזיר למעקב'}
        </button>
      )}
    </Sheet>
  );
}

export function AccountForm({ onSaved, onArchived, account, initialName = '', initialKind = 'bank' }: {
  onSaved: () => void;
  onArchived?: () => void;
  /** Editing this one rather than adding. */
  account?: Account;
  initialName?: string;
  initialKind?: string;
}) {
  const [name, setName] = useState(account?.name ?? initialName);
  const [kind, setKind] = useState<string>(account?.kind ?? initialKind);
  const [opening, setOpening] = useState(String(account?.opening_balance ?? 0));
  const [archiveError, setArchiveError] = useState<string | null>(null);

  return (
    <>
      <AsyncForm
        submitLabel={account ? 'שמירה' : 'הוספה'}
        disabled={!name.trim()}
        onSubmit={async () => {
          const body = { name: name.trim(), kind, opening_balance: Number(opening) || 0 };
          if (account) await api.patch(`/money/accounts/${account.id}`, body);
          else await api.post('/money/accounts', body);
          onSaved();
        }}
      >
        <Field label="שם">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!account} placeholder="עובר ושב" />
        </Field>
        <div className="row-2">
          <Field label="סוג">
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="יתרת פתיחה · ₪">
            <input className="input" type="number" inputMode="decimal" step="0.01" value={opening} onChange={(e) => setOpening(e.target.value)} />
          </Field>
        </div>
        <p className="meta" style={{ marginBottom: 'var(--s4)' }}>
          יתרת פתיחה היא איפה החשבון עמד ביום שהתחלנו לעקוב. היתרה המוצגת היא היא ועוד כל תנועה מאז — לעולם לא מספר שמור.
        </p>
      </AsyncForm>

      {/* docs/DESIGN.md §5ד: last, alone, and saying what happens to the money. */}
      {account && !account.archived_at && onArchived && (
        <div style={{ marginTop: 'var(--s5)', borderTop: '1px solid var(--rule)', paddingTop: 'var(--s4)' }}>
          {archiveError && <ErrorNote message={archiveError} />}
          <button
            type="button"
            className="btn btn-red btn-block"
            onClick={() => {
              setArchiveError(null);
              api.patch(`/money/accounts/${account.id}`, { archived: true })
                .then(onArchived)
                .catch((err: Error) => setArchiveError(err.message));
            }}
          >
            להעביר לארכיון
          </button>
          <p className="meta" style={{ marginTop: 'var(--s2)' }}>
            {account.balance !== 0
              ? `החשבון לא יופיע בבחירת חשבון לתנועה חדשה. היתרה, ${formatILS(account.balance)}, תישאר בסך עד שתתאפס.`
              : 'החשבון לא יופיע בבחירת חשבון לתנועה חדשה. התנועות שכבר נרשמו נשארות.'}
          </p>
        </div>
      )}
      {account?.archived_at && (
        <button
          type="button"
          className="btn btn-block"
          style={{ marginTop: 'var(--s4)' }}
          onClick={() => { void api.patch(`/money/accounts/${account.id}`, { archived: false }).then(onSaved); }}
        >
          להחזיר מהארכיון
        </button>
      )}
    </>
  );
}
