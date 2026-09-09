import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode, type FormEvent,
} from 'react';
import { Icon } from './Icon.js';

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
    return () => {
      unmark();
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
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

// ── Folded sections ──────────────────────────────────────────────────────

/**
 * Remembers which sections a person opened and shut. Only that.
 *
 * The distinction is the whole design: what is stored is a **decision**, never
 * a state. A section nobody has ever touched is absent from the map, so the
 * screen is free to choose a sensible default for it — and free to choose a
 * different one next month — while a section somebody deliberately shut stays
 * shut. Storing the state instead would freeze today's guess forever, and the
 * first time the guess got better every returning user would keep the old one.
 *
 * localStorage and not the server: this is a per-device convenience, and a
 * round trip to remember a fold would be a round trip too many. It is also the
 * one place a throw is genuinely uninteresting — a private window, cleared site
 * data, storage disabled — so every access is guarded and the fold simply falls
 * back to its default.
 */
export function useFolds(scope: string) {
  const key = `casa-folds:${scope}`;
  const [decided, setDecided] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });

  const toggle = useCallback((id: string, fallback: boolean) => {
    setDecided((prev) => {
      const next = { ...prev, [id]: !(prev[id] ?? fallback) };
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* not worth failing a tap over */ }
      return next;
    });
  }, [key]);

  /** `fallback` is the screen's judgement for a section nobody has ruled on. */
  const isOpen = useCallback(
    (id: string, fallback: boolean) => decided[id] ?? fallback,
    [decided],
  );

  /**
   * Fixes a section's default the first time it is seen, and never again.
   *
   * Without this the defaults are live, and a live default folds the screen
   * under a moving thumb: tick the last item in an aisle, the aisle judges
   * itself finished, and it shuts — mid-shop, with the trolley in the other
   * hand. The same shape lies in wait in the pantry, where restocking the last
   * low product would close the shelf being stood in front of.
   *
   * It is the rule the list itself already follows in never re-sorting under a
   * thumb (docs/DESIGN.md §8): what is on screen may change what it *says*,
   * never where it *is*. The judgement is made once, on arrival; the next visit
   * makes it again with fresh eyes.
   */
  const settled = useRef<Record<string, boolean>>({});
  const settle = useCallback((id: string, value: boolean): boolean => {
    settled.current[id] ??= value;
    return settled.current[id]!;
  }, []);

  return { isOpen, toggle, settle };
}

/**
 * A section that can be shut.
 *
 * The problem it solves is a pantry with sixty products: eight aisles of rows,
 * and the two things that actually need doing are somewhere in the middle of
 * them. Shutting an aisle is not hiding information — it is the difference
 * between a list and an index.
 *
 * Three rules make it earn its place rather than merely add a tap:
 *
 * **A shut section still says what is inside it.** The count stays, and so does
 * `note` — which is where a screen puts the thing that would make somebody open
 * it: «2 נגמרים», a group's remaining budget. A fold that hides the signal
 * along with the detail has made the screen worse, not shorter.
 *
 * **The mark is vertical.** Every sideways disclosure has to decide which way
 * "forward" points, and this page is right-to-left. Down means shut and up
 * means open in every language.
 *
 * **The heading is still the heading.** Same 12/700/+0.06em label on the same
 * ink rule as an unfoldable section, because a screen where some headings are
 * chrome and others are controls reads as two screens.
 */
export function Fold({ id, title, count, mark, note, open, onToggle, children }: {
  id: string;
  title: string;
  /** Shown beside the title, in the marginal ink. Usually how many rows. */
  count?: ReactNode;
  /**
   * A word beside the label — «חריגה», «נלקח הכול».
   *
   * It sits here rather than in `note` for the reason every number in this app
   * hangs on one invisible vertical line: `note` is the left-hand column, and a
   * word sharing that column pushes the digits of one section out of line with
   * the next. Marks go with the label; figures go in the column.
   */
  mark?: ReactNode;
  /** The reason to open it: what it comes to, or what is wrong in here. */
  note?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const panel = `fold-${id}`;
  return (
    <section className="section section-fold">
      <h2 className="fold-h2">
        <button
          type="button"
          className="fold-head"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={panel}
        >
          <span className="fold-title">{title}</span>
          {count !== undefined && <span className="count">{count}</span>}
          {mark}
          <span className="fold-gap" />
          {note}
          <Icon name="chevron" size={16} className={open ? 'fold-mark fold-mark-open' : 'fold-mark'} />
        </button>
      </h2>
      {/* Unmounted, not hidden: sixty rows kept in the tree for a section
          nobody has open is sixty rows of layout on every render. */}
      {open && <div id={panel}>{children}</div>}
    </section>
  );
}
