import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { ErrorNote, Loading, Sheet, useAsync, useToast } from '../../ui/kit.js';
import { TopBar } from '../../ui/TopBar.js';
import { useVersion } from '../../lib/version.js';
import { shouldUpdate } from '@shared/version.js';
import type { Role, User } from '@shared/types.js';
import { HouseholdSwitcher } from '../household/HouseholdGate.js';
import { Link } from '../../lib/router.js';
import { PayeeRulesSheet } from './PayeeRulesSheet.js';
import { ProfileSheet } from './ProfileSheet.js';

const ROLE_LABELS: Record<string, string> = {
  owner: 'בעל הבית', member: 'שותף', viewer: 'צופה', pending: 'ממתין לאישור',
};

/**
 * Settings, grouped the way a phone's own settings are: by who it is about.
 *
 * This screen had become the place for whatever had no other home — account
 * balances first, then the people, the theme, a paragraph of release notes,
 * seven export buttons, and the database. The balances moved to «כסף», where
 * the money is. What is left is in a few groups of ruled rows, and the long
 * things (what is new, the export files, the database) open in a sheet from a
 * row instead of sitting open on the page.
 */
export function SettingsScreen() {
  const { user, households, signOut, isOperator } = useSession();
  const isOwner = user?.role === 'owner';
  const [sheet, setSheet] = useState<'export' | 'database' | 'payees' | 'profile' | null>(null);
  const canWrite = user?.role === 'owner' || user?.role === 'member';

  return (
    <>
      <TopBar title="הגדרות" subtitle={user?.household_name ?? user?.email} />

      <div className="page">
        {/* What we are called comes first: it is the one thing here that is
            printed on other screens every day. */}
        {canWrite && (
          <section className="section">
            <h2>אנחנו</h2>
            <div className="rows">
              <button className="row" style={{ minHeight: 52 }} onClick={() => setSheet('profile')}>
                <span className="grow" style={{ textAlign: 'start' }}>איך לקרוא לך</span>
                <span className="meta">{user.display_name ?? user.name ?? ''}</span>
              </button>
              {isOwner && (
                <button className="row" style={{ minHeight: 52 }} onClick={() => setSheet('profile')}>
                  <span className="grow" style={{ textAlign: 'start' }}>שם הבית</span>
                  <span className="meta">{user.household_name}</span>
                </button>
              )}
            </div>
          </section>
        )}
        {isOwner && <MembersSection currentEmail={user.email} />}
        {isOwner && <InviteSection />}
        {user && <HouseholdSwitcher households={households} current={user.household_id ?? 0} />}

        <ThemeSection />

        {/* Places to go, not things to read: one ruled row each, the whole row
            the link, the way every list in the app works. */}
        <section className="section">
          <h2>הנתונים</h2>
          <div className="rows">
            <Link to="/budget/excel" className="row" style={{ textDecoration: 'none', minHeight: 52 }}>
              <span className="grow">ייבוא וייצוא לאקסל</span>
              <span className="meta">פירוט אשראי · קובץ התקציב</span>
            </Link>
            {canWrite && (
              <button className="row" style={{ minHeight: 52 }} onClick={() => setSheet('payees')}>
                <span className="grow" style={{ textAlign: 'start' }}>בתי עסק שזוהו</span>
                <span className="meta">לאיזה סעיף כל אחד הולך</span>
              </button>
            )}
            <button className="row" style={{ minHeight: 52 }} onClick={() => setSheet('export')}>
              <span className="grow">הורדת הנתונים</span>
              <span className="meta">CSV · גיבוי מלא</span>
            </button>
            {/* The operator runs the system from its own screen; an owner who
                is not one still needs the migration button after a deploy. */}
            {!isOperator && isOwner && <DatabaseRow onOpen={() => setSheet('database')} />}
          </div>
        </section>

        <AboutSection isOperator={isOperator} />

        <section className="section">
          <div className="rows">
            <button className="row" style={{ minHeight: 52 }} onClick={() => void signOut()}>
              <span className="grow">יציאה</span>
              <span className="meta n">{user?.email}</span>
            </button>
          </div>
        </section>
      </div>

      {sheet === 'payees' && <PayeeRulesSheet onClose={() => setSheet(null)} />}
      {sheet === 'profile' && <ProfileSheet onClose={() => setSheet(null)} />}
      {sheet === 'export' && (
        <Sheet title="הורדת הנתונים" onClose={() => setSheet(null)}>
          <ExportSection isOwner={isOwner} />
        </Sheet>
      )}
      {sheet === 'database' && (
        <Sheet title="מסד הנתונים" onClose={() => setSheet(null)}>
          <DatabaseSection />
        </Sheet>
      )}
    </>
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

/**
 * The version, what changed in it, the guide and — for the operator — the
 * system screen. The release notes are a paragraph that changes once a week
 * and is read once; they open from the version row rather than sitting under
 * it on every visit.
 */
function AboutSection({ isOperator }: { isOperator: boolean }) {
  const { currentVersion, manifest, reload } = useVersion();
  const [notes, setNotes] = useState(false);
  const serverVersion = manifest?.version;
  const isOutdated = manifest && shouldUpdate(currentVersion, manifest) !== 'none';

  return (
    <section className="section">
      <h2>על קאסה</h2>
      <div className="rows">
        <button className="row" style={{ minHeight: 52 }} disabled={!manifest?.notes} onClick={() => setNotes(true)}>
          <span className="grow">
            גרסה <span className="n">{currentVersion}</span>
          </span>
          {isOutdated
            ? <span className="mark">יש גרסה <span className="n">{serverVersion}</span></span>
            : <span className="meta">{manifest?.notes ? 'מה חדש' : serverVersion ? 'מעודכנת' : '…'}</span>}
        </button>
        {/* A plain <a>, not a router Link: the guide is a static page served
            beside the app, not a screen inside it. */}
        <a href="/guide" className="row" style={{ textDecoration: 'none', minHeight: 52 }}>
          <span className="grow">איך המערכת עובדת</span>
          <span className="meta">מדריך קצר</span>
        </a>
        {isOperator && (
          <Link to="/admin" className="row" style={{ textDecoration: 'none', minHeight: 52 }}>
            <span className="grow">ניהול המערכת</span>
            <span className="meta">כל הבתים ומסד הנתונים</span>
          </Link>
        )}
      </div>
      {isOutdated && (
        <button className="btn btn-block btn-primary" style={{ marginTop: 'var(--s3)' }} onClick={reload}>
          עדכון לגרסה {serverVersion}
        </button>
      )}
      {notes && manifest?.notes && (
        <Sheet title={`מה חדש · ${manifest.version}`} onClose={() => setNotes(false)}>
          <p style={{ lineHeight: 1.7 }}>{manifest.notes}</p>
        </Sheet>
      )}
    </section>
  );
}

/**
 * The database's state in one row, so a schema that needs a migration is
 * visible from settings without opening anything.
 */
function DatabaseRow({ onOpen }: { onOpen: () => void }) {
  const health = useAsync(() => api.get<{ ok: boolean; missing: string[] }>('/admin/health'));
  return (
    <button className="row" style={{ minHeight: 52 }} onClick={onOpen}>
      <span className="grow">מסד הנתונים</span>
      {health.data && !health.data.ok
        ? <span className="mark mark-red">צריך מיגרציה</span>
        : <span className="meta">{health.data ? 'מעודכן' : '…'}</span>}
    </button>
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
    <>
      {/* Six one-word rows with the same button at the end of each were six
          rows of furniture around six words. The words are the buttons now. */}
      <div className="chips" style={{ marginTop: 0 }}>
        {(sheets.data ?? []).map((sheet) => (
          <a className="btn btn-sm" key={sheet.name} href={`/api/admin/export?sheet=${sheet.name}`}>{sheet.label}</a>
        ))}
        {isOwner && <a className="btn btn-sm" href="/api/admin/export/all">גיבוי מלא · JSON</a>}
      </div>
      {sheets.loading && <Loading />}
      <p className="meta" style={{ marginTop: 'var(--s3)' }}>
        קובצי CSV נפתחים באקסל ובגיליונות של גוגל. הגיבוי המלא הוא לשחזור.
      </p>
    </>
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
