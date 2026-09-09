import { useEffect, useState } from 'react';
import { Link, RouterProvider, useRouter } from '../lib/router.js';
import { GoogleSignInButton, SessionProvider, useSession } from '../lib/session.js';
import { ToastProvider, Loading } from '../ui/kit.js';
import { OutboxProvider } from '../lib/outbox.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { HomeScreen } from '../features/home/HomeScreen.js';
import { BudgetScreen } from '../features/money/BudgetScreen.js';
import { TransactionsScreen } from '../features/money/TransactionsScreen.js';
import { PantryScreen } from '../features/pantry/PantryScreen.js';
import { ShoppingScreen } from '../features/shopping/ShoppingScreen.js';
import { SettingsScreen } from '../features/settings/SettingsScreen.js';
import { HouseholdGate } from '../features/household/HouseholdGate.js';
import { api } from '../lib/api.js';
import { useVersion } from '../lib/version.js';

const TABS: { to: string; icon: IconName; label: string }[] = [
  { to: '/',         icon: 'home',   label: 'הבית' },
  { to: '/shopping', icon: 'cart',   label: 'קניות' },
  { to: '/pantry',   icon: 'pantry', label: 'מזווה' },
  { to: '/budget',   icon: 'ledger', label: 'תקציב' },
  { to: '/settings', icon: 'dials',  label: 'הגדרות' },
];

function Nav({ openItems }: { openItems: number }) {
  return (
    <nav className="nav" aria-label="ניווט ראשי">
      {TABS.map((tab) => (
        <Link key={tab.to} to={tab.to}>
          <Icon name={tab.icon} size={20} />
          <span>{tab.label}</span>
          {/* A tally in the margin, not a filled badge. It counts, so it is set
              in the numeral face like every other number in the app. */}
          {tab.to === '/shopping' && openItems > 0 && (
            <span className="tally" aria-label={`${openItems} פריטים ברשימה`}>{openItems}</span>
          )}
        </Link>
      ))}
    </nav>
  );
}

function Screen() {
  const { path } = useRouter();
  if (path === '/') return <HomeScreen />;
  if (path.startsWith('/shopping')) return <ShoppingScreen />;
  if (path.startsWith('/pantry')) return <PantryScreen />;
  if (path.startsWith('/budget')) return <BudgetScreen />;
  if (path.startsWith('/transactions')) return <TransactionsScreen />;
  if (path.startsWith('/settings')) return <SettingsScreen />;
  return (
    <div className="page">
      <div className="empty">
        <div className="headline">אין כאן דף כזה</div>
        <p>הכתובת שהגעתם אליה לא קיימת באפליקציה.</p>
        <Link to="/" className="btn">חזרה לעמוד הראשי</Link>
      </div>
    </div>
  );
}

/**
 * The waiting room: admitted to a home, but not yet by its owner.
 *
 * Distinct from having no home at all, which is HouseholdGate. The difference
 * matters to the person standing there: one of them can act — open a home,
 * follow a link — and the other can only wait.
 */
function Pending({ email, household, onSignOut }: { email: string; household: string; onSignOut: () => void }) {
  return (
    <div className="gate">
      <Icon name="lock" size={28} />
      <div className="wordmark" style={{ fontSize: 'var(--t-sub)', marginTop: 'var(--s4)' }}>ממתינים לאישור</div>
      <p>
        נכנסתם ל<b>{household}</b> בתור <span className="n" style={{ fontSize: '.95em' }}>{email}</span>.
        <br />
        בעל הבית צריך לאשר את החשבון. בקשו ממנו לפתוח «הגדרות» ← «מי בבית».
      </p>
      <button className="btn" onClick={onSignOut}>יציאה</button>
    </div>
  );
}

/** Where the app actually lives. Google was told about this origin and no other. */
const HOME_ORIGIN = 'https://www.casa-ish.com';

/**
 * Google's sign-in checks the *origin* of the page against a list somebody
 * typed into the Cloud Console. Exact strings, no wildcards.
 *
 * Vercel mints a new immutable hostname for every deployment
 * (`casa-<hash>-<scope>.vercel.app`) — that is the address the dashboard's
 * "Visit" button opens. It can never be on that list: it did not exist when the
 * list was written, and the next deploy invents another one. So sign-in fails
 * there and only there, which reads as "the new deploy is broken" when the
 * deploy is fine and the address simply is not the app's address.
 *
 * The custom domain is an alias that follows production, so it is stable, and
 * it is the one Google was told about.
 */
const onDeploymentUrl = (): boolean =>
  typeof location !== 'undefined' && location.hostname.endsWith('.vercel.app');

