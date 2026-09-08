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

async function checkVersion() {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const manifest: VersionManifest = await res.json();
    if (!manifest || !manifest.version) return;

    globalManifest = manifest;
    const action = shouldUpdate(APP_VERSION, manifest);

    if (action === 'hard') {
      const storageKey = `casa_update_attempts_${manifest.version}`;
      const attempts = Number(sessionStorage.getItem(storageKey) ?? 0) + 1;
      sessionStorage.setItem(storageKey, String(attempts));

      if (attempts > 2) {
        globalStuck = true;
        notifyListeners();
        return;
      }

      // Hard reload attempt: clear caches and reload immediately
      if ('caches' in window) {
        try {
          const keys = await caches.keys();
          await Promise.all(keys.map((key) => caches.delete(key)));
        } catch { /* ignore */ }
      }
      window.location.reload();
      return;
    }

    if (action === 'soft') {
      if (!isBusy()) {
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
  const interval = setInterval(() => void checkVersion(), 60_000);

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

  const forceReload = () => {
    if (globalManifest?.version) {
      sessionStorage.removeItem(`casa_update_attempts_${globalManifest.version}`);
    }
    if ('caches' in window) {
      caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))).finally(() => {
        window.location.reload();
      });
    } else {
      window.location.reload();
    }
  };

  return {
    currentVersion: APP_VERSION,
    manifest: globalManifest,
    stuck: globalStuck,
    reload: forceReload,
  };
}
