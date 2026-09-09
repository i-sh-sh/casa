import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { ErrorNote, useAsync } from '../../ui/kit.js';
import { Icon } from '../../ui/Icon.js';
import type { Household } from '@shared/types.js';

/**
 * What a signed-in person sees before they belong anywhere.
 *
 * This state did not exist while there was one home in the database: the first
 * person to sign in owned everything and everyone after them waited to be let
 * in. With more than one home that shortcut becomes a race, so signing in now
 * says only who you are — and this screen is where belonging actually happens.
 *
 * Two doors, and they are not equal. Most people arriving here were sent a
 * link by their partner, so the invitation is read from the URL and answered
 * without asking them to type anything. Opening a new home is the other door,
 * for the person who starts.
 */
export function HouseholdGate({ onJoined }: { onJoined: () => void }) {
  const { user, signOut } = useSession();
  const token = new URLSearchParams(location.search).get('invite');

  // The deadlock this avoids: on the deploy that introduces households, nobody
  // belongs to one yet — so this screen replaces the whole app, including the
  // settings screen with the migration button on it. Without the check below
  // there is no way to reach the migration that would end the state you are
  // stuck in, and «pilot with three couples» begins with the owner locked out
  // of their own budget.
  const health = useAsync(() => api.get<{ ok: boolean; missing: string[] }>('/admin/health'));

  return (
    <div className="gate">
      <div className="wordmark">קאסה</div>
      {health.data && !health.data.ok
        ? <RunMigration missing={health.data.missing} onDone={onJoined} />
        : token ? <AcceptInvite token={token} onJoined={onJoined} /> : <OpenHome onOpened={onJoined} />}

      <hr className="rule" style={{ margin: 'var(--s6) 0 var(--s4)' }} />
      <p className="meta">
        נכנסתם בתור <span className="n" style={{ fontSize: '.95em' }}>{user?.email}</span>
      </p>
      <button className="btn btn-quiet" onClick={() => void signOut()}>יציאה</button>
    </div>
  );
}

/**
 * The upgrade, done from the only screen that is reachable during it.
 *
 * Shown to the owner of a database whose schema predates households. The
 * migration adopts everything that already exists into one home and carries the
 * roles across, so the next render is the app, not this screen.
 */
function RunMigration({ missing, onDone }: { missing: string[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/admin/migrate');
      onDone();
    } catch (err) {
      // In full, never as a toast: when a migration fails, the exact text
      // Postgres returned is the only thing that shortens the search.
      setError(err instanceof Error ? err.message : 'המיגרציה נכשלה');
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        מסד הנתונים לא מעודכן לגרסה הזו. הריצו את המיגרציה — היא בטוחה לחזור עליה,
        לא מוחקת נתונים, ומאמצת את כל מה שכבר קיים לבית אחד.
      </p>
      <p className="meta n" style={{ fontSize: 12, marginBottom: 'var(--s4)' }}>
        חסרות: {missing.join(', ')}
      </p>
      {error && <ErrorNote message={error} />}
      <button className="btn btn-primary btn-block" onClick={() => void run()} disabled={busy}>
        {busy ? 'רץ…' : 'הרצת מיגרציה'}
      </button>
    </>
  );
}

/** The person who starts. */
function OpenHome({ onOpened }: { onOpened: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/household', { name: name.trim() });
      onOpened();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'לא הצלחנו לפתוח את הבית');
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        אין לכם עדיין בית. פתחו אחד — או פתחו את קישור ההזמנה ששלחו לכם.
      </p>
      <hr className="rule" style={{ margin: '0 0 var(--s5)' }} />
      <form onSubmit={(e) => { e.preventDefault(); void open(); }}>
        <label className="field" style={{ textAlign: 'start' }}>
          <span>שם הבית</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="הבית שלנו"
            autoFocus
            maxLength={60}
          />
        </label>
        {error && <p style={{ color: 'var(--red)', fontSize: 15, marginBottom: 'var(--s3)' }}>{error}</p>}
        <button className="btn btn-primary btn-block" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'רגע…' : 'פתיחת בית'}
        </button>
      </form>
      <p className="meta" style={{ marginTop: 'var(--s4)' }}>
        אחר כך תוכלו להזמין את בן או בת הזוג בקישור אחד.
      </p>
    </>
  );
}

/**
 * The invitation, answered without typing.
 *
 * It names the home before anyone accepts. A link that says only "join a
 * household" asks a person to trust a stranger's URL with their budget; one
 * that says «הבית של דנה ויואב» is either obviously right or obviously wrong.
 */
function AcceptInvite({ token, onJoined }: { token: string; onJoined: () => void }) {
  const [invite, setInvite] = useState<{ household_name: string; role: string; spent: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ household_name: string; role: string; spent: boolean }>('/auth/invite', { token })
      .then(setInvite)
      .catch((err: Error) => setError(err.message));
  }, [token]);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/join', { token });
      // The token is in the URL, and it is spent now. Leaving it there would
      // make a refresh look like a second, failed attempt.
      history.replaceState(null, '', location.pathname);
      onJoined();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ההצטרפות נכשלה');
      setBusy(false);
    }
  };

  if (error && !invite) return <p style={{ color: 'var(--red)' }}>{error}</p>;
  if (!invite) return <p className="meta">בודקים את ההזמנה…</p>;

  if (invite.spent) {
    return (
      <>
        <p>
          ההזמנה ל<b>{invite.household_name}</b> כבר נוצלה או פגה.
        </p>
        <p className="meta">בקשו קישור חדש ממי שהזמין אתכם.</p>
      </>
    );
  }

  return (
    <>
      <p>
        הוזמנתם ל<b>{invite.household_name}</b>
        {invite.role === 'viewer' && ' — בתור צופים, בלי הרשאת שינוי'}.
      </p>
      <hr className="rule" style={{ margin: '0 0 var(--s5)' }} />
      {error && <p style={{ color: 'var(--red)', fontSize: 15, marginBottom: 'var(--s3)' }}>{error}</p>}
      <button className="btn btn-primary btn-block" onClick={() => void accept()} disabled={busy}>
        {busy ? 'רגע…' : 'הצטרפות'}
      </button>
    </>
  );
}

/**
 * Switching between homes.
 *
 * Shown only to somebody who belongs to more than one — which in the pilot is
 * nobody, and later is us, testing against a household that is not our own.
 * A control that appears for one person and not for the rest is better than a
 * dropdown with a single item in it.
 */
export function HouseholdSwitcher({ households, current }: { households: Household[]; current: number }) {
  const { refresh } = useSession();
  const [busy, setBusy] = useState(false);

  if (households.length < 2) return null;

  const go = async (id: number) => {
    setBusy(true);
    await api.post('/auth/switch', { household_id: id }).catch(() => {});
    await refresh();
    setBusy(false);
  };

  return (
    <section className="section">
      <h2>הבית</h2>
      <div className="rows">
        {households.map((h) => (
          <div className="row" key={h.household_id} style={{ minHeight: 44 }}>
            <span className="grow">
              <span className="title" style={{ display: 'block' }}>{h.household_name}</span>
              <span className="meta">{h.role === 'owner' ? 'בעלי הבית' : h.role === 'viewer' ? 'צופים' : 'שותפים'}</span>
            </span>
            {h.household_id === current
              ? <span className="label"><Icon name="box-ticked" size={16} /></span>
              : <button className="btn btn-sm" disabled={busy} onClick={() => void go(h.household_id)}>מעבר</button>}
          </div>
        ))}
      </div>
    </section>
  );
}
