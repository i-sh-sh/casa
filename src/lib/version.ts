import { useEffect, useState } from 'react';
import { shouldUpdate, type VersionManifest } from '@shared/version.js';
import { isBusy } from '../ui/kit.js';

export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.1.0';

export interface VersionState {
  currentVersion: string;
  manifest: VersionManifest | null;
  stuck: boolean;
  reload: () => void;
}

let globalManifest: VersionManifest | null = null;
let globalStuck = false;
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of listeners) listener();
}

const MAX_ATTEMPTS = 2;
const attemptKey = (version: string) => `casa_update_attempts_${version}`;

/**
 * Counts a reload attempt against a target version, and refuses past the cap.
 *
 * The cap covers the soft path as well as the forced one, and that is the
 * whole point. A reload is only ever worth attempting if the page comes back
 * on a *newer* build; when it comes back on the same one — a deploy still in
 * flight, a CDN holding the old index.html, a service worker serving a stale
 * shell — an uncapped reload is an infinite loop that makes the phone unusable
 * and cannot be escaped from inside the app.
 */
function claimAttempt(version: string): boolean {
  let attempts = 0;
  try {
    attempts = Number(sessionStorage.getItem(attemptKey(version)) ?? 0) + 1;
    sessionStorage.setItem(attemptKey(version), String(attempts));
  } catch {
    return true; // private mode: no counter, so never blocked
  }
  return attempts <= MAX_ATTEMPTS;
}

async function clearCaches(): Promise<void> {
  if (!('caches' in window)) return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  } catch { /* the cache API is unavailable; a reload is still worth trying */ }
}

async function checkVersion() {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const manifest: VersionManifest = await res.json();
    if (!manifest || !manifest.version) return;

    globalManifest = manifest;
    const action = shouldUpdate(APP_VERSION, manifest);

    if (action === 'hard') {
      if (!claimAttempt(manifest.version)) {
        globalStuck = true;
        notifyListeners();
        return;
      }
      await clearCaches();
      window.location.reload();
      return;
    }

    if (action === 'soft') {
      // A soft update never interrupts. A newer build being live is not an
      // emergency; losing a half-typed transaction is. So it waits for a
      // moment when nothing is in flight and nobody is looking — in the common
      // case the household never sees an update happen at all.
      if (!isBusy() && document.hidden && claimAttempt(manifest.version)) {
        window.location.reload();
        return;
      }
    }

    notifyListeners();
  } catch {
    // Network or parse error: retry on next poll
  }
}

let isPolling = false;
function startPolling() {
  if (isPolling) return;
  isPolling = true;

  void checkVersion();
  // Never cleared: there is exactly one poller for the life of the document.
  setInterval(() => void checkVersion(), 60_000);

  const onFocus = () => void checkVersion();
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkVersion();
  });
}

export function useVersion(): VersionState {
  const [, setNonce] = useState(0);

  useEffect(() => {
    startPolling();
    const listener = () => setNonce((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  // The button in settings. A person pressing it is asking for this
  // deliberately, so the attempt counter is cleared first — otherwise a tab
  // that gave up once could never be told to try again.
  const forceReload = () => {
    if (globalManifest?.version) {
      try { sessionStorage.removeItem(attemptKey(globalManifest.version)); } catch { /* private mode */ }
    }
    void clearCaches().finally(() => window.location.reload());
  };

  return {
    currentVersion: APP_VERSION,
    manifest: globalManifest,
    stuck: globalStuck,
    reload: forceReload,
  };
}
