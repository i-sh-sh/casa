import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { AsyncForm, ErrorNote, Field, Loading, Sheet, useAsync, useToast } from '../../ui/kit.js';
import { Icon } from '../../ui/Icon.js';
import { TopBar } from '../../ui/TopBar.js';
import { formatILS } from '@shared/money.js';
import type { Account, User } from '@shared/types.js';

const ROLE_LABELS: Record<string, string> = {
  owner: 'בעל הבית', member: 'שותף', viewer: 'צופה', pending: 'ממתין לאישור',
};
const KIND_LABELS: Record<string, string> = {
  bank: 'בנק', cash: 'מזומן', credit: 'אשראי', savings: 'חיסכון',
};

export function SettingsScreen() {
  const { user, signOut } = useSession();
  const accounts = useAsync(() => api.get<Account[]>('/money/accounts'));
  const [addingAccount, setAddingAccount] = useState(false);
  const isOwner = user?.role === 'owner';

  const open = (accounts.data ?? []).filter((a) => !a.archived_at);
  const net = open.reduce((sum, a) => sum + a.balance, 0);

  return (
    <>
      <TopBar title="הגדרות" subtitle={user?.email} />

      <div className="page">
        <section className="section">
          <h2>חשבונות <span className="count">· ₪</span></h2>
          <div className="rows">
            {open.map((a) => (
              <div className="row" key={a.id}>
                <span className="grow">
                  <span className="title" style={{ display: 'block' }}>{a.name}</span>
                  <span className="meta">{KIND_LABELS[a.kind] ?? a.kind}</span>
                </span>
                <span className={`n amount ${a.balance < 0 ? 'over' : ''}`}>
                  {formatILS(a.balance, { symbol: false })}
                </span>
              </div>
            ))}
            {accounts.loading && <Loading />}
          </div>
          {open.length > 0 && (
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
        </section>

        <ThemeSection />

        {isOwner && <MembersSection currentEmail={user.email} />}
        {isOwner && <DatabaseSection />}

        <section className="section">
          <button className="btn btn-block" onClick={() => void signOut()}>יציאה</button>
        </section>

        <p className="meta" style={{ marginTop: 'var(--s6)' }}>
          קאסה · פנקס אחד לבית אחד
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
  );
}

/**
 * Three states, not two.
 *
 * A light/dark switch cannot say "follow the phone", which is what most people
 * want and what the app does before anyone touches this. And the choice lives
 * in localStorage rather than the database on purpose: it is a property of
 * this screen, not of this person.
 */
function ThemeSection() {
  const [theme, setTheme] = useState<string>(() => {
    try { return localStorage.getItem('casa-theme') ?? 'system'; } catch { return 'system'; }
  });

  const apply = (next: string) => {
    setTheme(next);
    try { localStorage.setItem('casa-theme', next); } catch { /* private mode: it just will not persist */ }
    if (next === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', next);
  };

  return (
    <section className="section">
      <h2>נייר</h2>
      <div className="tabs">
        <button className="tab" aria-pressed={theme === 'system'} onClick={() => apply('system')}>לפי המכשיר</button>
        <button className="tab" aria-pressed={theme === 'light'} onClick={() => apply('light')}>בהיר</button>
        <button className="tab" aria-pressed={theme === 'dark'} onClick={() => apply('dark')}>כהה</button>
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
      toast.show(err instanceof Error ? err.message : 'לא הצלחנו לעדכן', { tone: 'bad' });
    }
  }

  return (
    <section className="section">
      <h2>מי בבית</h2>
      <div className="rows">
        {(users.data ?? []).map((u) => (
          <div className="row" key={u.email}>
            <span className="grow">
              <span className="title" style={{ display: 'block' }}>{u.display_name ?? u.name ?? u.email}</span>
              <span className="meta n" style={{ fontSize: 12 }}>{u.email}</span>
            </span>
            {u.email === currentEmail ? (
              <span className="label">{ROLE_LABELS[u.role]}</span>
            ) : (
              <select className="select" style={{ width: 'auto', minHeight: 40 }} value={u.role} onChange={(e) => void setRole(u.email, e.target.value)}>
                {Object.entries(ROLE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            )}
          </div>
        ))}
        {users.loading && <Loading />}
      </div>
      <p className="meta" style={{ marginTop: 'var(--s2)' }}>
        «ממתין לאישור» רואה מסך המתנה בלבד. «צופה» רואה הכול ולא משנה כלום.
      </p>
    </section>
  );
}

function DatabaseSection() {
  const health = useAsync(() => api.get<{ ok: boolean; missing: string[]; hint: string | null }>('/admin/health'));
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function run(what: 'migrate' | 'seed') {
    setBusy(what);
    setFailure(null);
    try {
      const res = await api.post<{ tables?: string[]; categories?: number }>(`/admin/${what}`);
      toast.show(what === 'migrate' ? `המיגרציה רצה · ${res.tables?.length ?? 0} טבלאות` : `נזרעו ${res.categories ?? 0} קטגוריות`);
      health.reload();
    } catch (err) {
      // Shown in full, not as a toast: when a migration fails the exact text
      // Postgres returned is the only thing that shortens the search.
      setFailure(err instanceof Error ? err.message : 'נכשל');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="section">
      <h2>מסד הנתונים</h2>

      {health.data && (
        <div className="row" style={{ minHeight: 44 }}>
          <span className="grow label">מצב הסכימה</span>
          {health.data.ok
            ? <span>מעודכנת</span>
            : <span className="mark mark-red">חסרות {health.data.missing.length} טבלאות</span>}
        </div>
      )}
      {health.data && !health.data.ok && (
        <p className="meta n" style={{ fontSize: 12, marginBottom: 'var(--s3)' }}>{health.data.missing.join(', ')}</p>
      )}

      {failure && <ErrorNote message={failure} />}

      <button className="btn btn-block btn-sm" style={{ marginTop: 'var(--s3)' }} disabled={busy !== null} onClick={() => void run('migrate')}>
        {busy === 'migrate' ? 'רץ…' : 'הרצת מיגרציה'}
      </button>
      <button className="btn btn-block btn-sm" style={{ marginTop: 'var(--s2)' }} disabled={busy !== null} onClick={() => void run('seed')}>
        {busy === 'seed' ? 'רץ…' : 'זריעת קטגוריות ומוצרי ברירת מחדל'}
      </button>
      <p className="meta" style={{ marginTop: 'var(--s2)' }}>
        המיגרציה בטוחה לחזור עליה כמה פעמים שרוצים ולא מוחקת נתונים. הזריעה רצה רק על מסד ריק.
      </p>
    </section>
  );
}