function SignIn() {
  const { googleClientId, failure, refresh } = useSession();

  // Three states, and telling them apart is the whole point of this component.
  //
  // It used to have two: a button, or «חסר GOOGLE_CLIENT_ID». So a database
  // that would not connect — a wrong password, a role without privileges, a
  // half-finished deploy — rendered as a confident, specific, wrong claim about
  // Google, and sent us to reconfigure something that was never broken.
  //
  // A screen may say "the server did not answer". It may not invent the reason.
  return (
    <div className="gate">
      <div className="wordmark">קאסה</div>
      <p>
        התקציב, המזווה ורשימת הקניות. פנקס אחד, לשנינו.
      </p>
      <hr className="rule" style={{ margin: '0 0 var(--s5)' }} />

      {failure ? (
        <>
          <p style={{ color: 'var(--red)' }}>השרת לא ענה, אז אי אפשר להיכנס כרגע.</p>
          <p className="meta n" style={{ fontSize: 13, marginBottom: 'var(--s4)' }}>{failure}</p>
          <button className="btn btn-block" onClick={() => void refresh()}>לנסות שוב</button>
        </>
      ) : googleClientId ? (
        <GoogleSignInButton clientId={googleClientId} onSignedIn={() => { void refresh(); }} />
      ) : (
        <p style={{ color: 'var(--red)' }}>
          השרת ענה, אבל בלי <span className="n">GOOGLE_CLIENT_ID</span> — בלעדיו אי אפשר להיכנס.
          בדקו את משתני הסביבה ב-Vercel.
        </p>
      )}

      {/*
        Below the button, not above it: somebody deciding whether to hand over
        their household's money can read what happens to it first, and Google's
        consent screen links to the same two pages.
      */}
      <p className="meta" style={{ marginTop: 'var(--s5)', fontSize: 13 }}>
        <a href="/privacy">מדיניות פרטיות</a>
        {' · '}
        <a href="/terms">תנאי שימוש</a>
      </p>

      {onDeploymentUrl() && (
        <p className="meta" style={{ marginTop: 'var(--s4)', fontSize: 13 }}>
          זו כתובת פריסה של Vercel, וגוגל מאשרת רק כתובות שנרשמו מראש — הכניסה תיכשל כאן
          גם כשהכול תקין. הכתובת של קאסה היא{' '}
          <a href={HOME_ORIGIN}>{HOME_ORIGIN.replace('https://', '')}</a>.
        </p>
      )}
    </div>
  );
}

function StuckDialog({ onReload }: { onReload: () => void }) {
  return (
    <div className="gate">
      <Icon name="alert" size={28} />
      <div className="wordmark" style={{ fontSize: 'var(--t-sub)', marginTop: 'var(--s4)' }}>העדכון לא נתפס</div>
      <p>
        ניסינו לעדכן לגרסה החדשה אך הדפדפן ממשיך לטעון את הגרסה הישנה.
        <br />
        נסו ללחוץ על הכפתור למטה, או לסגור ולפתוח מחדש את האפליקציה.
      </p>
      <button className="btn btn-primary" onClick={onReload}>ניסיון נוסף</button>
    </div>
  );
}

function Shell() {
  const { user, loading, signOut, refresh } = useSession();
  const { stuck, reload } = useVersion();
  const [openItems, setOpenItems] = useState(0);

  // The one number worth knowing without opening a screen: is there anything
  // to buy. It rides in the nav so the answer costs no navigation.
  useEffect(() => {
    if (!user || user.household_id === null || user.role === 'pending') return;
    let cancelled = false;
    const load = () => {
      api.get<{ id: number }[]>('/shopping/items', { status: 'open' })
        .then((items) => { if (!cancelled) setOpenItems(items.length); })
        .catch(() => {});
    };
    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
  }, [user]);

  if (stuck) return <StuckDialog onReload={reload} />;
  if (loading) return <div className="page" style={{ maxWidth: 640 }}><Loading /></div>;
  if (!user) return <SignIn />;
  // Signed in, but belonging nowhere: open a home, or open an invitation.
  if (user.household_id === null) return <HouseholdGate onJoined={() => { void refresh(); }} />;
  if (user.role === 'pending') {
    return <Pending email={user.email} household={user.household_name ?? ''} onSignOut={() => void signOut()} />;
  }

  return (
    <div className="shell">
      <Screen />
      <Nav openItems={openItems} />
    </div>
  );
}

export default function App() {
  return (
    <RouterProvider>
      <SessionProvider>
        <ToastProvider>
          {/* Inside the session, because a queued action is one household's. */}
          <OutboxProvider>
            <Shell />
          </OutboxProvider>
        </ToastProvider>
      </SessionProvider>
    </RouterProvider>
  );
}
