import { query } from '../_lib/db.js';
import { badRequest } from '../_lib/http.js';
import { toCsv } from '../../shared/csv.js';
import { BACKUP_TABLES, findSheet, SHEETS, SHEET_NAMES } from '../../shared/export-sheets.js';

/**
 * Taking the data out — the execution half.
 *
 * A promise made to three pilot couples in writing: their financial life is
 * theirs, and one tap gets it back. That promise is only kept if the file opens
 * in the tool they own, so this is CSV for Excel with the joins already done.
 * An export of raw foreign keys is a backup, not an answer to «כמה הוצאנו על
 * הסופר ביוני».
 *
 * The sheets themselves are defined in shared/export-sheets.ts, where a test
 * can reach them.
 */

export { SHEET_NAMES };

export async function exportSheet(name: string): Promise<{ filename: string; csv: string }> {
  const sheet = findSheet(name);
  if (!sheet) {
    throw badRequest(`אין ייצוא בשם «${name}». יש: ${SHEETS.map((s) => s.name).join(', ')}`);
  }
  return { filename: sheet.name, csv: toCsv(await query(sheet.sql), sheet.columns) };
}

/**
 * Everything, as one JSON document.
 *
 * The CSVs are for reading; this is for restoring. It keeps the ids and the
 * shape, so a household deleted by mistake — or one that leaves and comes back
 * — is a file rather than a story about how sorry we are.
 */
export async function exportEverything(): Promise<Record<string, unknown>> {
  const readable: Record<string, unknown> = {};
  for (const sheet of SHEETS) readable[sheet.name] = await query(sheet.sql);

  const raw: Record<string, unknown> = {};
  for (const table of BACKUP_TABLES) raw[table] = await query(`SELECT * FROM ${table}`);

  return { exported_at: new Date().toISOString(), readable, raw };
}
