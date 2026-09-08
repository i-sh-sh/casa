import { useEffect, useState } from 'react';
import { decideUpdate, type UpdateDecision, type VersionManifest } from '@shared/version.js';

/**
 * The update runtime: poll the manifest, and act on what it says.
 *
 * Two rules shape everything here.
 *
 * **A soft update never interrupts.** A newer build being live is not an
 * emergency; losing a half-typed transaction is. So the reload waits for a
 * moment when the tab is hidden or nobody is mid-action, and in the common
 * case the household never sees an update happen at all.
 *
 * **A forced update gives up rather than loops.** A tab that reloads for a
 * mandatory release expects to come back on the new build. If it comes back
 * still old — a half-finished deploy, a proxy serving stale HTML, a manifest
 * that got ahead of the assets — the naive version reloads forever and bricks
 * the device. Attempts are counted per target version and capped.
 */

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

const MANIFEST_URL = '/version.json';
const POLL_MS = 60_000;
const RELOAD_LIMIT = 2;

/**
 * Set while something is mid-flight that a reload would destroy: an open
 * sheet, a form being submitted, a shopping tick still in the air.
 *
 * A module-level counter rather than React state on purpose — it is read by a
 * timer that must not re-render anything, and several things can be busy at
 * once.
 */
let busyCount = 0;

export function markBusy(): () => void {
  busyCount++;
  let released = false;
  return () => {
    if (released) return; // a cleanup that runs twice must not free someone else's claim
    released = true;
    busyCount = Math.max(0, busyCount - 1);
  };
}

export const isBusy = (): boolean => busyCount > 0;

async function fetchManifest(): Promise<VersionManifest | null> {
  try {
    // Cache-busted explicitly. A CDN holding the old manifest for five minutes
    // would silently defeat the entire mechanism, and `cache: 'no-store'`
    // alone is not honoured everywhere.
    const res = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as VersionManifest;
  } catch {
    // Offline, or the file did not ship. Either way there is nothing to do
    // and nothing worth telling anyone.
    return null;
  }
}

function attemptsFor(version: string): number {
  try {
    return parseInt(sessionStorage.getItem(`casa.update.${version}`) ?? '0', 10) || 0;
  } catch {
    return 0; // private mode: fall back to always trying
  }
}

function noteAttempt(version: string): void {
  try {
    sessionStorage.setItem(`casa.update.${version}`, String(attemptsFor(version) + 1));
  } catch { /* nothing to do */ }
}

/** Wipes any cached copy of the old build before reloading. */
async function hardReload(): Promise<void> {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch { /* cache API unavailable — a reload is still worth trying */ }
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    await Promise.all((regs ?? []).map((r) => r.update().catch(() => {})));
  } catch { /* same */ }
  location.reload();
}

export interface VersionState extends UpdateDecision {
  current: string;
  /** The forced reload was tried twice and came back old. Stop, and say so. */
  stuck: boolean;
}

/**
 * One poller for the whole app, however many components ask.
 *
 * The hook is used in two places — the shell, which needs to know when to
 * block, and the settings card, which shows the two numbers. Two independent
 * pollers would double the network traffic and, far worse, double-increment
 * the forced-reload counter: the cap of two attempts would then be spent on a
 * single real attempt, and the app would declare itself stuck on the first try.
 */
let shared: VersionState = {
  current: APP_VERSION, latest: null, released: null, notes: [],
  behind: false, mandatory: false, stuck: false,
};
const listeners = new Set<(s: VersionState) => void>();
let started = false;

function publish(next: VersionState): void {
  shared = next;
  for (const listener of listeners) listener(next);
}

async function poll(): Promise<void> {
  const manifest = await fetchManifest();
  if (!manifest) return;
  const decision = decideUpdate(APP_VERSION, manifest);
  const stuck = decision.mandatory && !!decision.latest && attemptsFor(decision.latest) >= RELOAD_LIMIT;
  publish({ current: APP_VERSION, ...decision, stuck });

  if (decision.mandatory && decision.latest && !stuck) {
    noteAttempt(decision.latest);
    void hardReload();
  }
}

function startOnce(): void {
  if (started) return;
  started = true;

  void poll();
  window.setInterval(() => void poll(), POLL_MS);
  // A tab returning to the foreground is the cheapest moment to notice a
  // release — and the most likely, since a phone spends its life hidden.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void poll();
  });

  // The soft path: reload at the first moment nothing is in flight. It runs
  // forever rather than being armed on demand, because "not busy" is a
  // condition that arrives on its own schedule.
  window.setInterval(() => {
    if (!shared.behind || shared.mandatory) return;
    if (document.hidden || isBusy()) return;
    location.reload();
  }, 4000);
}

export function useVersionCheck(): VersionState {
  const [state, setState] = useState<VersionState>(shared);

  useEffect(() => {
    startOnce();
    listeners.add(setState);
    setState(shared);
    return () => { listeners.delete(setState); };
  }, []);

  return state;
}
