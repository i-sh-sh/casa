/**
 * Setting up a home: the four things that turn the furnished defaults into
 * this household's own.
 *
 * A new home arrives with categories, two accounts and a pantry list (see
 * api/admin/_seed.ts), so every screen has something on it. None of it is
 * theirs yet: no card to hang a purchase on, no budget, a pantry that does not
 * know what is in the cupboard, one person where the app is built for two.
 *
 * The steps are derived from the data, never stored. A step is done when the
 * thing exists, however it came to exist — added from the checklist, from
 * settings, or by an Excel import — so there is no flag to drift out of step
 * with what the home actually has. The same function reads the operator's
 * counts, so «2/4» on the admin screen is the checklist the couple sees.
 */

export interface SetupFacts {
  /** Open credit-card accounts. Most of a household's spending goes through one. */
  credit_accounts: number;
  /** Allocations in the current month: the budget exists. */
  allocations: number;
  /** Stock entries with something in them: the pantry starts from what is there. */
  stocked: number;
  /** Products with a minimum: the household said what it buys regularly. */
  tracked: number;
  /** People in the home, not counting pending ones. */
  members: number;
  /** Open invites: the partner was asked, and the step is waiting on them. */
  invites: number;
}

export type SetupStepKey = 'card' | 'budget' | 'pantry' | 'partner';

export interface SetupStep {
  key: SetupStepKey;
  label: string;
  done: boolean;
  /** One sentence on what is missing, or why it is already done. */
  status: string;
}

export function setupSteps(f: SetupFacts): SetupStep[] {
  return [
    {
      key: 'card',
      label: 'כרטיס האשראי',
      done: f.credit_accounts > 0,
      status: f.credit_accounts > 0 ? 'נוסף' : 'כדי שהוצאות באשראי יירשמו לחשבון הנכון',
    },
    {
      key: 'budget',
      label: 'התקציב של החודש',
      done: f.allocations > 0,
      status: f.allocations > 0 ? `${f.allocations} סעיפים קיבלו סכום` : 'כמה מותר להוציא על כל סעיף, או ייבוא מהאקסל',
    },
    {
      key: 'pantry',
      label: 'מה יש בבית',
      done: f.stocked > 0 || f.tracked > 0,
      status: f.stocked > 0 || f.tracked > 0
        ? 'המזווה יודע מה קונים קבוע'
        : 'מה קונים באופן קבוע ומה יש עכשיו, כדי שרשימת הקניות תתחיל מהמציאות',
    },
    {
      key: 'partner',
      label: 'בן או בת הזוג',
      done: f.members > 1,
      status: f.members > 1 ? 'הצטרפו' : f.invites > 0 ? 'ההזמנה נשלחה, עוד לא הצטרפו' : 'קישור הזמנה אחד',
    },
  ];
}

export function setupDone(steps: SetupStep[]): number {
  return steps.filter((s) => s.done).length;
}

/** Which week since the home opened, counting the first as 0. */
export function weekIndex(openedAt: string, now: Date = new Date()): number {
  const days = Math.floor((now.getTime() - new Date(openedAt).getTime()) / 86_400_000);
  return Math.max(0, Math.floor(days / 7));
}

/** How many weeks the operator screen tracks per home: the pilot is six. */
export const TRACKED_WEEKS = 6;
