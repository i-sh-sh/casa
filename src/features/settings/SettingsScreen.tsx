import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { AsyncForm, Field, Sheet, Spinner, useAsync, useToast } from '../../ui/kit.js';
import { TopBar } from '../../ui/TopBar.js';
import { formatILS } from '@shared/money.js';
import type { Account, User } from '@shared/types.js';

const ROLE_LABELS: Record<string, string> = {
  owner: 'בעל הבית', member: 'שותף', viewer: 'צופה', pending: 'ממתין לאישור',
};

export function SettingsScreen() {
  const { user, signOut } = useSession();
  const accounts = useAsync(() => api.get<Account[]>('/money/accounts'));
  const [addingAccount, setAddingAccount] = useState(false);
  const isOwner = user?.role === 'owner';

  return (
    <>
      <TopBar title="הגדרות" subtitle={user?.email} />

      <div className="page">
        <section className="section">
          <h2>חשבונות</h2>
          <div className="card">
            <div className="rows">
              {(accounts.data ?? []).map((a) => (
                <div className="row" key={a.id}>
                  <div className="grow">
                    <div className="title">{a.name}</div>
                    <div className="meta">{a.kind === 'bank' ? 'בנק' : a.kind === 'cash' ? 'מזומן' : a.kind === 'credit' ? 'אשראי' : 'חיסכון'}</div>
                  </div>
                  <div className="num" style={{ fontWeight: 600, color: a.balance < 0 ? 'var(--bad)' : 'var(--ink)' }}>
                    {formatILS(a.balance)}
                  </div>
                </div>
              ))}
              {accounts.loading && <div className="row"><Spinner /></div>}
            </div>
          </div>
          <button className="btn btn-ghost btn-block btn-sm" style={{ marginTop: 10 }} onClick={() => setAddingAccount(true)}>
            הוספת חשבון
          </button>
        </section>

        <ThemeSection />

        {isOwner && <MembersSection currentEmail={user.email} />}
        {isOwner && <DatabaseSection />}

        <section className="section">
          <button className="btn btn-ghost btn-block" onClick={() => void signOut()}>יציאה</button>
        </section>

        <p className="muted" style={{ textAlign: 'center', fontSize: 12, marginTop: 28 }}>
          קאסה · הבית שלנו
        </p>
      </div>

      {addingAccount && (
        <Sheet title="חשבון חדש" onClose={() => setAddingAccount(false)}>
          <AccountForm onSaved={() => { setAddingAccount(false); accounts.reload(); }} />
        </Sheet>
      )}
    </>
  );
}

