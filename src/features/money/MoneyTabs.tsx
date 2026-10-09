import { useState } from 'react';
import { Link } from '../../lib/router.js';
import { monthKey } from '@shared/money.js';

const TABS = [
  { to: '/budget', label: 'תקציב' },
  { to: '/transactions', label: 'תנועות' },
  { to: '/accounts', label: 'חשבונות' },
] as const;

/** Every path the «כסף» tab in the bottom nav stands for. */
export const MONEY_PATHS = ['/budget', '/transactions', '/accounts'];

/**
 * The three money screens, as one place with three pages.
 *
 * They used to be three addresses that pointed at each other: a «תנועות» button
 * in the budget's masthead, a «תקציב» button in the transactions', and the
 * accounts buried at the top of settings between the theme and the version. The
 * question «how much do we have» lived in the screen for choosing dark mode.
 *
 * Finance apps that are used daily settled on this shape long ago — one money
 * tab, its views side by side — because the next question after «what is left
 * in the envelope» is nearly always «what did we spend it on». Tab stops on a
 * ruled line, like the pantry's filters, not a segmented pill.
 */
export function MoneyTabs() {
  return (
    <nav className="tabs money-tabs" aria-label="כסף">
      {TABS.map((tab) => (
        <Link key={tab.to} to={tab.to} className="tab">{tab.label}</Link>
      ))}
    </nav>
  );
}

const MONTH_KEY = 'casa-money-month';

/**
 * The month the money screens are looking at, shared between them.
 *
 * Stepping back to September in the budget and then opening the transactions
 * to see why used to land on October — the question asked about one month and
 * answered about another. Per tab session rather than stored: a new visit
 * starts at this month, which is the one people open it for.
 */
export function useMoneyMonth(): [string, (month: string) => void] {
  const [month, setMonth] = useState(() => {
    try { return sessionStorage.getItem(MONTH_KEY) ?? monthKey(new Date()); } catch { return monthKey(new Date()); }
  });
  const change = (next: string) => {
    setMonth(next);
    try { sessionStorage.setItem(MONTH_KEY, next); } catch { /* private mode: the month just will not carry over */ }
  };
  return [month, change];
}
