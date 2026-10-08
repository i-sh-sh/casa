import type { ReactNode } from 'react';
import { Bar } from '../../ui/Bar.js';
import { formatILS } from '@shared/money.js';
import type { CashFlow } from '@shared/types.js';

/**
 * The month's one number, and under it the subtraction drawn.
 *
 * The bar is what came in, and the solid part is how much of it has already
 * gone. Two figures in a sentence say the same thing, but the eye reads «most
 * of it is gone» off a bar before it has finished reading the first number.
 * Spending past what came in fills the bar in red pencil, and the sentence
 * says so in words, because colour is never the only carrier.
 *
 * `wrap` lets the budget make each figure explainable without this component
 * knowing what a slip is.
 */
export function FlowHero({ flow, wrap = (_k, n) => n }: {
  flow: CashFlow;
  wrap?: (key: 'flow' | 'income' | 'spent', node: ReactNode) => ReactNode;
}) {
  const short = flow.monthly < 0;
  const left = Math.max(0, flow.income - flow.spent);

  return (
    <div className="hero">
      <div className="label">תזרים החודש</div>
      {wrap('flow', (
        <span className={`figure ${short ? 'over' : ''}`} style={{ display: 'block' }}>
          {formatILS(flow.monthly, { sign: true })}
        </span>
      ))}
      <Bar
        label={`הוצא ${formatILS(flow.spent)} מתוך ${formatILS(flow.income)} שנכנסו`}
        parts={short
          ? [{ value: flow.spent, tone: 'tone-red' }]
          : [{ value: flow.spent, tone: 'tone-1' }, { value: left, tone: 'tone-4' }]}
      />
      <div className="meta" style={{ display: 'flex', gap: 'var(--s3)' }}>
        <span style={{ flex: 1 }}>
          הוצא {wrap('spent', <span className="n">{formatILS(flow.spent)}</span>)}
        </span>
        <span>
          נכנס {wrap('income', <span className="n">{formatILS(flow.income)}</span>)}
        </span>
      </div>
      {short && (
        <div className="meta" style={{ marginTop: 'var(--s1)', color: 'var(--red)' }}>
          החודש יצא יותר ממה שנכנס
        </div>
      )}
    </div>
  );
}
