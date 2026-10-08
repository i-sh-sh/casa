import { useState } from 'react';
import { useRouter } from '../../lib/router.js';
import { useSession } from '../../lib/session.js';
import { PERSONAS } from '@shared/testing.js';

/**
 * The strip across the top while the operator is a test person.
 *
 * Without it, a test home and a real one look identical, and the one mistake
 * this feature must not invite is forgetting which of the two you are in. It
 * sits above every screen, including the ones with no navigation — the empty
 * «פתיחת בית» gate is exactly where a new test person starts.
 *
 * Switching person is here rather than only on the admin screen because the
 * couple flow is a relay: נועה sends the invitation, עומר opens it, and going
 * back to the operator's account between the two would only add steps.
 */
export function TestingBar() {
  const { testing, stepIn, stepBack } = useSession();
  const { navigate } = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (!testing) return null;

  async function run(action: () => Promise<void>, to: string) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      // An invite link keeps its query string: switching to the person who is
      // about to open it must not throw the link away.
      if (!location.search.includes('invite=')) navigate(to);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'לא הצלחנו להחליף משתמש');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="testbar" role="status">
      <span className="testbar-label">בדיקה</span>
      <select
        className="select testbar-who"
        aria-label="משתמש בדיקה"
        value={testing.persona}
        disabled={busy}
        onChange={(e) => void run(() => stepIn(e.target.value), '/')}
      >
        {PERSONAS.map((p) => <option key={p.key} value={p.key}>בתור {p.display_name}</option>)}
      </select>
      <button className="btn btn-sm" disabled={busy} onClick={() => void run(stepBack, '/admin')}>
        חזרה לחשבון שלי
      </button>
      {failure && <span className="testbar-failure">{failure}</span>}
    </div>
  );
}
