import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { formatILS } from '@shared/money.js';
import type { Explanation } from '@shared/explain.js';
import { markBusy } from './kit.js';
import { Icon } from './Icon.js';

type Source = () => Explanation | Promise<Explanation>;

// One slip open at a time. Opening a second closes the first, the way a
// finger moving down a column of figures only ever points at one.
let closeOpen: (() => void) | null = null;

const GUTTER = 16;
const MAX_WIDTH = 420;

interface Place { top?: number; bottom?: number; left: number; width: number; maxHeight: number; notch: number; below: boolean }

function placeFor(target: HTMLElement): Place {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  // Point at the number when there is one: that is what was asked about.
  const anchor = (target.querySelector('.amount, .figure, .n') as HTMLElement | null) ?? target;
  const a = anchor.getBoundingClientRect();
  const t = target.getBoundingClientRect();
  const width = Math.min(vw - GUTTER * 2, MAX_WIDTH);
  const centre = a.left + a.width / 2;
  const left = Math.min(Math.max(centre - width / 2, GUTTER), vw - GUTTER - width);
  const notch = Math.min(Math.max(centre - left, 18), width - 18);
  // The tab bar is fixed over the bottom of the page; a slip that runs under
  // it hides its own total, which is the line it exists to show.
  const nav = document.querySelector('.nav') as HTMLElement | null;
  const floor = nav ? nav.getBoundingClientRect().top : vh;
  const spaceBelow = floor - t.bottom - GUTTER;
  const spaceAbove = t.top - GUTTER;
  const below = spaceBelow >= 280 || spaceBelow >= spaceAbove;
  return below
    ? { top: t.bottom + 10, left, width, maxHeight: spaceBelow - 10, notch, below }
    : { bottom: vh - t.top + 10, left, width, maxHeight: spaceAbove - 10, notch, below };
}

/**
 * A figure that can be asked what it is made of.
 *
 * Tapping it opens a slip under the number: the rows it adds up, each with
 * its own amount, the double rule, and the total again — so the sum can be
 * redone by eye against the figure that was tapped. The slip is the ledger's
 * own shape (rules, no shadow, no radius), pinned to the number by a notch.
 *
 * It is a button, so it is reachable and announced like one; the dotted rule
 * under the figure is the only sign it can be opened, and it is a sign that
 * survives without hover.
 */
export function Explainable({ explain, children, className = 'row', style, inline = false, label }: {
  explain: Source;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Inside a sentence rather than a whole row. */
  inline?: boolean;
  /** Accessible name when the children alone do not say what opens. */
  label?: string;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`${className} explainable${inline ? ' explainable-inline' : ''}`}
        style={style}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        onClick={() => {
          if (open) { setOpen(false); return; }
          closeOpen?.();
          setOpen(true);
        }}
      >
        {children}
      </button>
      {open && button.current && (
        <Slip
          target={button.current}
          source={explain}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) button.current?.focus();
          }}
        />
      )}
    </>
  );
}

function Slip({ target, source, onClose }: { target: HTMLElement; source: Source; onClose: (refocus: boolean) => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Place>(() => placeFor(target));
  const [data, setData] = useState<Explanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Both arrive as fresh closures on every render of the screen behind; the
  // slip asks once and listens once, for as long as it is open.
  const sourceRef = useRef(source);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => sourceRef.current())
      .then((e) => { if (live) setData(e); })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : 'לא הצלחתי לטעון את הפירוט'); });
    return () => { live = false; };
  }, []);

  // Re-measure once the content is in: the slip may need to flip above.
  useLayoutEffect(() => { setPlace(placeFor(target)); }, [target, data]);

  useEffect(() => {
    const unmark = markBusy();
    const close = () => closeRef.current(false);
    closeOpen = close;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(true); };
    const onDown = (e: PointerEvent) => {
      const node = e.target as Node;
      if (panel.current?.contains(node) || target.contains(node)) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    // The slip is pinned to a place on the page; once the page moves under
    // it, it is pointing at the wrong number.
    window.addEventListener('scroll', close, { passive: true });
    window.addEventListener('resize', close);
    panel.current?.focus({ preventScroll: true });
    return () => {
      unmark();
      if (closeOpen === close) closeOpen = null;
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', close);
      window.removeEventListener('resize', close);
    };
  }, [target]);

  const agorot = !!data && [data.total, ...data.lines.map((l) => l.amount)].some((n) => !Number.isInteger(Math.round(n * 100) / 100));
  const money = (n: number, signed: boolean) => formatILS(n, { symbol: false, sign: signed, agorot });

  return createPortal(
    <div
      ref={panel}
      className={`slip ${place.below ? 'slip-below' : 'slip-above'}`}
      role="dialog"
      aria-label={data ? `פירוט: ${data.title}` : 'פירוט'}
      tabIndex={-1}
      style={{ top: place.top, bottom: place.bottom, left: place.left, width: place.width, maxHeight: place.maxHeight }}
    >
      <span className="slip-notch" style={{ left: place.notch }} aria-hidden="true" />
      <div className="slip-head">
        <span className="label" style={{ flex: 1 }}>{data?.title ?? 'פירוט'} · ₪</span>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => onClose(true)} aria-label="סגירה">
          <Icon name="close" size={16} />
        </button>
      </div>

      {error && <p className="meta" role="alert">{error}</p>}
      {!data && !error && <p className="meta">טוען…</p>}

      {data && (
        <>
          <p className="slip-how">{data.how}</p>
          <div className="slip-lines">
            {data.lines.length === 0 && <p className="meta" style={{ padding: 'var(--s2) 0' }}>אין שורות החודש.</p>}
            {data.lines.map((l) => (
              <div className="slip-line" key={l.key}>
                <span className="grow">
                  <span className="slip-label">{l.label}</span>
                  {l.meta && <span className="meta">{l.meta}</span>}
                </span>
                <span className={`n amount ${l.amount < 0 && !data.signed ? 'over' : ''}`}>{money(l.amount, data.signed)}</span>
              </div>
            ))}
          </div>
          <hr className="rule-2" />
          <div className="slip-line slip-total">
            <span className="grow label">{data.totalLabel}</span>
            <span className={`n amount ${data.total < 0 ? 'over' : ''}`}>{money(data.total, data.signed)}</span>
          </div>
          {data.missing !== 0 && (
            <p className="meta" style={{ marginTop: 'var(--s2)' }}>
              עוד <span className="n">{money(data.missing, false)}</span> שלא מופיעים כאן: הרשימה מציגה עד 500 התנועות האחרונות של החודש.
            </p>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}
