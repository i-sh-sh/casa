import { Icon } from './Icon.js';
import { nextMonth, previousMonth } from '@shared/money.js';

const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

/** «אוקטובר», or «אוקטובר 2025» once it is not this year. */
export function monthLabel(month: string): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const name = MONTHS[m - 1] ?? month;
  return year === new Date().getFullYear() ? name : `${name} ${year}`;
}

/**
 * The one way to move between months, on every screen that has them.
 *
 * It replaced a native month input, which the browser renders in its own
 * locale — «October 2026» in the middle of a Hebrew page — and which opens a
 * calendar to pick what is nearly always the month before.
 *
 * Back is on the right, because in a right-to-left page the past is behind
 * the reader's right shoulder.
 */
export function MonthStepper({ month, onChange, disabled }: {
  month: string; onChange: (month: string) => void; disabled?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s2)', borderBottom: '1px solid var(--rule)' }}>
      <button className="btn btn-quiet" disabled={disabled} onClick={() => onChange(previousMonth(month))} aria-label="החודש הקודם" style={{ transform: 'scaleX(-1)' }}>
        <Icon name="back" size={18} />
      </button>
      <div style={{ flex: 1, textAlign: 'center', fontWeight: 700 }}>{monthLabel(month)}</div>
      <button className="btn btn-quiet" disabled={disabled} onClick={() => onChange(nextMonth(month))} aria-label="החודש הבא">
        <Icon name="back" size={18} />
      </button>
    </div>
  );
}
