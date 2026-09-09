import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react';
import { ApiError } from './api.js';
import {
  backoffMs, classify, discard as dropAction, EMPTY, enqueue, head, parkStale,
  pendingCount, pendingSubjects, resolve, retryAll, type Action, type Outbox,
} from '@shared/outbox.js';

/**
 * The runtime half of working offline. The rules live in shared/outbox.ts.
 *
 * Three things this file is responsible for and the pure logic cannot be:
 *
 * **Surviving the app being closed.** A phone in a coat pocket gets its tab
 * evicted, and a queue that lived only in React state would take the shopping
 * with it. The queue is written to localStorage on every change — synchronously,
 * before the request is even attempted, because the crash we are guarding
 * against happens between the two.
 *
 * **Sending one action at a time, in order.** A tick and an untick of the same
 * line are not commutative, and neither are two edits of one quantity. Parallel
 * sending would be faster and occasionally wrong.
 *
 * **Not lying about being online.** `navigator.onLine` is false-positive by
 * design: it means "attached to a network", which a supermarket wifi captive
 * portal satisfies perfectly. So it is used to decide when to *try*, never to
 * decide that something failed — that judgement belongs to the response, or to
 * the absence of one.
 */

const KEY = 'casa.outbox.v1';

function load(): Outbox {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Outbox;
    return Array.isArray(parsed?.actions) ? parkStale(parsed) : EMPTY;
  } catch {
    // A corrupt queue is worse than none: it would fail forever and block every
    // action behind it. Losing it is bad, and being stuck is worse.
    return EMPTY;
  }
}

function save(box: Outbox): void {
  try { localStorage.setItem(KEY, JSON.stringify(box)); } catch { /* private mode, or full */ }
}

interface OutboxValue {
  /** Queue an action. Returns immediately; the UI should already have applied it. */
  send: (action: Omit<Action, 'queuedAt' | 'attempts'>) => void;
  pending: number;
  /** Subjects with something in flight — for marking rows as not-yet-saved. */
  inFlight: Set<string>;
  parked: Action[];
  retry: () => void;
  discard: (id: string) => void;
  online: boolean;
  /** Bumped every time the queue drains, so screens can reload from the server. */
  drained: number;
}

const OutboxContext = createContext<OutboxValue>({
  send: () => {}, pending: 0, inFlight: new Set(), parked: [],
  retry: () => {}, discard: () => {}, online: true, drained: 0,
});

export const useOutbox = (): OutboxValue => useContext(OutboxContext);

export function OutboxProvider({ children }: { children: ReactNode }) {
  const [box, setBox] = useState<Outbox>(load);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [drained, setDrained] = useState(0);
  // The queue is also read by the sending loop, which must never see a stale
  // copy — hence a ref alongside the state rather than state alone.
  const current = useRef(box);
  const sending = useRef(false);

  const update = useCallback((next: Outbox) => {
    current.current = next;
    save(next);
    setBox(next);
  }, []);

  const send = useCallback((action: Omit<Action, 'queuedAt' | 'attempts'>) => {
    update(enqueue(current.current, action));
  }, [update]);

  /**
   * Drains the queue, oldest first, stopping at the first action that has to
   * wait. Re-entrant by guard rather than by lock: the flush is triggered from
   * four places (a new action, coming online, a timer, the tab returning) and
   * two of them routinely fire together.
   */
  const flush = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      let action = head(current.current);
      while (action) {
        let outcome;
        try {
          const res = await fetch(`/api${action.path}`, {
            method: action.verb,
            headers: action.body ? { 'content-type': 'application/json' } : {},
            body: action.body ? JSON.stringify(action.body) : undefined,
            credentials: 'same-origin',
          });
          const text = await res.text().catch(() => '');
          let message = '';
          try { message = (JSON.parse(text) as { error?: string }).error ?? ''; } catch { /* not ours */ }
          outcome = classify(res.status, message);
        } catch {
          // The request never completed. Not a failure — the ordinary state of
          // a phone between two aisles.
          outcome = classify(0);
        }

        const next = resolve(current.current, action.id, outcome);
        update(next);

        if (outcome.kind === 'retry') break;   // wait for the timer; keep the order
        action = head(next);
      }
      if (pendingCount(current.current) === 0) setDrained((n) => n + 1);
    } finally {
      sending.current = false;
    }
  }, [update]);

  useEffect(() => {
    const wake = () => { setOnline(navigator.onLine); void flush(); };
    window.addEventListener('online', wake);
    window.addEventListener('offline', () => setOnline(false));
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });

    // The timer is the backstop, and the one that actually catches the walk out
    // of the shop: `online` fires when the interface reconnects, which is not
    // the same moment as when requests start succeeding.
    const timer = window.setInterval(() => {
      const next = head(current.current);
      if (next && Date.now() - next.queuedAt > backoffMs(next.attempts)) void flush();
    }, 3000);

    void flush();
    return () => {
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      window.clearInterval(timer);
    };
  }, [flush]);

  return (
    <OutboxContext.Provider value={{
      send,
      pending: pendingCount(box),
      inFlight: pendingSubjects(box),
      parked: box.actions.filter((a) => a.failure),
      retry: () => { update(retryAll(current.current)); void flush(); },
      discard: (id: string) => update(dropAction(current.current, id)),
      online,
      drained,
    }}>
      {children}
    </OutboxContext.Provider>
  );
}

/** A stable id for one tap. Not crypto; it only has to be unique on this phone. */
export function actionId(): string {
  try { return crypto.randomUUID(); } catch { /* older Safari */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Whether an error means "we are offline", for a screen deciding what to say. */
export const isOffline = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 0;
