import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import type { Household, User } from '@shared/types.js';

export interface Member { email: string; display_name: string; color: string | null; role: string }

interface SessionValue {
  user: User | null;
  /**
   * Why the session could not be loaded, when that is the reason there is no
   * user. Null both when signed out normally and when signed in.
   */
  failure: string | null;
  members: Member[];
  /** Every home this person belongs to. Empty for someone who belongs to none. */
  households: Household[];
  loading: boolean;
  googleClientId: string | null;
  /** Offers the pilot screen. Never the authorisation — the API checks for itself. */
  isOperator: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue>({
  user: null, failure: null, members: [], households: [], loading: true, googleClientId: null,
  isOperator: false,
  refresh: async () => {}, signOut: async () => {},
});

interface MeResponse {
  user: User | null;
  members?: Member[];
  households?: Household[];
  google_client_id: string | null;
  is_operator?: boolean;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [households, setHouseholds] = useState<Household[]>([]);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);
  const [isOperator, setIsOperator] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * The failure is kept, not swallowed.
   *
   * This `catch` used to do nothing but `setUser(null)`, which meant every
   * possible failure of /auth/me — a database that will not connect, a role
   * without privileges, a deploy half-finished — rendered as the sign-in screen
   * announcing «חסר GOOGLE_CLIENT_ID». That message was confident, specific and
   * wrong, and it sent us to reconfigure Google while the actual problem was a
   * connection string. An error message that names the wrong cause is worse
   * than one that admits it does not know.
   */
  const refresh = useCallback(async () => {
    try {
      const data = await api.get<MeResponse>('/auth/me');
      setUser(data.user);
      setMembers(data.members ?? []);
      setHouseholds(data.households ?? []);
      setGoogleClientId(data.google_client_id);
      setIsOperator(data.is_operator === true);
      setFailure(null);
    } catch (err) {
      setUser(null);
      setFailure(err instanceof Error ? err.message : 'לא הצלחנו לטעון את הסשן');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // A 401 from anywhere in the app means the session died mid-use — an expired
  // token, a revoked role. Clearing the user here is what turns that into the
  // sign-in screen rather than a screen full of failed panels.
  useEffect(() => { setUnauthorizedHandler(() => setUser(null)); }, []);

  const signOut = useCallback(async () => {
    await api.post('/auth/logout').catch(() => {});
    setUser(null);
    setFailure(null);
    setMembers([]);
    setHouseholds([]);
    // The cached shopping list has to go with the session. Otherwise the next
    // person to open the app on this phone sees the previous household's list
    // before a single request is made.
    try {
      navigator.serviceWorker?.controller?.postMessage('casa:forget');
      localStorage.removeItem('casa.outbox.v1');
    } catch { /* no service worker, or storage refused */ }
  }, []);

  return (
    <SessionContext.Provider value={{ user, failure, members, households, loading, googleClientId, isOperator, refresh, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  return useContext(SessionContext);
}

/** The signed-in user, for the screens that only render when there is one. */
export function useUser(): User {
  const { user } = useSession();
  if (!user) throw new Error('useUser called outside a signed-in screen');
  return user;
}

// ── Google Sign-In ───────────────────────────────────────────────────────

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: { client_id: string; callback: (r: { credential: string }) => void }) => void;
          renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
        };
      };
    };
  }
}

/**
 * Renders Google's own button, because Google requires it.
 *
 * The script is loaded on demand rather than in index.html: it is 90kB that
 * every already-signed-in visit would pay for and never use, and this is a
 * screen most sessions never see.
 */
export function GoogleSignInButton({ clientId, onSignedIn }: { clientId: string; onSignedIn: () => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const render = () => {
      if (cancelled || !holder.current || !window.google) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (response) => {
          setBusy(true);
          // Signing in says only who you are. Whether you belong to a home is a
          // separate question, answered by the /auth/me that follows.
          api.post('/auth/google', { credential: response.credential })
            .then(() => onSignedIn())
            .catch((err: Error) => setError(err.message))
            .finally(() => setBusy(false));
        },
      });
      window.google.accounts.id.renderButton(holder.current, {
        theme: 'outline', size: 'large', shape: 'pill', locale: 'he', width: 280,
      });
    };

    if (window.google) { render(); return () => { cancelled = true; }; }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = render;
    script.onerror = () => setError('לא הצלחנו לטעון את הכניסה של גוגל');
    document.head.appendChild(script);
    return () => { cancelled = true; };
  }, [clientId, onSignedIn]);

  return (
    <div>
      <div ref={holder} style={{ display: 'flex', justifyContent: 'center', minHeight: 44 }} />
      {busy && <p className="muted" style={{ marginTop: 12 }}>רגע…</p>}
      {error && <p style={{ color: 'var(--bad)', marginTop: 12 }}>{error}</p>}
    </div>
  );
}