function AccountForm({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('bank');
  const [opening, setOpening] = useState('0');

  return (
    <AsyncForm
      submitLabel="הוספה"
      disabled={!name.trim()}
      onSubmit={async () => {
        await api.post('/money/accounts', { name, kind, opening_balance: Number(opening) || 0 });
        onSaved();
      }}
    >
      <Field label="שם">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="עובר ושב" />
      </Field>
      <div className="row-2">
        <Field label="סוג">
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="bank">בנק</option>
            <option value="cash">מזומן</option>
            <option value="credit">אשראי</option>
            <option value="savings">חיסכון</option>
          </select>
        </Field>
        <Field label="יתרת פתיחה">
          <input className="input" type="number" inputMode="decimal" step="0.01" value={opening} onChange={(e) => setOpening(e.target.value)} />
        </Field>
      </div>
      <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
        יתרת פתיחה היא איפה החשבון עמד ביום שהתחלנו לעקוב. היתרה המוצגת היא היא ועוד כל תנועה מאז.
      </p>
    </AsyncForm>
  );
}

/**
 * Three states, not two.
 *
 * A plain light/dark switch cannot express "follow the phone", which is what
 * most people actually want and what the app does before anyone touches this.
 * Storing the choice in localStorage rather than the database is deliberate:
 * it is a property of this screen, not of this person — the same account on a
 * laptop and a phone can reasonably want different answers.
 */
function ThemeSection() {
  const [theme, setTheme] = useState<string>(() => localStorage.getItem('casa-theme') ?? 'system');

  const apply = (next: string) => {
    setTheme(next);
    try {
      localStorage.setItem('casa-theme', next);
    } catch { /* private mode: the choice just does not persist */ }
    if (next === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', next);
  };

  return (
    <section className="section">
      <h2>מראה</h2>
      <div className="chips">
        <button className="chip" aria-pressed={theme === 'system'} onClick={() => apply('system')}>לפי המכשיר</button>
        <button className="chip" aria-pressed={theme === 'light'} onClick={() => apply('light')}>בהיר</button>
        <button className="chip" aria-pressed={theme === 'dark'} onClick={() => apply('dark')}>כהה</button>
      </div>
    </section>
  );
}

function MembersSection({ currentEmail }: { currentEmail: string }) {
  const users = useAsync(() => api.get<User[]>('/admin/users'));
  const toast = useToast();

  async function setRole(email: string, role: string) {
    try {
      await api.patch(`/admin/users/${encodeURIComponent(email)}`, { role });
      users.reload();
      toast.show('עודכן');
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'לא הצלחנו לעדכן', 'bad');
    }
  }

  return (
    <section className="section">
      <h2>מי בבית</h2>
      <div className="card">
        <div className="rows">
          {(users.data ?? []).map((u) => (
            <div className="row" key={u.email}>
              <div className="grow">
                <div className="title">{u.display_name ?? u.name ?? u.email}</div>
                <div className="meta" dir="ltr" style={{ textAlign: 'start' }}>{u.email}</div>
              </div>
              {u.email === currentEmail ? (
                <span className="pill ok">{ROLE_LABELS[u.role]}</span>
              ) : (
                <select className="select" style={{ width: 'auto', minHeight: 38 }} value={u.role} onChange={(e) => void setRole(u.email, e.target.value)}>
                  {Object.entries(ROLE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              )}
            </div>
          ))}
          {users.loading && <div className="row"><Spinner /></div>}
        </div>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 8, paddingInline: 4 }}>
        «ממתין לאישור» רואה מסך המתנה בלבד. «צופה» רואה הכול ולא משנה כלום.
      </p>
    </section>
  );
}

function DatabaseSection() {
  const health = useAsync(() => api.get<{ ok: boolean; missing: string[]; hint: string | null }>('/admin/health'));
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function run(what: 'migrate' | 'seed') {
    setBusy(what);
    try {
      const res = await api.post<{ tables?: string[]; categories?: number }>(`/admin/${what}`);
      toast.show(what === 'migrate' ? `המיגרציה רצה — ${res.tables?.length ?? 0} טבלאות` : `נזרעו ${res.categories ?? 0} קטגוריות`);
      health.reload();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'נכשל', 'bad');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="section">
      <h2>מסד הנתונים</h2>
      <div className="card card-pad">
        {health.data && (
          <p style={{ marginBottom: 12, fontSize: 14 }}>
            {health.data.ok
              ? <span className="pill ok">הסכימה מעודכנת</span>
              : <><span className="pill bad">חסרות טבלאות</span> <span className="muted">{health.data.missing.join(', ')}</span></>}
          </p>
        )}
        <button className="btn btn-ghost btn-block btn-sm" disabled={busy !== null} onClick={() => void run('migrate')}>
          {busy === 'migrate' ? 'רץ…' : 'הרצת מיגרציה'}
        </button>
        <button className="btn btn-ghost btn-block btn-sm" style={{ marginTop: 8 }} disabled={busy !== null} onClick={() => void run('seed')}>
          {busy === 'seed' ? 'רץ…' : 'זריעת קטגוריות ומוצרי ברירת מחדל'}
        </button>
        <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
          המיגרציה בטוחה לחזור עליה כמה פעמים שרוצים ולא מוחקת נתונים. הזריעה רצה רק על מסד ריק.
        </p>
      </div>
    </section>
  );
}
