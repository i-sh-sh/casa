import { useState } from 'react';
import { api } from '../../lib/api.js';
import { AsyncForm, Field, Sheet } from '../../ui/kit.js';
import { formatILS } from '@shared/money.js';
import type { MatchHow } from '@shared/receipts.js';

interface PreviewLine {
  name: string;
  barcode: string | null;
  qty: number;
  total: number | null;
  product_id: number | null;
  how: MatchHow;
}

interface Preview {
  store: string;
  purchased_on: string;
  dated: boolean;
  total: number | null;
  warnings: string[];
  duplicate: boolean;
  lines: PreviewLine[];
  products: { id: number; name: string; unit: string }[];
  accounts: { id: number; name: string }[];
  categories: { id: number; name: string; group_name: string | null }[];
  suggested: { account_id: number | null; category_id: number | null };
}

/** `p:<id>` a product, `new` a product made from the line, `skip` not for the pantry. */
type Choice = string;

const HOW: Record<Exclude<MatchHow, null>, string> = {
  barcode: 'לפי ברקוד',
  learned: 'כמו בפעם הקודמת',
  name: 'לפי השם',
  ignored: 'סימנתם שלא למזווה',
};

/**
 * A supermarket receipt, pasted in: read, reviewed, applied.
 *
 * The review is the feature, not a formality. The parser reads layouts it has
 * never seen, so every line is shown with what it will become, and nothing is
 * written until the person agrees. What they answer is remembered, so the
 * second receipt from the same shop asks about almost nothing.
 */
export function ReceiptSheet({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);

  if (!preview) {
    return (
      <Sheet title="קבלה מהסופר" onClose={onClose}>
        <AsyncForm
          submitLabel="קריאת הקבלה"
          disabled={!text.trim()}
          onSubmit={async () => setPreview(await api.post<Preview>('/pantry/receipts/preview', { text }))}
        >
          <ol className="meta" style={{ margin: '0 0 var(--s4)', paddingInlineStart: '1.2em', lineHeight: 1.7 }}>
            <li>פותחים את הקישור מה-SMS של הסופר.</li>
            <li>לוחצים «הצגת עוד פריטים» עד שכל הפריטים מופיעים.</li>
            <li>מסמנים הכול, מעתיקים ומדביקים כאן.</li>
          </ol>
          <Field label="הקבלה">
            <textarea
              className="input"
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="מדביקים כאן את כל הטקסט של הקבלה"
              autoFocus
              style={{ fontFamily: 'inherit', resize: 'vertical' }}
            />
          </Field>
        </AsyncForm>
      </Sheet>
    );
  }

  return <ReviewStep preview={preview} onBack={() => setPreview(null)} onClose={onClose} onDone={onDone} />;
}

