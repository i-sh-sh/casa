import { useEffect, useState } from 'react';
import { Link, RouterProvider, useRouter } from '../lib/router.js';
import { GoogleSignInButton, SessionProvider, useSession } from '../lib/session.js';
import { ToastProvider, Loading } from '../ui/kit.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { HomeScreen } from '../features/home/HomeScreen.js';
import { BudgetScreen } from '../features/money/BudgetScreen.js';
import { TransactionsScreen } from '../features/money/TransactionsScreen.js';
import { PantryScreen } from '../features/pantry/PantryScreen.js';
import { ShoppingScreen } from '../features/shopping/ShoppingScreen.js';
import { SettingsScreen } from '../features/settings/SettingsScreen.js';
import { api } from '../lib/api.js';
import { useVersionCheck } from '../lib/version.js';

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

/** The waiting room: a real person who signed in but is not in the household yet. */
function Pending({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return (
    <div className="gate">
      <Icon name="lock" size={28} />
      <div className="wordmark" style={{ fontSize: 'var(--t-sub)', marginTop: 'var(--s4)' }}>ממתינים לאישור</div>
      <p>
        נכנסתם בתור <span className="n" style={{ fontSize: '.95em' }}>{email}</span>.
        <br />
        בעל הבית צריך לאשר את החשבון. בקשו ממנו לפתוח «הגדרות» ← «מי בבית».
      </p>
      <button className="btn" onClick={onSignOut}>יציאה</button>
    </div>
  );
}

function SignIn() {
  const { googleClientId, refresh } = useSession();
  return (
    <div className="gate">
      <div className="wordmark">קאסה</div>
      <p>
        התקציב, המזווה ורשימת הקניות. פנקס אחד, לשנינו.
      </p>
      <hr className="rule" style={{ margin: '0 0 var(--s5)' }} />
      {googleClientId
        ? <GoogleSignInButton clientId={googleClientId} onSignedIn={() => { void refresh(); }} />
        : (
          <p style={{ color: 'var(--red)' }}>
            חסר <span className="n">GOOGLE_CLIENT_ID</span> בהגדרות השרת — בלעדיו אי אפשר להיכנס.
          </p>
        )}
    </div>
  );
}

/**
 * The one case a forced update needs a human for.
 *
 * A mandatory release reloads the tab silently — twice, if the first attempt
 * comes back still old. After that it stops: a half-finished deploy or a proxy
 * serving stale HTML would otherwise loop forever and make the phone unusable.
 * At that point the only honest thing is to say so and hand over the one
 * action that actually clears it.
 */
function UpdateStuck({ latest, current }: { latest: string | null; current: string }) {
  return (
    <div className="sheet-backdrop" role="alertdialog" aria-modal="true">
      <div className="sheet">
        <h2>העדכון לא נתפס</h2>
        <p style={{ marginBottom: 'var(--s4)' }}>
          ניסינו לטעון מחדש פעמיים והדפדפן חזר עם הגרסה הישנה. זה קורה כשפריסה
          עוד באוויר או כששרת ביניים מחזיק עותק ישן.
        </p>
        <div className="rows" style={{ marginBottom: 'var(--s5)' }}>
          <div className="row" style={{ minHeight: 40 }}>
            <span className="grow label">הגרסה כאן</span><span className="n">{current}</span>
          </div>
          <div className="row" style={{ minHeight: 40 }}>
            <span className="grow label">הגרסה שפורסמה</span><span className="n">{latest ?? '—'}</span>
          </div>
        </div>
        <button className="btn btn-primary btn-block" onClick={() => location.reload()}>
          לנסות שוב
        </button>
        <p className="meta" style={{ marginTop: 'var(--s3)' }}>
          אם זה חוזר — סגרו את הלשונית ופתחו מחדש, או המתינו דקה שהפריסה תסתיים.
        </p>
      </div>
    </div>
  );
}

function Shell() {
  const { user, loading, signOut } = useSession();
  const [openItems, setOpenItems] = useState(0);
  const version = useVersionCheck();

  // The one number worth knowing without opening a screen: is there anything
  // to buy. It rides in the nav so the answer costs no navigation.
  useEffect(() => {
    if (!user || user.role === 'pending') return;
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

  if (loading) return <div className="page" style={{ maxWidth: 640 }}><Loading /></div>;
  if (!user) return <SignIn />;
  if (user.role === 'pending') return <Pending email={user.email} onSignOut={() => void signOut()} />;

  return (
    <div className="shell">
      <Screen />
      <Nav openItems={openItems} />
      {version.stuck && <UpdateStuck latest={version.latest} current={version.current} />}
    </div>
  );
}

export default function App() {
  return (
    <RouterProvider>
      <SessionProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </SessionProvider>
    </RouterProvider>
  );
}
