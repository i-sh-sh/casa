import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { AsyncForm, ErrorNote, Field, Loading, Sheet, useAsync, useToast } from '../../ui/kit.js';
import { Icon } from '../../ui/Icon.js';
import { TopBar } from '../../ui/TopBar.js';
import { formatILS } from '@shared/money.js';
import { useVersion } from '../../lib/version.js';
import { shouldUpdate } from '@shared/version.js';
import type { Account, Role, User } from '@shared/types.js';
import { HouseholdSwitcher } from '../household/HouseholdGate.js';
import { Link } from '../../lib/router.js';

const ROLE_LABELS: Record<string, string> = {
  owner: 'בעל הבית', member: 'שותף', viewer: 'צופה', pending: 'ממתין לאישור',
};
const KIND_LABELS: Record<string, string> = {
  bank: 'בנק', cash: 'מזומן', credit: 'אשראי', savings: 'חיסכון',
};

export function SettingsScreen() {
  const { user, households, signOut, isOperator } = useSession();
  const accounts = useAsync(() => api.get<Account[]>('/money/accounts'));
  const [addingAccount, setAddingAccount] = useState(false);
  const isOwner = user?.role === 'owner';

  const open = (accounts.data ?? []).filter((a) => !a.archived_at);
  const net = open.reduce((sum, a) => sum + a.balance, 0);

  return (
    <>
      <TopBar title="הגדרות" subtitle={user?.household_name ?? user?.email} />

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

        {user && <HouseholdSwitcher households={households} current={user.household_id ?? 0} />}

        {isOwner && <MembersSection currentEmail={user.email} />}
        {isOwner && <InviteSection />}

        <ThemeSection />

        <VersionSection />

        <ExportSection isOwner={isOwner} />

        {/* The operator runs the system from its own screen; an owner who is not
            one still needs the migration button after a deploy. */}
        {!isOperator && isOwner && <DatabaseSection />}

        {/* The rest is places to go, not things to read: one ruled row each,
            the whole row the link, the way every list in the app works. */}
        <section className="section">
          <h2>עוד</h2>
          <div className="rows">
            {isOperator && (
              <Link to="/admin" className="row" style={{ textDecoration: 'none', minHeight: 52 }}>
                <span className="grow">ניהול המערכת</span>
                <span className="meta">כל הבתים ומסד הנתונים</span>
              </Link>
            )}
            {/* A plain <a>, not a router Link: the guide is a static page served
                beside the app, not a screen inside it. */}
            <a href="/guide" className="row" style={{ textDecoration: 'none', minHeight: 52 }}>
              <span className="grow">איך המערכת עובדת</span>
              <span className="meta">מדריך קצר</span>
            </a>
            <button className="row" style={{ minHeight: 52 }} onClick={() => void signOut()}>
              <span className="grow">יציאה</span>
            </button>
          </div>
        </section>
      </div>

      {addingAccount && (
        <Sheet title="חשבון חדש" onClose={() => setAddingAccount(false)}>
          <AccountForm onSaved={() => { setAddingAccount(false); accounts.reload(); }} />
        </Sheet>
      )}
    </>
  );
}

export function AccountForm({ onSaved, initialName = '', initialKind = 'bank' }: {
  onSaved: () => void; initialName?: string; initialKind?: string;
}) {
  const [name, setName] = useState(initialName);
  const [kind, setKind] = useState(initialKind);
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
      <h2>מראה</h2>
      <div className="tabs">
        <button className="tab" aria-pressed={theme === 'system'} onClick={() => apply('system')}>לפי המכשיר</button>
        <button className="tab" aria-pressed={theme === 'light'} onClick={() => apply('light')}>בהיר</button>
        <button className="tab" aria-pressed={theme === 'dark'} onClick={() => apply('dark')}>כהה</button>
      </div>
    </section>
  );
}

