import { useEffect, useState } from 'react';
import { Link, RouterProvider, useRouter } from '../lib/router.js';
import { GoogleSignInButton, SessionProvider, useSession } from '../lib/session.js';
import { ToastProvider, Spinner } from '../ui/kit.js';
import { HomeScreen } from '../features/home/HomeScreen.js';
import { BudgetScreen } from '../features/money/BudgetScreen.js';
import { TransactionsScreen } from '../features/money/TransactionsScreen.js';
import { PantryScreen } from '../features/pantry/PantryScreen.js';
import { ShoppingScreen } from '../features/shopping/ShoppingScreen.js';
import { SettingsScreen } from '../features/settings/SettingsScreen.js';
import { api } from '../lib/api.js';

const TABS = [
  { to: '/',          glyph: '🏠', label: 'הבית' },
  { to: '/shopping',  glyph: '🛒', label: 'קניות' },
  { to: '/pantry',    glyph: '🥫', label: 'מזווה' },
  { to: '/budget',    glyph: '💰', label: 'תקציב' },
  { to: '/settings',  glyph: '⚙️', label: 'הגדרות' },
] as const;

function Nav({ openItems }: { openItems: number }) {
  return (
    <nav className="nav" aria-label="ניווט ראשי">
      {TABS.map((tab) => (
        <Link key={tab.to} to={tab.to}>
          <span className="glyph" aria-hidden="true">{tab.glyph}</span>
          <span>{tab.label}</span>
          {tab.to === '/shopping' && openItems > 0 && (
            <span className="badge" aria-label={`${openItems} פריטים ברשימה`}>{openItems}</span>
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
        <span className="glyph">🤷</span>
        <p>אין כאן מסך כזה.</p>
        <Link to="/" className="btn btn-ghost">חזרה הביתה</Link>
      </div>
    </div>
  );
}

/** The waiting room: a real person who signed in but is not in the household yet. */
function Pending({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return (
    <div className="center-screen">
      <div style={{ maxWidth: 380 }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🔒</div>
        <h1 style={{ fontSize: 22, marginBottom: 10 }}>ממתינים לאישור</h1>
        <p className="muted" style={{ marginBottom: 6 }}>
          נכנסתם בתור <strong dir="ltr">{email}</strong>.
        </p>
        <p className="muted" style={{ marginBottom: 20 }}>
          בעל הבית צריך לאשר את החשבון לפני שתראו משהו. בקשו ממנו לפתוח «הגדרות ← משתמשים».
        </p>
        <button className="btn btn-ghost" onClick={onSignOut}>יציאה</button>
      </div>
    </div>
  );
}

function SignIn() {
  const { googleClientId, refresh } = useSession();
  return (
    <div className="center-screen">
      <div style={{ maxWidth: 340 }}>
        <div style={{ fontSize: 52, marginBottom: 8 }}>🏠</div>
        <h1 style={{ fontSize: 26, marginBottom: 6 }}>קאסה</h1>
        <p className="muted" style={{ marginBottom: 28 }}>
          התקציב, המזווה ורשימת הקניות — במקום אחד, לשנינו.
        </p>
        {googleClientId
          ? <GoogleSignInButton clientId={googleClientId} onSignedIn={() => { void refresh(); }} />
          : (
            <p style={{ color: 'var(--bad)', fontSize: 14 }}>
              חסר <code>GOOGLE_CLIENT_ID</code> בהגדרות השרת — בלעדיו אי אפשר להיכנס.
            </p>
          )}
      </div>
    </div>
  );
}

function Shell() {
  const { user, loading, signOut } = useSession();
  const [openItems, setOpenItems] = useState(0);

  // The shopping badge is the one number worth knowing without opening a
  // screen — "יש משהו לקנות" is the question the app answers most often.
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

  if (loading) return <div className="center-screen"><Spinner /></div>;
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
