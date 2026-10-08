import { useState } from 'react';
import { api } from '../../lib/api.js';
import { Link, useRouter } from '../../lib/router.js';
import { useSession } from '../../lib/session.js';
import { ErrorNote, Loading, useAsync, useToast } from '../../ui/kit.js';
import { TopBar } from '../../ui/TopBar.js';
import { DatabaseSection } from '../settings/SettingsScreen.js';
import { setupDone, setupSteps, weekIndex, TRACKED_WEEKS, type SetupFacts } from '@shared/setup.js';

interface HouseholdMetrics {
  household_id: number;
  name: string;
  owner_email: string | null;
  created_at: string;
  members: number;
  pending: number;
  last_seen_at: string | null;
  accounts: number;
  transactions: number;
  transactions_7d: number;
  products: number;
  shopping_open: number;
  last_activity_at: string | null;
  setup: SetupFacts;
  active_days: number[];
  is_test: boolean;
}

interface TestingState {
  built: boolean;
  personas: { key: string; display_name: string; purpose: string; homes: string[] }[];
}

/** «לפני 3 ימים», or «אף פעם» — the only two answers this screen needs. */
function ago(iso: string | null): string {
  if (!iso) return 'אף פעם';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'היום';
  if (days === 1) return 'אתמול';
  if (days < 30) return `לפני ${days} ימים`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'לפני חודש' : `לפני ${months} חודשים`;
}

const quiet = (home: HouseholdMetrics) =>
  !home.last_activity_at || Date.now() - new Date(home.last_activity_at).getTime() > 7 * 86_400_000;

/**
 * The operator's room: every home in the pilot, and the system they share.
 *
 * Three questions and no others: is anybody using this, who has gone quiet,
 * and which home is which when somebody writes to say it broke. Every number
 * here is a count and every date is a date — there is no amount on this screen
 * and there is none in the response that feeds it, because there is none in the
 * query. api/admin/_metrics.ts explains why that is enforced rather than meant,
 * and public/privacy.html is the sentence it keeps true.
 *
 * Two additions over the section this used to be in settings. How far each
 * home got with setting itself up, read by the same function as the couple's
 * own checklist, so «2/4» here is what they see. And the days with a recorded
 * transaction in each week since the home opened, because the pilot's whole
 * question is week three, and a total since the start cannot show it.
 *
 * A household that has not been opened in a week is marked, not sorted to the
 * top — the order stays stable so the same home is in the same place every
 * time this is opened.
 */
export function AdminScreen() {
  const { isOperator } = useSession();
  const homes = useAsync(() => (isOperator ? api.get<HouseholdMetrics[]>('/admin/metrics') : Promise.resolve([])));

  if (!isOperator) {
    return (
      <>
        <TopBar title="ניהול המערכת" />
        <div className="page">
          <p>המסך הזה פתוח רק למי שהכתובת שלו מופיעה ב-CASA_OPERATORS בהגדרות של Vercel.</p>
          <Link to="/settings" className="btn btn-block">חזרה להגדרות</Link>
        </div>
      </>
    );
  }

  const rows = homes.data ?? [];
  // Test homes are listed, so the operator can see what a reset left, but they
  // are not the pilot and do not count towards it.
  const pilot = rows.filter((h) => !h.is_test);
  const silent = pilot.filter(quiet).length;
  const thisWeek = pilot.filter((h) => h.transactions_7d > 0).length;

  return (
    <>
      <TopBar
        title="ניהול המערכת"
        subtitle="ספירות ותאריכים בלבד"
        action={<Link to="/settings" className="btn btn-sm">הגדרות</Link>}
      />

      <div className="page">
        <section className="section">
          <h2>הבתים <span className="count">· {pilot.length}</span></h2>

          {pilot.length > 0 && (
            <p className="meta" style={{ marginBottom: 'var(--s3)' }}>
              {thisWeek} רשמו תנועה השבוע · {silent} שקטים יותר משבוע
            </p>
          )}

          <div className="rows">
            {rows.map((home) => <HomeRow key={home.household_id} home={home} />)}
            {homes.loading && <Loading />}
          </div>

          {homes.error && <ErrorNote message={homes.error} onRetry={homes.reload} />}
          {!homes.loading && pilot.length === 0 && <p className="meta">אין עדיין בתים.</p>}

          <p className="meta" style={{ marginTop: 'var(--s2)' }}>
            אין כאן סכומים, שמות עסקים או מוצרים, וגם לא בשאילתה שמזינה את המסך.
            «שקט» = שבוע בלי שום פעולה. «ימים עם תנועה» = בכמה ימים נרשמה תנועה בכל שבוע מאז שהבית נפתח; השבוע השלישי מודגש.
          </p>
        </section>

        <TestingSection onRebuilt={homes.reload} />

        <DatabaseSection />
      </div>
    </>
  );
}

/**
 * The test people: who they are, which home each is in, and the way into each.
 *
 * Rebuilding asks once before it acts, in two steps rather than a browser
 * dialog for the same reason the transaction delete does. It cannot reach a
 * real home (api/admin/_testing.ts says why), but it does throw away whatever
 * the operator did in the test ones, which may be the thing they were about to
 * look at.
 */
