import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { AsyncForm, Field, Sheet } from '../../ui/kit.js';
import { formatILS } from '@shared/money.js';
import { receiptLink, type MatchHow } from '@shared/receipts.js';

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
export function ReceiptSheet({ onClose, onDone, initialText = null }: {
  onClose: () => void;
  onDone: (message: string) => void;
  /** Text shared from another app: read at once, with no paste step. */
  initialText?: string | null;
}) {
  const [text, setText] = useState(initialText ?? '');
  const [preview, setPreview] = useState<Preview | null>(null);

  const form = useRef<HTMLDivElement>(null);

  /**
   * A link is opened here, in the browser, first: that is where the chain
   * expects its receipt to be opened, and it is what lets the whole thing be
   * «paste the SMS» instead of «open, expand, select, copy, paste». If the
   * browser is refused, the server tries the same link.
   */
  async function read(input: string) {
    let payload = input;
    const link = receiptLink(input);
    if (link) {
      try {
        const res = await fetch(link.data, { headers: { accept: 'application/json' } });
        if (res.ok) payload = await res.text();
      } catch {
        // Refused by the browser; the server tries next.
      }
    }
    setPreview(await api.post<Preview>('/pantry/receipts/preview', { text: payload }));
  }

  useEffect(() => {
    if (initialText?.trim()) form.current?.querySelector('form')?.requestSubmit();
  }, []);

  async function pasteAndRead() {
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) return;
      setText(clip);
      // Submitting through the form keeps one place that shows the error.
      setTimeout(() => form.current?.querySelector('form')?.requestSubmit(), 0);
    } catch {
      // No clipboard permission: the field below still takes a paste.
    }
  }

  if (!preview) {
    const hasLink = receiptLink(text) != null;
    return (
      <Sheet title="קבלה מהסופר" onClose={onClose}>
        <p className="meta" style={{ marginBottom: 'var(--s3)' }}>
          בעמוד הקבלה: «הצגת עוד פריטים», בחירת הכול ואז «שיתוף» לקאסה. או מעתיקים ומדביקים כאן.
        </p>
        <button type="button" className="btn btn-primary btn-block" style={{ marginBottom: 'var(--s4)' }} onClick={() => void pasteAndRead()}>
          הדבקה וקריאה
        </button>
        <div ref={form}>
          <AsyncForm submitLabel={hasLink ? 'פתיחת הקבלה מהקישור' : 'קריאת הקבלה'} disabled={!text.trim()} onSubmit={() => read(text)}>
            <Field label="או מדביקים כאן">
              <textarea
                className="input"
                rows={4}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="https://digi.rami-levy.co.il/…"
                style={{ fontFamily: 'inherit', resize: 'vertical' }}
              />
            </Field>
          </AsyncForm>
        </div>
        <p className="meta" style={{ marginTop: 'var(--s3)' }}>
          אפשר גם להדביק את כל הטקסט של הקבלה, אחרי «הצגת עוד פריטים».
        </p>
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
