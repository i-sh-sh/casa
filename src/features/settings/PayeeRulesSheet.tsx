import { useState } from 'react';
import { api } from '../../lib/api.js';
import { ErrorNote, Loading, Sheet, useAsync } from '../../ui/kit.js';
import type { Category } from '@shared/types.js';

interface Rule { id: number; payee: string; hits: number; category_id: number; category_name: string }

/**
 * The payees the app has learned, and where each one files.
 *
 * Every save teaches a rule, and a rule pre-fills every later row from that
 * payee — in the form and in a card import. A wrong one used to keep filing
 * wrong, quietly, with nowhere to see why. Here it is a row like any other:
 * tap it, pick the right category or forget it.
 *
 * Nothing already recorded moves. The rule only decides what is suggested
 * next time, and the sheet says so once, at the top.
 */
export function PayeeRulesSheet({ onClose }: { onClose: () => void }) {
  const rules = useAsync(() => api.get<Rule[]>('/money/payee-rules'));
  const categories = useAsync(() => api.get<Category[]>('/money/categories'));
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const usable = (categories.data ?? []).filter((c) => !c.archived_at);
  const list = [...(rules.data ?? [])].sort((a, b) => a.payee.localeCompare(b.payee, 'he'));

  const change = async (rule: Rule, categoryId: number) => {
    setError(null);
    try {
      await api.patch(`/money/payee-rules/${rule.id}`, { category_id: categoryId });
      setOpen(null);
      rules.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'השמירה נכשלה');
    }
  };

  const forget = async (rule: Rule) => {
    setError(null);
    try {
      await api.del(`/money/payee-rules/${rule.id}`);
      setOpen(null);
      rules.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'המחיקה נכשלה');
    }
  };

  return (
    <Sheet title="בתי עסק שזוהו" onClose={onClose}>
      <p className="meta" style={{ marginBottom: 'var(--s3)' }}>
        כל בית עסק שסיווגתם פעם מוצע בפעם הבאה באותו סעיף. שינוי כאן משפיע על ההצעות מעכשיו, לא על תנועות שכבר נרשמו.
      </p>
      {error && <ErrorNote message={error} />}
      {(rules.loading || categories.loading) && !rules.data && <Loading />}
      {rules.error && <ErrorNote message={rules.error} onRetry={rules.reload} />}
      {rules.data && list.length === 0 && (
        <p className="meta">עוד אין. בית עסק נלמד בפעם הראשונה שתנועה ממנו נשמרת עם סעיף.</p>
      )}
      <div className="rows">
        {list.map((r) => (
          <div key={r.id} style={{ borderBottom: '1px solid var(--rule)' }}>
            <button
              type="button"
              className="row"
              style={{ minHeight: 56, borderBottom: 0 }}
              onClick={() => setOpen(open === r.id ? null : r.id)}
              aria-expanded={open === r.id}
            >
              <span className="grow" style={{ textAlign: 'start' }}>
                <span className="title" style={{ display: 'block' }}>{r.payee}</span>
                <span className="meta">{r.category_name}</span>
              </span>
              <span className="meta"><span className="n">{r.hits}</span> פעמים</span>
            </button>
            {open === r.id && (
              <div style={{ paddingBottom: 'var(--s4)' }}>
                <label className="field">
                  <span>לאיזה סעיף</span>
                  <select
                    className="select"
                    value={r.category_id}
                    onChange={(e) => void change(r, Number(e.target.value))}
                  >
                    {usable.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}{c.group_name ? ` · ${c.group_name}` : ''}</option>
                    ))}
                  </select>
                </label>
                <button type="button" className="btn btn-red btn-block" onClick={() => void forget(r)}>
                  לשכוח את בית העסק
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Sheet>
  );
}