function TestingSection({ onRebuilt }: { onRebuilt: () => void }) {
  const { stepIn } = useSession();
  const { navigate } = useRouter();
  const toast = useToast();
  const state = useAsync(() => api.get<TestingState>('/admin/testing'));
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function rebuild() {
    setBusy('rebuild');
    setFailure(null);
    try {
      await api.post('/admin/testing/rebuild');
      toast.show('משתמשי הבדיקה נבנו מחדש');
      setConfirming(false);
      state.reload();
      onRebuilt();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'הבנייה נכשלה');
    } finally {
      setBusy(null);
    }
  }

  async function enter(persona: string) {
    setBusy(persona);
    setFailure(null);
    try {
      await stepIn(persona);
      navigate('/');
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'הכניסה נכשלה');
      setBusy(null);
    }
  }

  const built = state.data?.built ?? false;

  return (
    <section className="section">
      <h2>משתמשי בדיקה</h2>
      <p className="meta" style={{ marginBottom: 'var(--s3)' }}>
        ארבעה אנשים מדומים, כדי לעבור על האפליקציה אחרי כל עדכון בלי חשבונות Google נוספים.
        נכנסים בתור אחד מהם, ופס כחול למעלה מחזיר לחשבון שלכם.
        הכתובות שלהם מסתיימות ב-<span className="n">casa.invalid</span>, אז אף אחד אמיתי לא יכול להיכנס בתורם.
      </p>

      {state.loading && <Loading />}
      {state.error && <ErrorNote message={state.error} onRetry={state.reload} />}

      {built && (
        <div className="rows">
          {state.data!.personas.map((p) => (
            <div key={p.key} className="row" style={{ alignItems: 'flex-start', paddingBlock: 'var(--s3)' }}>
              <span className="grow">
                <span className="title" style={{ display: 'block' }}>{p.display_name}</span>
                <span className="meta" style={{ display: 'block' }}>{p.purpose}</span>
                <span className="meta" style={{ fontSize: 12, display: 'block' }}>
                  {p.homes.length ? p.homes.join(', ') : 'בלי בית'}
                </span>
              </span>
              <button className="btn btn-sm" disabled={busy !== null} onClick={() => void enter(p.key)}>
                {busy === p.key ? 'רגע…' : 'כניסה'}
              </button>
            </div>
          ))}
        </div>
      )}

      {failure && <ErrorNote message={failure} />}

      <div style={{ marginTop: 'var(--s3)' }}>
        {!built && !state.loading ? (
          <button className="btn btn-block btn-primary" disabled={busy !== null} onClick={() => void rebuild()}>
            {busy === 'rebuild' ? 'בונים…' : 'להקים את משתמשי הבדיקה'}
          </button>
        ) : confirming ? (
          <>
            <p className="meta" style={{ marginBottom: 'var(--s3)' }}>
              כל מה שנעשה בבתי הבדיקה יימחק, ונועה ועומר יחזרו להיות בלי בית.
              הבית של דנה ויואב ייבנה מחדש עם חודשיים של נתונים עד היום. בתים אמיתיים לא נוגעים.
            </p>
            <div className="row-2">
              <button className="btn btn-red" disabled={busy !== null} onClick={() => void rebuild()}>
                {busy === 'rebuild' ? 'בונים…' : 'לבנות מחדש'}
              </button>
              <button className="btn" disabled={busy !== null} onClick={() => setConfirming(false)}>ביטול</button>
            </div>
          </>
        ) : built ? (
          <button className="btn btn-block" disabled={busy !== null} onClick={() => setConfirming(true)}>
            לאפס ולבנות מחדש
          </button>
        ) : null}
      </div>
    </section>
  );
}

function HomeRow({ home }: { home: HouseholdMetrics }) {
  const steps = setupSteps(home.setup);
  const missing = steps.filter((s) => !s.done);
  const current = Math.min(weekIndex(home.created_at), TRACKED_WEEKS - 1);

  return (
    <div className="row" style={{ alignItems: 'flex-start', paddingBlock: 'var(--s3)' }}>
      <span className="grow">
        <span className="title" style={{ display: 'block' }}>
          {home.name}
          {home.is_test
            ? <span className="mark mark-blue" style={{ marginInlineStart: 8 }}>בדיקה</span>
            : quiet(home) && <span className="mark mark-red" style={{ marginInlineStart: 8 }}>שקט</span>}
        </span>
        <span className="meta n" style={{ fontSize: 12, display: 'block' }}>{home.owner_email ?? '—'}</span>
        <span className="meta" style={{ fontSize: 12, display: 'block' }}>
          {home.members} בבית
          {home.pending > 0 && ` · ${home.pending} ממתינים`}
          {' · נפתח '}{ago(home.created_at)}
          {' · נכנסו '}{ago(home.last_seen_at)}
          {' · פעילות '}{ago(home.last_activity_at)}
        </span>

        <span className="meta" style={{ fontSize: 12, display: 'block', marginTop: 'var(--s1)' }}>
          הקמה <span className="n">{setupDone(steps)}/{steps.length}</span>
          {missing.length > 0 && <> · חסר: {missing.map((s) => s.label).join(', ')}</>}
        </span>

        {/* One figure per week that has begun, oldest first, isolated left to
            right so the dots stay between the numbers instead of being
            reordered around them. Week three is the pilot's question, so it is
            the one set in bold. */}
        <span className="meta" style={{ fontSize: 12, display: 'block' }}>
          ימים עם תנועה, לפי שבוע:{' '}
          <bdi dir="ltr" className="n" style={{ whiteSpace: 'nowrap' }}>
            {home.active_days.slice(0, current + 1).map((days, w) => (
              <span key={w} style={w === 2 ? { fontWeight: 700 } : undefined}>{w > 0 && ' · '}{days}</span>
            ))}
          </bdi>
          {current >= 2 ? '' : ` (עכשיו שבוע ${current + 1})`}
        </span>
      </span>
      <span className="meta n" style={{ fontSize: 12, textAlign: 'start', minWidth: 96 }}>
        {home.transactions} תנועות
        <br />
        {home.transactions_7d} השבוע
        <br />
        {home.shopping_open} בקניות
      </span>
    </div>
  );
}
