/**
 * The queue that makes the supermarket work.
 *
 * Reception inside a שופרסל is bad in a specific way: not off, but slow and
 * intermittent — a request leaves, the response never arrives, and the phone
 * has no idea whether the server acted. Everything here follows from that one
 * fact.
 *
 * **The dangerous case is not the failed request. It is the request that
 * succeeded and said nothing.** Retrying it must not do the thing twice, and in
 * this app "twice" means real damage: `addItem` bumps the quantity of a line
 * that already exists, so a blind retry turns two cartons of milk into four.
 * That is why every queued action carries a client-generated id the server
 * recognises, rather than being retried and hoped about.
 *
 * The second rule: **an action never disappears silently.** It is done, or it
 * is still queued, or it is parked with a reason a person can read. A tick that
 * vanishes on the way home is worse than no offline support at all, because the
 * list would then be wrong in a way nobody notices until the pantry is.
 */

export type Verb = 'POST' | 'PATCH' | 'DELETE';

export interface Action {
  /** Client-generated, stable across retries. This is what makes a replay safe. */
  id: string;
  verb: Verb;
  path: string;
  body?: Record<string, unknown>;
  /** For the UI: which list row this action is about, so it can be marked pending. */
  subject?: string;
  queuedAt: number;
  attempts: number;
  /** Set once the action has been parked; a sentence a person can act on. */
  failure?: string;
}

export interface Outbox {
  actions: Action[];
}

export const EMPTY: Outbox = { actions: [] };

/** Past this, the action is parked and shown rather than retried forever. */
export const MAX_ATTEMPTS = 6;

export function enqueue(box: Outbox, action: Omit<Action, 'queuedAt' | 'attempts'>): Outbox {
  // Replacing an action with the same id rather than appending: the UI can call
  // this twice for one tap (a re-render, a double press) and the second call
  // must not queue a second tick.
  const without = box.actions.filter((a) => a.id !== action.id);
  return { actions: [...without, { ...action, queuedAt: Date.now(), attempts: 0 }] };
}

/** The next action to send, oldest first. Order is preserved on purpose. */
export function head(box: Outbox): Action | null {
  return box.actions.find((a) => !a.failure) ?? null;
}

export const pendingCount = (box: Outbox): number => box.actions.filter((a) => !a.failure).length;
export const parked = (box: Outbox): Action[] => box.actions.filter((a) => a.failure);

/** Subjects with something still in flight, for marking rows in the list. */
export function pendingSubjects(box: Outbox): Set<string> {
  const out = new Set<string>();
  for (const a of box.actions) if (a.subject) out.add(a.subject);
  return out;
}

export type Outcome =
  | { kind: 'done' }
  | { kind: 'retry' }
  | { kind: 'park'; reason: string };

/**
 * What to do about a response, which is the whole correctness of this file.
 *
 * The judgements that are not obvious:
 *
 * **A 404 on `buy` means it already happened.** The handler matches
 * `status = 'open'`, so the second attempt finds nothing — which is exactly
 * what a successful first attempt leaves behind. Parking it would show a red
 * error for an item that is correctly bought and in the pantry.
 *
 * **401 is a retry, not a failure.** A session that expired in the aisle comes
 * back when the app refreshes it; discarding the tick would be the one
 * unrecoverable outcome.
 *
 * **4xx otherwise is parked, not retried.** A validation error will fail
 * identically forever, and a queue that retries it blocks every action behind
 * it — the whole list stuck because one line was malformed.
 */
export function classify(status: number, message = ''): Outcome {
  if (status >= 200 && status < 300) return { kind: 'done' };

  // No response at all: still offline, or the request died in the air. This is
  // the ordinary case in a supermarket and is not worth counting as a failure.
  if (status === 0) return { kind: 'retry' };

  if (status === 401) return { kind: 'retry' };

  if (status === 404) {
    // Only for the shapes where "gone" means "already applied". A 404 from a
    // path that does not exist is a bug, and parking it is how we find out.
    if (/לא נמצא ברשימה הפתוחה|לא נמצא ברשימה|already/i.test(message)) return { kind: 'done' };
    return { kind: 'park', reason: message || 'הפריט כבר לא קיים' };
  }

  if (status === 409) return { kind: 'done' };

  if (status >= 500) return { kind: 'retry' };

  return { kind: 'park', reason: message || `שגיאה ${status}` };
}

/** Applies an outcome to the queue. Returns a new outbox; never mutates. */
export function resolve(box: Outbox, id: string, outcome: Outcome): Outbox {
  if (outcome.kind === 'done') {
    return { actions: box.actions.filter((a) => a.id !== id) };
  }

  return {
    actions: box.actions.map((a) => {
      if (a.id !== id) return a;
      if (outcome.kind === 'park') return { ...a, failure: outcome.reason };
      const attempts = a.attempts + 1;
      // A retry that never succeeds still has to stop, or one broken action
      // silently blocks the queue behind it forever.
      return attempts >= MAX_ATTEMPTS
        ? { ...a, attempts, failure: 'לא הצלחנו לשלוח את הפעולה הזאת. בדקו את החיבור ונסו שוב.' }
        : { ...a, attempts };
    }),
  };
}

/** Removes a parked action — the person chose to give up on it. */
export function discard(box: Outbox, id: string): Outbox {
  return { actions: box.actions.filter((a) => a.id !== id) };
}

/** Puts every parked action back in the queue, from the top. */
export function retryAll(box: Outbox): Outbox {
  return { actions: box.actions.map((a) => ({ ...a, attempts: 0, failure: undefined })) };
}

/**
 * How long to wait before the next attempt.
 *
 * Backoff exists here for the walk out of the shop, not for server load: the
 * signal comes back all at once, and a queue hammering every 500ms in the
 * meantime is just battery. Capped low, because the moment reception returns
 * the person is usually still standing there.
 */
export function backoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** attempts, 30_000);
}

/**
 * Anything older than this is not worth sending.
 *
 * A tick from three days ago replayed into a list that has moved on does more
 * harm than the tick was worth. It is parked with a reason rather than dropped,
 * because a person should be told their shopping never saved.
 */
export const STALE_MS = 3 * 24 * 60 * 60 * 1000;

export function parkStale(box: Outbox, now = Date.now()): Outbox {
  return {
    actions: box.actions.map((a) =>
      !a.failure && now - a.queuedAt > STALE_MS
        ? { ...a, failure: 'הפעולה חיכתה יותר מדי זמן ולא נשלחה. בדקו את הרשימה.' }
        : a),
  };
}
