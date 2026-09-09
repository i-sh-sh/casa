const CACHE_NAME = 'casa-v0.3.8';

/**
 * The supermarket service worker.
 *
 * It exists for one place: a שופרסל with two bars of signal, where the list has
 * to open and the ticks have to stick. Writes are not its job — they queue in
 * the page (shared/outbox.ts) — so everything here is about *reading* when the
 * network will not answer.
 *
 * Three rules, each of which the previous version broke:
 *
 * **Cache what you intend to serve.** The old version fell back to
 * `caches.match` on failure but never put anything in, so the fallback always
 * missed and offline meant a blank screen. A network-first cache that never
 * writes is not a cache.
 *
 * **`respondWith` needs a Response.** `caches.match` resolves to `undefined` on
 * a miss, and passing that through produces a TypeError and the browser's own
 * error page — worse than an honest offline message, because it looks like the
 * site is broken.
 *
 * **Only the shopping list is cached, never the money.** A cached API response
 * sits in Cache Storage until something evicts it, on a phone that may be
 * handed to somebody. The list is worth that; a budget is not. The allowlist
 * below is the whole policy, and it is short on purpose.
 */

const SHELL = '/index.html';

// The only API responses worth surviving the network, and the only ones whose
// contents we are willing to leave on the device.
const CACHEABLE_API = [
  '/api/shopping/items',
  '/api/pantry/products',
];

const isCacheableApi = (url) =>
  CACHEABLE_API.some((path) => url.pathname === path);

// Pages that are not the app: the guide, and the two Google requires before an
// app may leave "Testing". A navigation to one of these must never be answered
// with the app's shell — somebody arriving at /privacy from a consent screen
// has to be shown the policy, not a cached sign-in page.
const STANDALONE = new Set([
  '/guide', '/guide.html',
  '/privacy', '/privacy.html',
  '/terms', '/terms.html',
  '/legal.css',
]);

self.addEventListener('install', (event) => {
  // The shell is fetched at install so that the very first offline navigation
  // works, rather than the second.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.add(new Request(SHELL, { cache: 'reload' })))
      .catch(() => { /* offline at install: the runtime cache will pick it up */ })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

/**
 * Signing out has to take the cached list with it.
 *
 * Otherwise the next person to open the app on that phone — a flatmate, a
 * partner in a different household, whoever the device gets handed to — is
 * shown the previous household's shopping list before any request is made.
 */
self.addEventListener('message', (event) => {
  if (event.data === 'casa:forget') {
    event.waitUntil(caches.delete(CACHE_NAME).then(() => caches.open(CACHE_NAME)));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
  }
  return response;
}

/** Network wins when it answers; the cache is what makes the aisle work. */
async function networkFirst(request, { store }) {
  try {
    const response = await fetch(request);
    if (store && response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function navigate(request) {
  try {
    return await fetch(request);
  } catch (err) {
    // Any route in this app renders from the same shell, so a cached shell
    // answers every navigation — not only the one that was cached.
    const shell = await caches.match(SHELL);
    if (shell) return shell;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET' || !url.protocol.startsWith('http')) return;
  // Another origin's response is not ours to keep, and Google's sign-in script
  // in particular must never come from a cache.
  if (url.origin !== self.location.origin) return;

  if (STANDALONE.has(url.pathname)) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(navigate(event.request));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    // Everything not on the allowlist is left alone entirely: no cache read, no
    // cache write, no interception. The money never touches this file.
    if (isCacheableApi(url)) {
      event.respondWith(networkFirst(event.request, { store: true }));
    }
    return;
  }

  // Hashed filenames, so a hit is always correct and never stale.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  event.respondWith(networkFirst(event.request, { store: true }));
});