function ReviewStep({ preview, onBack, onClose, onDone }: {
  preview: Preview;
  onBack: () => void;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [store, setStore] = useState(preview.store);
  const [purchasedOn, setPurchasedOn] = useState(preview.purchased_on);
  const [total, setTotal] = useState(preview.total != null ? String(preview.total) : '');
  // An unknown line starts as «not for the pantry»: guessing «new product»
  // would fill the pantry with «חלב תנובה 3% 1ל» on the first receipt.
  const [choices, setChoices] = useState<Choice[]>(
    preview.lines.map((l) => (l.product_id != null ? `p:${l.product_id}` : 'skip')),
  );
  const [record, setRecord] = useState(preview.accounts.length > 0 && !preview.duplicate);
  const [accountId, setAccountId] = useState(preview.suggested.account_id ?? preview.accounts[0]?.id ?? 0);
  const [categoryId, setCategoryId] = useState<number | ''>(preview.suggested.category_id ?? '');

  const unknown = preview.lines.filter((l, i) => l.how === null && choices[i] === 'skip').length;
  const toPantry = choices.filter((c) => c !== 'skip').length;

  const setChoice = (i: number, value: Choice) => setChoices((prev) => prev.map((c, j) => (j === i ? value : c)));

  return (
    <Sheet title={store ? `קבלה · ${store}` : 'קבלה'} onClose={onClose}>
      <AsyncForm
        submitLabel={toPantry ? `עדכון: ${toPantry} פריטים למזווה` : 'שמירת הקבלה'}
        onSubmit={async () => {
          const res = await api.post<{ stocked: number; cleared: number; transaction_id: number | null }>('/pantry/receipts', {
            store, purchased_on: purchasedOn,
            total: total ? Number(total) : null,
            record_expense: record,
            account_id: record ? accountId : undefined,
            category_id: record && categoryId !== '' ? categoryId : undefined,
            lines: preview.lines.map((l, i) => {
              const c = choices[i]!;
              return {
                name: l.name, barcode: l.barcode, qty: l.qty, total: l.total,
                action: c === 'skip' ? 'skip' : c === 'new' ? 'new' : 'product',
                product_id: c.startsWith('p:') ? Number(c.slice(2)) : undefined,
              };
            }),
          });
          const parts = [
            res.stocked ? `${res.stocked} נכנסו למזווה` : null,
            res.cleared ? `${res.cleared} ירדו מהרשימה` : null,
            res.transaction_id ? 'ההוצאה נרשמה' : null,
          ].filter(Boolean);
          onDone(parts.length ? parts.join(' · ') : 'הקבלה נשמרה');
        }}
      >
        {preview.duplicate && (
          <p className="mark mark-red" style={{ display: 'block', marginBottom: 'var(--s3)' }}>
            נראה שהקבלה הזאת כבר נקלטה.
          </p>
        )}
        {preview.warnings.map((w) => (
          <p key={w} className="meta" style={{ marginBottom: 'var(--s2)' }}>{w}</p>
        ))}

        <div className="row-2">
          <Field label="חנות">
            <input className="input" value={store} onChange={(e) => setStore(e.target.value)} placeholder="רמי לוי" />
          </Field>
          <Field label={preview.dated ? 'תאריך' : 'תאריך · לא מצאתי בקבלה'}>
            <input className="input" type="date" value={purchasedOn} onChange={(e) => setPurchasedOn(e.target.value)} />
          </Field>
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--s3)', margin: 'var(--s4) 0 var(--s2)' }}>
          <h3 style={{ flex: 1, margin: 0 }}>פריטים <span className="n">{preview.lines.length}</span></h3>
          {unknown > 0 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setChoices((prev) => prev.map((c, i) => (preview.lines[i]!.how === null && c === 'skip' ? 'new' : c)))}
            >
              {unknown} לא מוכרים · כולם מוצרים חדשים
            </button>
          )}
        </div>

        <div className="rows" style={{ marginBottom: 'var(--s4)' }}>
          {preview.lines.map((line, i) => (
            <div className="row" key={i} style={{ flexWrap: 'wrap', rowGap: 'var(--s2)' }}>
              <div style={{ flex: '1 1 100%', minWidth: 0 }}>
                <span className="title" style={{ display: 'block' }}>{line.name}</span>
                <span className="meta">
                  <span className="n">{line.qty}</span>
                  {line.total != null && <> · <span className="n">{formatILS(line.total, { agorot: true })}</span></>}
                  {line.how && line.how !== 'ignored' && choices[i] === `p:${line.product_id}` && <> · {HOW[line.how]}</>}
                </span>
              </div>
              <select
                className="select"
                style={{ flex: '1 1 100%' }}
                value={choices[i]}
                onChange={(e) => setChoice(i, e.target.value)}
                aria-label={`מה זה ${line.name}`}
              >
                <option value="skip">לא למזווה</option>
                <option value="new">מוצר חדש: {line.name}</option>
                {preview.products.map((p) => <option key={p.id} value={`p:${p.id}`}>{p.name}</option>)}
              </select>
            </div>
          ))}
        </div>

        {preview.accounts.length > 0 && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--s2)', marginBottom: 'var(--s3)' }}>
              <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} />
              <span>לרשום הוצאה בתקציב</span>
            </label>
            {record && (
              <>
                <div className="row-2">
                  <Field label="סכום · ₪">
                    <input className="input" type="number" inputMode="decimal" min="0" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} />
                  </Field>
                  <Field label="חשבון">
                    <select className="select" value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
                      {preview.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </Field>
                </div>
                <Field label="קטגוריה">
                  <select className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : '')}>
                    <option value="">בלי קטגוריה</option>
                    {preview.categories.map((c) => <option key={c.id} value={c.id}>{c.group_name ? `${c.group_name} · ${c.name}` : c.name}</option>)}
                  </select>
                </Field>
                <p className="meta" style={{ marginBottom: 'var(--s4)' }}>
                  כשתייבאו את דוח האשראי, החיוב הזה יזוהה ולא יירשם פעמיים.
                </p>
              </>
            )}
          </>
        )}
      </AsyncForm>
      <button type="button" className="btn btn-quiet btn-block" style={{ marginTop: 'var(--s2)' }} onClick={onBack}>
        חזרה להדבקה
      </button>
    </Sheet>
  );
}
