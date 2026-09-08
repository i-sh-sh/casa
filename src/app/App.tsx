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
  const { user, loading, signOut } = useSession();
  const { stuck, reload } = useVersion();
  const [openItems, setOpenItems] = useState(0);

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

  if (stuck) return <StuckDialog onReload={reload} />;
  if (loading) return <div className="page" style={{ maxWidth: 640 }}><Loading /></div>;
  if (!user) return <SignIn />;
  if (user.role === 'pending') return <Pending email={user.email} onSignOut={() => void signOut()} />;

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
          <Shell />
        </ToastProvider>
      </SessionProvider>
    </RouterProvider>
  );
}
