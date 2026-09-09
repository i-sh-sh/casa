import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * Register the service worker — which until now was never registered at all.
 *
 * `public/sw.js` has shipped since the versioning work and has never run: the
 * release tool stamped its CACHE_NAME every release, the tests asserted that
 * stamp, and nothing ever called `register`. The whole of offline support was
 * a file nobody loaded.
 *
 * After load, not during it: registration competes with the first render for
 * the same connection, and the first paint matters more than the second visit.
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // A refused registration is not a broken app — it is an app without
      // offline support, which is how it worked until today.
      console.warn('service worker registration failed', err);
    });
  });
}
