import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode, type FormEvent,
} from 'react';

// ── Sheet ────────────────────────────────────────────────────────────────

/**
 * The one modal shape in the app: a sheet that rises from the bottom.
 *
 * Everything that adds or edits uses it, because on a phone a form that slides
 * up from the thumb is reachable and a centred dialog is not. On a wide screen
 * the same component centres itself — one component, two behaviours, no second
 * implementation to keep in sync.
 */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // The page behind must not scroll while a sheet is open — on iOS that
    // scroll is what makes a sheet feel like it is floating over nothing.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Focus moves into the sheet so a keyboard user is not left behind it.
    panel.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={panel} tabIndex={-1}>
        <div className="sheet-grip" />
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

// ── Toast ────────────────────────────────────────────────────────────────

interface ToastValue { show: (message: string, tone?: 'ok' | 'bad') => void }
const ToastContext = createContext<ToastValue>({ show: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; tone: 'ok' | 'bad' } | null>(null);
  const timer = useRef<number>();

  const show = useCallback((message: string, tone: 'ok' | 'bad' = 'ok') => {
    setToast({ message, tone });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), tone === 'bad' ? 5000 : 2800);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {toast && (
        // aria-live so a screen reader hears "נשמר" too — the visual flash is
        // the whole confirmation, and it is invisible to anyone not looking.
        <div className={`toast ${toast.tone === 'bad' ? 'bad' : ''}`} role="status" aria-live="polite">
          {toast.message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue { return useContext(ToastContext); }

// ── Async data ───────────────────────────────────────────────────────────

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  set: (updater: (prev: T | null) => T | null) => void;
}

/**
 * Load-on-mount with a reload handle.
 *
 * `set` exists so a screen can apply a change it already knows succeeded
 * without a round trip — ticking an item off a shopping list should move it
 * the instant it is tapped, not after 300ms of network.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loader()
      .then((result) => { if (!cancelled) { setData(result); setError(null); } })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const set = useCallback((updater: (prev: T | null) => T | null) => setData(updater), []);
  return { data, error, loading, reload, set };
}

// ── Small pieces ─────────────────────────────────────────────────────────

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

export function Empty({ glyph, title, hint, action }: { glyph: string; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="glyph" aria-hidden="true">{glyph}</span>
      <p><strong style={{ color: 'var(--ink-2)' }}>{title}</strong></p>
      {hint && <p style={{ fontSize: 14 }}>{hint}</p>}
      {action}
    </div>
  );
}

export function Spinner() { return <div className="spinner" role="status" aria-label="טוען" />; }

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card card-pad" style={{ borderColor: 'var(--bad)', background: 'var(--bad-soft)' }}>
      <p style={{ color: 'var(--bad)' }}>{message}</p>
      {onRetry && <button className="btn btn-sm btn-ghost" style={{ marginTop: 10 }} onClick={onRetry}>נסו שוב</button>}
    </div>
  );
}

/**
 * A form that cannot be double-submitted and never loses the error.
 *
 * The pattern it removes from every screen: disable while in flight, catch,
 * surface the server's sentence, re-enable. Getting that wrong once means a
 * double-tap creates two transactions.
 */
export function AsyncForm({ onSubmit, submitLabel, children, disabled }: {
  onSubmit: () => Promise<void>;
  submitLabel: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handle = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'משהו השתבש');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handle} noValidate>
      {children}
      {error && <p style={{ color: 'var(--bad)', fontSize: 14, marginBottom: 10 }}>{error}</p>}
      <button className="btn btn-primary btn-block" type="submit" disabled={busy || disabled}>
        {busy ? 'רגע…' : submitLabel}
      </button>
    </form>
  );
}
