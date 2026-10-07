import { Fragment, useState, type ReactNode } from 'react';
import { api } from '../../lib/api.js';
import { Link } from '../../lib/router.js';
import { AsyncForm, ErrorNote, Field, useAsync } from '../../ui/kit.js';
import { TopBar } from '../../ui/TopBar.js';
import { formatILS, monthKey } from '@shared/money.js';
import { readXlsx } from '@shared/xlsx.js';
import { MONTHS, parseBudgetWorkbook, type ImportSummary, type ParsedBudget } from '@shared/budget-workbook.js';
import type { Account } from '@shared/types.js';

const monthLabel = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1] ?? ''} ${month.slice(0, 4)}`;

/**
 * The household's budget workbook, out and back in.
 *
 * The file is the template they already manage the month in (see
 * shared/budget-workbook.ts). Export is a plain link, like every export in
 * settings. Import reads the file here in the browser, then asks the server
 * what it would do — and shows that, in words, before anything is written.
 * The same server call with `apply` is the import; there is no separate path
 * that could disagree with the preview.
 */
export function WorkbookScreen() {
  const [month, setMonth] = useState(() => monthKey(new Date()));

  return (
    <>
      <TopBar
        title="אקסל"
        subtitle="התבנית החודשית שלכם"
        action={<Link to="/budget" className="btn btn-sm">תקציב</Link>}
      />
      <div className="page">
        <section className="section">
          <h2>ייצוא</h2>
          <Field label="חודש">
            <input
              className="input"
              type="month"
              value={month.slice(0, 7)}
              onChange={(e) => setMonth(e.target.value ? `${e.target.value}-01` : month)}
            />
          </Field>
          <a className="btn btn-primary btn-block" href={`/api/money/workbook?month=${month}`}>
            הורדת {monthLabel(month)}
          </a>
          <p className="meta" style={{ marginTop: 'var(--s2)' }}>
            שישה גיליונות, באותם שמות כמו באקסל שלכם: שיקוף מצב, תקציב חודשי, תקציב שנתי,
            בקרה חודשית, עסקאות החודש ומעקב שנתי. הסכומים הם מה שנרשם כאן; הממוצעים,
            המצטברים והיתרות הם נוסחאות של האקסל.
          </p>
        </section>

        <ImportSection />
      </div>
    </>
  );
}

function ImportSection() {
  const accounts = useAsync(() => api.get<Account[]>('/money/accounts'));
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedBudget | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const openAccounts = (accounts.data ?? []).filter((a) => !a.archived_at);

  const ask = (p: ParsedBudget, m: string | null, account: number | null, apply: boolean) =>
    api.post<ImportSummary>('/money/workbook/import', { parsed: p, month: m, account_id: account, apply });

  const choose = async (file: File | undefined) => {
    setError(null);
    setPreview(null);
    setParsed(null);
    if (!file) return;
    setFileName(file.name);
    setReading(true);
    try {
      const p = parseBudgetWorkbook(await readXlsx(new Uint8Array(await file.arrayBuffer())));
      if (!p.lines.length && !p.transactions.length) {
        throw new Error('לא מצאתי בקובץ גיליון «בקרה חודשית» או גיליון עסקאות עם עמודת «סעיף». זה הקובץ הנכון?');
      }
      const m = p.month ?? monthKey(new Date());
      setParsed(p);
      setMonth(m);
      setPreview(await ask(p, m, accountId, false));
    } catch (err) {
      // A file that is not a zip at all says so in English from deep inside
      // the reader; what a person needs is which file, and what was expected.
      const message = err instanceof Error ? err.message : '';
      setError(/zip|xlsx/i.test(message) ? 'הקובץ הזה אינו קובץ אקסל (xlsx).' : message || 'לא הצלחתי לקרוא את הקובץ.');
    } finally {
      setReading(false);
    }
  };

  const refresh = async (m: string | null, account: number | null) => {
    if (!parsed) return;
    setError(null);
    try {
      setPreview(await ask(parsed, m, account, false));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'משהו השתבש');
    }
  };

  const nothing = preview && !preview.applied
    && !preview.new_categories.length && !preview.allocations && !preview.transactions
    && !preview.adjustments.length && !preview.retire && !preview.commitments;

  return (
    <section className="section">
      <h2>ייבוא</h2>
      <p className="meta" style={{ marginBottom: 'var(--s3)' }}>
        נקרא מהקובץ הגיליון «בקרה חודשית» (סעיפים, תקציב ובפועל) וגיליון העסקאות. לפני
        שנכתב משהו תראו מה ייווסף. ייבוא חוזר של אותו קובץ לא מכפיל כלום.
      </p>

      <label className="btn btn-block" style={{ position: 'relative' }}>
        {reading ? 'קורא…' : fileName ? `קובץ אחר במקום ${fileName}` : 'בחירת קובץ אקסל'}
        <input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
          onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ''; }}
        />
      </label>

      {error && <div style={{ marginTop: 'var(--s3)' }}><ErrorNote message={error} /></div>}

      {parsed && preview && (
        <div style={{ marginTop: 'var(--s4)' }}>
          <Field label="החודש שבקובץ">
            <input
              className="input"
              type="month"
              value={(month ?? '').slice(0, 7)}
              disabled={preview.applied}
              onChange={(e) => {
                const m = e.target.value ? `${e.target.value}-01` : month;
                setMonth(m);
                void refresh(m, accountId);
              }}
            />
          </Field>

          {(preview.transactions > 0 || preview.adjustments.length > 0) && (
            <Field label="לרשום את העסקאות בחשבון">
              <select
                className="select"
                value={accountId ?? openAccounts.find((a) => a.name === preview.account_name)?.id ?? ''}
                disabled={preview.applied}
                onChange={(e) => {
                  const id = Number(e.target.value) || null;
                  setAccountId(id);
                  void refresh(month, id);
                }}
              >
                {openAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
          )}

          <Preview summary={preview} sources={parsed.sources} />

          {preview.applied ? (
            <div style={{ marginTop: 'var(--s4)' }}>
              <p className="title" role="status">הייבוא הושלם.</p>
              <Link to="/budget" className="btn btn-primary btn-block">לתקציב של {monthLabel(preview.month)}</Link>
            </div>
          ) : nothing ? (
            <p className="title" role="status" style={{ marginTop: 'var(--s4)' }}>
              הכול מהקובץ כבר כאן. אין מה לייבא.
            </p>
          ) : (
            <div style={{ marginTop: 'var(--s4)' }}>
              <AsyncForm
                submitLabel={`ייבוא ל${monthLabel(preview.month)}`}
                onSubmit={async () => { setPreview(await ask(parsed, month, accountId, true)); }}
              >
                {null}
              </AsyncForm>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * What the import will do, in the order a person checks it: the structure,
 * the budget, then the money. Every line is a sentence, not a coloured number —
 * the difference between «12» and «12 עסקאות חדשות» is the difference between
 * a figure and an answer.
 */
function Preview({ summary, sources }: { summary: ImportSummary; sources: string[] }) {
  const done = summary.applied;
  const lines: { label: string; value: ReactNode; detail?: ReactNode }[] = [];

  if (sources.length) lines.push({ label: 'גיליונות', value: sources.map((s) => `«${s}»`).join(', ') });
  if (summary.new_categories.length) {
    lines.push({
      label: done ? 'סעיפים שנוספו' : 'סעיפים חדשים',
      value: `${summary.new_categories.length}${summary.new_groups.length ? ` ב-${summary.new_groups.length} קבוצות חדשות` : ''}`,
      detail: summary.new_categories.map((c) => c.name).join(' · '),
    });
  }
  if (summary.allocations || summary.unchanged_allocations) {
    lines.push({
      label: 'תקציב החודש',
      value: `${summary.allocations} סעיפים ${done ? 'עודכנו' : 'יעודכנו'}`
        + (summary.unchanged_allocations ? `, ${summary.unchanged_allocations} כבר זהים` : ''),
    });
  }
  if (summary.commitments) {
    lines.push({ label: 'סיווג קשיח/גמיש', value: `${summary.commitments} סעיפים ${done ? 'עודכנו' : 'יעודכנו'}` });
  }
  lines.push({
    label: 'עסקאות',
    value: `${summary.transactions} חדשות` + (summary.duplicates ? `, ${summary.duplicates} כבר רשומות ולא ייכנסו שוב` : ''),
    detail: summary.transactions && summary.account_name
      ? <>בסך <span className="n">{formatILS(-summary.transactions_total)}</span>, לחשבון {summary.account_name}</> : undefined,
  });
  if (summary.by_payee) {
    lines.push({
      label: 'שויכו לפי בית העסק',
      value: `${summary.by_payee} עסקאות`,
      detail: 'לא היה להן סעיף בקובץ, והן נרשמו לסעיף שבו בית העסק נרשם בפעם הקודמת.',
    });
  }
  if (summary.installments) {
    lines.push({ label: 'בתשלומים', value: `${summary.installments} עסקאות`, detail: 'ייספרו ב«כבר מחויב לחודשים הבאים» בתקציב.' });
  }
  if (summary.adjustments.length) {
    lines.push({
      label: 'השלמות מ«בפועל»',
      value: `${summary.adjustments.length} סעיפים`,
      // Each amount is its own LTR island (docs/DESIGN.md §2): inside a
      // Hebrew sentence the bidi algorithm would otherwise put ₪ after it.
      detail: (
        <>
          {summary.adjustments.map((a, i) => (
            <Fragment key={a.name}>
              {i > 0 && ' · '}{a.name} <span className="n">{formatILS(Math.abs(a.amount))}</span>
            </Fragment>
          ))}
          . בקובץ «בפועל» שונה מסכום העסקאות של הסעיף, וההפרש נרשם כשורה אחת.
        </>
      ),
    });
  }
  if (summary.retire) {
    lines.push({ label: 'השלמות קודמות', value: `${summary.retire} יוחלפו בחדשות` });
  }

  return (
    <>
      <div className="rows">
        {lines.map((l) => (
          <div className="row" key={l.label} style={{ minHeight: 48 }}>
            <span className="grow">
              <span className="label" style={{ display: 'block' }}>{l.label}</span>
              <span className="title">{l.value}</span>
              {l.detail && <span className="meta" style={{ display: 'block' }}>{l.detail}</span>}
            </span>
          </div>
        ))}
      </div>
      {summary.unmatched.length > 0 && (
        <p className="meta" style={{ marginTop: 'var(--s2)' }}>
          {summary.unmatched.length === 1 ? 'הסעיף' : 'הסעיפים'} {summary.unmatched.map((u) => `«${u}»`).join(', ')}{' '}
          לא קיימים בבקרה החודשית ולא כאן, ולכן העסקאות שלהם ייכנסו בלי סעיף. אפשר לשייך אותן אחר כך במסך התנועות.
        </p>
      )}
      {summary.warnings.map((w) => (
        <p className="meta" key={w} style={{ marginTop: 'var(--s2)' }}>{w}</p>
      ))}
    </>
  );
}
