import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { useSession } from '../../lib/session.js';
import { ErrorNote, Loading, useAsync } from '../../ui/kit.js';
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
  const silent = rows.filter(quiet).length;
  const thisWeek = rows.filter((h) => h.transactions_7d > 0).length;

  return (
    <>
      <TopBar
        title="ניהול המערכת"
        subtitle="ספירות ותאריכים בלבד"
        action={<Link to="/settings" className="btn btn-sm">הגדרות</Link>}
      />

      <div className="page">
        <section className="section">
          <h2>הבתים <span className="count">· {rows.length}</span></h2>

          {rows.length > 0 && (
            <p className="meta" style={{ marginBottom: 'var(--s3)' }}>
              {thisWeek} רשמו תנועה השבוע · {silent} שקטים יותר משבוע
            </p>
          )}

          <div className="rows">
            {rows.map((home) => <HomeRow key={home.household_id} home={home} />)}
            {homes.loading && <Loading />}
          </div>

          {homes.error && <ErrorNote message={homes.error} onRetry={homes.reload} />}
          {!homes.loading && rows.length === 0 && <p className="meta">אין עדיין בתים.</p>}

          <p className="meta" style={{ marginTop: 'var(--s2)' }}>
            אין כאן סכומים, שמות עסקים או מוצרים, וגם לא בשאילתה שמזינה את המסך.
            «שקט» = שבוע בלי שום פעולה. «ימים» = ימים שבהם נרשמה תנועה, בכל שבוע מאז שהבית נפתח.
          </p>
        </section>

        <DatabaseSection />
      </div>
    </>
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
          {quiet(home) && <span className="mark mark-red" style={{ marginInlineStart: 8 }}>שקט</span>}
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

        {/* One entry per week that has begun. Week three is the pilot's
            question, so it is named in words wherever it appears. */}
        <span className="meta" style={{ fontSize: 12, display: 'block' }}>
          {home.active_days.slice(0, current + 1).map((days, w) => (
            <span key={w} style={w === 2 ? { fontWeight: 700 } : undefined}>
              {w > 0 && ' · '}
              שבוע {w + 1}{w === current ? ' (עכשיו)' : ''}: <span className="n">{days}</span> {days === 1 ? 'יום' : 'ימים'}
            </span>
          ))}
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
