import { Link } from '../../lib/router.js';

const TABS = [
  { to: '/pantry', label: 'מזווה' },
  { to: '/meals', label: 'ארוחות' },
  { to: '/recipes', label: 'מתכונים' },
] as const;

/** Every path the «מטבח» tab in the bottom nav stands for. */
export const KITCHEN_PATHS = ['/pantry', '/meals', '/recipes'];

/**
 * What is on the shelves, what we will cook from them this week, and the
 * recipes we cook — one place with three pages, the way «כסף» is.
 *
 * Not a sixth tab in the bottom nav: five is what a thumb can hit without
 * looking, and dinner is a question about the pantry before it is anything
 * else (DESIGN.md §5ג).
 */
export function KitchenTabs() {
  return (
    <nav className="tabs money-tabs" aria-label="מטבח">
      {TABS.map((tab) => (
        <Link key={tab.to} to={tab.to} className="tab">{tab.label}</Link>
      ))}
    </nav>
  );
}
