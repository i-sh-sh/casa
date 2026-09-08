import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode, type FormEvent,
} from 'react';
import { Icon } from './Icon.js';
import { markBusy } from '../lib/version.js';

let busyCount = 0;

export function markBusy(): () => void {
  busyCount++;
  return () => {
    busyCount = Math.max(0, busyCount - 1);
  };
}

export function isBusy(): boolean {
  return busyCount > 0;
}

// ── Sheet ────────────────────────────────────────────────────────────────

/**
 * The one modal shape in the app: a sheet that rises from the bottom edge.
 *
 * It is bordered, not floated — a 3px ink rule instead of a shadow, because
 * this app has no elevation. On a wide screen the same component centres
 * itself and closes the border all the way round.
 */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unmark = markBusy();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    // An open sheet is a half-finished action — a form with an amount already
    // typed into it. A background update must wait for it to close rather
    // than reload the page out from under it.
    const release = markBusy();
    return () => {
      unmark();
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
      release();
    };
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} role="presentation">
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={panel} tabIndex={-1}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--s3)' }}>
          <h2 style={{ flex: 1 }}>{title}</h2>
          <button className="btn btn-quiet" onClick={onClose} aria-label="סגירה"><Icon name="close" size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Toast, with undo ─────────────────────────────────────────────────────

interface ToastValue {
  show: (message: string, opts?: { tone?: 'ink' | 'bad'; undo?: () => void }) => void;
}
const ToastContext = createContext<ToastValue>({ show: () => {} });

/**
 * Ticking an item off the shopping list writes to the pantry, which makes it
 * the one destructive action in daily use — so it gets an undo rather than a
 * confirmation. A confirmation before every tick would be unusable in an
 * aisle; five seconds to take it back is not.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; tone: 'ink' | 'bad'; undo?: () => void } | null>(null);
  const timer = useRef<number>();

  const show = useCallback<ToastValue['show']>((message, opts = {}) => {
    const tone = opts.tone ?? 'ink';
    setToast({ message, tone, undo: opts.undo });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), opts.undo ? 5000 : tone === 'bad' ? 5000 : 2600);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {toast && (
        <div className={`toast ${toast.tone === 'bad' ? 'bad' : ''}`} role="status" aria-live="polite">
          <span>{toast.message}</span>
          {toast.undo && (
            <button
              className="undo"
              onClick={() => { toast.undo?.(); setToast(null); window.clearTimeout(timer.current); }}
            >
              ביטול
            </button>
          )}
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

/**
 * Not a spinner.
 *
 * The page's ruling arrives before its content, so the structure is already
 * on screen when the numbers land and nothing shifts underneath the reader.
 * A centred spinner tells you only that you are waiting.
 */
export function Loading() {
  return (
    <div className="loading" role="status" aria-label="טוען">
      <i /><i /><i />
    </div>
  );
}

/**
 * An empty state that is a ruled page with nothing written on it yet.
 *
 * Deliberately not the centred column with a faded circular icon, a bold
 * line, a grey subline and a pill button — that exact composition is the most
 * copied empty state on the web, and it is one of the surest tells.
 */
export function Empty({ headline, hint, action }: { headline: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="headline">{headline}</div>
      {hint && <p>{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="note-error" role="alert">
      <div style={{ display: 'flex', gap: 'var(--s2)', alignItems: 'flex-start' }}>
        <Icon name="alert" size={18} />
        <div style={{ flex: 1 }}>{message}</div>
      </div>
      {onRetry && <button className="btn btn-sm btn-red" style={{ marginTop: 'var(--s3)' }} onClick={onRetry}>נסו שוב</button>}
    </div>
  );
}

/** A form that cannot be double-submitted and never swallows the server's sentence. */
export function AsyncForm({ onSubmit, submitLabel, children, disabled }: {
  onSubmit: () => Promise<void>;
  submitLabel: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!busy) return;
    const unmark = markBusy();
    return () => unmark();
  }, [busy]);

  const handle = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const release = markBusy();
    try {
      await onSubmit();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'משהו השתבש');
    } finally {
      release();
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handle} noValidate>
      {children}
      {error && <p style={{ color: 'var(--red)', fontSize: 15, marginBottom: 'var(--s3)' }}>{error}</p>}
      <button className="btn btn-primary btn-block" type="submit" disabled={busy || disabled}>
        {busy ? 'רגע…' : submitLabel}
      </button>
    </form>
  );
}
