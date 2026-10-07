import { query } from '../_lib/db.js';
import { nameKey } from '../../shared/budget-workbook.js';

/**
 * Remembers which category this payee was filed under.
 *
 * Every save is a decision about a payee, so every save teaches — the latest
 * decision wins, because a household that moves «ענק סטוק» from «ריהוט» to
 * «ניקיון» means it from now on. The rule only ever pre-fills the form or an
 * import row that has no «סעיף» of its own; it never re-files anything.
 */
export async function learnPayee(payee: string, categoryId: number | null): Promise<void> {
  const key = nameKey(payee);
  if (!key || categoryId == null) return;
  await query(
    `INSERT INTO payee_rules (payee_key, payee, category_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (household_id, payee_key)
     DO UPDATE SET payee = EXCLUDED.payee, category_id = EXCLUDED.category_id,
                   hits = payee_rules.hits + 1, updated_at = NOW()`,
    [key, payee, categoryId],
  );
}
