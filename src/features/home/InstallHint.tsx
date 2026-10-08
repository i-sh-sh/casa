import { useEffect, useState } from 'react';

/** Chrome's install event, which TypeScript's DOM types do not know yet. */
interface InstallPrompt extends Event { prompt: () => Promise<void> }

// Chrome fires this once, early, and possibly before the home screen mounts,
// so it is caught when the module loads and kept for whoever asks later.
let deferred: InstallPrompt | null = null;
const waiting = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    waiting.forEach((f) => f());
  });
}

const HIDDEN = 'casa-install-hidden';

const installed = (): boolean =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

// iPadOS reports itself as a Mac; the touch screen gives it away.
const isIOS = (): boolean =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);

function readHidden(): boolean {
  try { return localStorage.getItem(HIDDEN) === '1'; } catch { return false; }
}

/**
 * «להוסיף למסך הבית» — one line, on a phone, until it is done or dismissed.
 *
 * A site in a browser tab is forgotten by the third week; an icon next to
 * WhatsApp is not, and the pilot's question is the third week. Android can
 * install from a button. iPhone cannot be asked from a page at all, so it gets
 * the two taps written out. On a computer, or once installed, nothing.
 */
export function InstallHint() {
  const [hidden, setHidden] = useState(() => readHidden() || installed());
  const [canPrompt, setCanPrompt] = useState(deferred !== null);

  useEffect(() => {
    const ready = () => setCanPrompt(true);
    waiting.add(ready);
    return () => { waiting.delete(ready); };
  }, []);

  const ios = isIOS();
  if (hidden || (!canPrompt && !ios)) return null;

  const hide = () => {
    try { localStorage.setItem(HIDDEN, '1'); } catch { /* it comes back next time, which is fine */ }
    setHidden(true);
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    deferred = null;
    hide();
  };

  return (
    <div className="row" style={{ minHeight: 56, marginBottom: 'var(--s4)' }}>
      <span className="grow">
        <span className="title" style={{ display: 'block' }}>להוסיף את קאסה למסך הבית</span>
        <span className="meta">
          {ios ? 'בספארי: כפתור השיתוף, ואז «הוסף למסך הבית».' : 'אייקון ליד וואטסאפ, בלי לחפש בדפדפן.'}
        </span>
      </span>
      {!ios && <button className="btn btn-sm btn-primary" onClick={() => void install()}>הוספה</button>}
      <button className="btn btn-sm btn-quiet" onClick={hide} aria-label="להסתיר">לא עכשיו</button>
    </div>
  );
}