function VersionSection() {
  const { currentVersion, manifest, reload } = useVersion();
  const serverVersion = manifest?.version;
  const isOutdated = manifest && shouldUpdate(currentVersion, manifest) !== 'none';

  return (
    <section className="section">
      <h2>גרסה</h2>
      <div className="row" style={{ minHeight: 44, borderBottom: 0 }}>
        <span className="grow n">{currentVersion}</span>
        {isOutdated
          ? <span className="mark">יש גרסה <span className="n">{serverVersion}</span></span>
          : <span className="meta">{serverVersion ? 'מעודכנת' : '…'}</span>}
      </div>
      {manifest?.notes && (
        <p className="meta">{manifest.notes}</p>
      )}
      {isOutdated && (
        <button className="btn btn-block btn-primary" style={{ marginTop: 'var(--s3)' }} onClick={reload}>
          עדכון לגרסה {serverVersion}
        </button>
      )}
    </section>
  );
}

function MembersSection({ currentEmail }: { currentEmail: string }) {
  const users = useAsync(() => api.get<(User & { role: Role })[]>('/admin/users'));
  const toast = useToast();

  async function setRole(email: string, role: string) {
    try {
      await api.patch('/admin/users', { email, role });
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
              <span className="label">{ROLE_LABELS[u.role] ?? u.role}</span>
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
    </section>
  );
}

/**
 * Taking the data out.
 *
 * Plain links, not fetch-then-build-a-blob. The browser's own download is what
 * puts the file where a person expects to find it, carries the session cookie
 * without any work, and does not need the whole export in the page's memory —
 * which on a phone, with three years of transactions, is the difference between
 * a file and a crash.
 *
 * Shown to everyone in the household, not only the owner: «הנתונים שלנו, ואנחנו
 * צריכים לדעת שאפשר לקחת אותם» is a promise to both people, and someone who can
 * read every number on screen is not protected by being unable to download them.
 */
function ExportSection({ isOwner }: { isOwner: boolean }) {
  const sheets = useAsync(() => api.get<{ name: string; label: string }[]>('/admin/export/sheets'));

  return (
    <section className="section">
      <h2>ייצוא <span className="count">· CSV</span></h2>
      {/* Six one-word rows with the same button at the end of each were six
          rows of furniture around six words. The words are the buttons now. */}
      <div className="chips">
        {(sheets.data ?? []).map((sheet) => (
          <a className="btn btn-sm" key={sheet.name} href={`/api/admin/export?sheet=${sheet.name}`}>{sheet.label}</a>
        ))}
        {isOwner && <a className="btn btn-sm" href="/api/admin/export/all">גיבוי מלא · JSON</a>}
      </div>
      {sheets.loading && <Loading />}
      <p className="meta" style={{ marginTop: 'var(--s2)' }}>
        נפתח באקסל ובגיליונות של גוגל. הגיבוי המלא הוא לשחזור.
      </p>
    </section>
  );
}

/**
 * The invitation link.
 *
 * The link is shown once and not stored anywhere the owner can retrieve it
 * later: it is a credential to their household's money, and a list of live
 * invitations sitting in a settings screen is a list of ways in. Losing one
 * costs a tap to mint another.
 */
export function InviteSection() {
  const toast = useToast();
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function mint(role: 'member' | 'viewer') {
    setBusy(true);
    try {
      const { token } = await api.post<{ token: string }>('/auth/invite', { role });
      setLink(`${location.origin}/?invite=${token}`);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'לא הצלחנו ליצור הזמנה', { tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.show('הקישור הועתק');
    } catch {
      // Clipboard access is refused in plenty of ordinary situations. The link
      // is on screen and selectable, so this is a convenience that failed, not
      // a feature that broke.
      toast.show('לא הצלחנו להעתיק — סמנו והעתיקו ידנית', { tone: 'bad' });
    }
  };

  // The message is the first thing the partner sees, before the app, so it is
  // written as the person sending it would write it and says what the link is.
  // A bare URL from a stranger's domain is the kind people do not tap.
  const share = async () => {
    if (!link) return;
    const text = `פתחתי לנו בית בקאסה: התקציב, המזווה ורשימת הקניות, פנקס אחד לשנינו. הקישור תקף לשבוע: ${link}`;
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (err) {
        // Closing the share sheet is a choice, not a failure.
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  };

  return (
    <section className="section">
      <h2>להזמין לבית</h2>
      {link ? (
        <>
          <p className="meta n" style={{ fontSize: 13, wordBreak: 'break-all', marginBottom: 'var(--s3)' }}>{link}</p>
          <button className="btn btn-primary btn-block" onClick={() => void share()}>שליחה בוואטסאפ או בהודעה</button>
          <button className="btn btn-block btn-sm" style={{ marginTop: 'var(--s2)' }} onClick={() => void copy()}>העתקת הקישור</button>
          <p className="meta" style={{ marginTop: 'var(--s2)' }}>
            תקף שבוע, לפעם אחת. אם אבד, יוצרים חדש.
          </p>
        </>
      ) : (
        <>
          <div className="row-2" style={{ marginTop: 'var(--s3)' }}>
            <button className="btn btn-sm" disabled={busy} onClick={() => void mint('member')}>
              שותף
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => void mint('viewer')}>
              צופה
            </button>
          </div>
          <p className="meta" style={{ marginTop: 'var(--s2)' }}>
            שותף רואה ומשנה. צופה רק רואה.
          </p>
        </>
      )}
    </section>
  );
}

export function DatabaseSection() {
  const health = useAsync(() => api.get<{
    ok: boolean; missing: string[]; hint: string | null;
    isolation: { enforced: boolean; unsafe_role: boolean } | null;
  }>('/admin/health'));
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

      {/* Whether the separation between homes is actually being enforced, as
          opposed to merely configured. It reads as a normal row when it is
          fine, because it almost always is — and as the loudest thing on the
          screen when it is not, because nothing else here can leak one
          household's money into another's. */}
      {health.data?.isolation && (
        <div className="row" style={{ minHeight: 44 }}>
          <span className="grow label">הפרדה בין בתים</span>
          {health.data.isolation.enforced
            ? <span>נאכפת</span>
            : <span className="mark mark-red">לא פעילה</span>}
        </div>
      )}
      {health.data?.isolation && !health.data.isolation.enforced && (
        <ErrorNote message={
          health.data.isolation.unsafe_role
            ? 'המערכת מחוברת למסד בתור תפקיד שעוקף אבטחת שורות (superuser או BYPASSRLS) — '
              + 'אצל Neon זה תפקיד ברירת המחדל neondb_owner. בית אחד יכול לקרוא את הנתונים '
              + 'של בית אחר. הרצת מיגרציה לא תתקן את זה: צריך תפקיד אפליקציה ייעודי בלי '
              + 'BYPASSRLS, ו-DATABASE_URL שמצביע אליו. הפקודות ב-docs/NEON.md.'
            : 'אבטחת השורות לא פעילה על הטבלאות. הריצו מיגרציה — ואם זה נמשך, אל תזמינו בית נוסף.'
        } />
      )}

      {failure && <ErrorNote message={failure} />}

      <div className="row-2" style={{ marginTop: 'var(--s3)' }}>
        <button className="btn btn-sm" disabled={busy !== null} onClick={() => void run('migrate')}>
          {busy === 'migrate' ? 'רץ…' : 'מיגרציה'}
        </button>
        <button className="btn btn-sm" disabled={busy !== null} onClick={() => void run('seed')}>
          {busy === 'seed' ? 'רץ…' : 'זריעה'}
        </button>
      </div>
      <p className="meta" style={{ marginTop: 'var(--s2)' }}>
        מיגרציה לא מוחקת כלום ואפשר לחזור עליה. זריעה רק על מסד ריק.
      </p>
    </section>
  );
}
