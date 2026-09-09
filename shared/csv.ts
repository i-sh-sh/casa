/**
 * CSV, written for the two programs that will actually open it: Excel, and a
 * person's eyes.
 *
 * Three things here are not obvious and all three have bitten real exports.
 *
 * **The BOM.** Excel on Windows reads a .csv as the local 8-bit code page
 * unless the file opens with a UTF-8 byte-order mark. Without it every Hebrew
 * column arrives as mojibake — «רמי לוי» as «ר×ž×™ ×œ×•×™» — and the export looks
 * broken rather than mis-decoded. It costs three bytes.
 *
 * **Formula injection.** A cell whose text begins with `=`, `+`, `-` or `@` is
 * a formula to Excel, not a string. A payee literally named `=cmd|...` is the
 * classic attack, but the everyday version is milder and more common: a note
 * beginning with a minus sign becomes `#NAME?` and the row silently loses its
 * meaning. Prefixing a tab neutralises both and is invisible in the cell.
 *
 * **Dates stay strings.** A DATE column means a calendar day. Turning it into a
 * Date and back shifts it a day in any timezone east of UTC — the same bug this
 * project already fixed once at the database driver.
 */

export const BOM = '﻿';

/** Characters Excel reads as the start of a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

export function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  // Numbers and booleans are never quoted and never dangerous: they cannot
  // contain a separator, and Excel should read them as values.
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  let text = String(value);

  // Neutralise before quoting, so the guard is inside the quoted field rather
  // than in front of it where it would break the separator scan.
  if (FORMULA_START.test(text)) text = `\t${text}`;

  if (/["\n\r,]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  // An empty export is still a valid file, and a valid file is what tells the
  // person "you have nothing here yet" rather than "the download failed".
  const cols = columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  if (cols.length === 0) return BOM;

  const lines = [cols.map(escapeCell).join(',')];
  for (const row of rows) lines.push(cols.map((c) => escapeCell(row[c])).join(','));

  // CRLF: the line ending every spreadsheet agrees on.
  return BOM + lines.join('\r\n') + '\r\n';
}

/**
 * A filename a person can find again in six months.
 *
 * Dated, because the whole point of an export is that there will be more than
 * one; and ASCII, because a Hebrew filename survives the browser but not every
 * mail client, cloud drive and phone it will pass through afterwards.
 */
export function exportFilename(what: string, on = new Date()): string {
  const day = on.toISOString().slice(0, 10);
  const safe = what.replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'export';
  return `casa-${safe}-${day}.csv`;
}
