import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOM, escapeCell, exportFilename, toCsv } from '../../shared/csv.ts';

// The export is a promise made to three couples in writing: their data is
// theirs, and they can take it out. A file that opens as mojibake, or that
// Excel rewrites into #NAME?, does not keep that promise — it just looks like
// it does until somebody opens it.

test('the file opens with a UTF-8 BOM', () => {
  // Without it Excel on Windows reads the file as the local code page and every
  // Hebrew column arrives as mojibake. Three bytes; the whole export depends on
  // them.
  const csv = toCsv([{ payee: 'רמי לוי' }]);
  assert.ok(csv.startsWith(BOM), 'no BOM — Excel will mangle every Hebrew cell');
  assert.ok(csv.includes('רמי לוי'));
});

test('a cell that looks like a formula is neutralised', () => {
  // The everyday version is not an attack: a note that starts with a minus sign
  // becomes #NAME? and the row quietly loses its meaning.
  for (const dangerous of ['=SUM(A1)', '+1', '-100 החזר', '@here', '=cmd|calc']) {
    const cell = escapeCell(dangerous);
    assert.ok(
      cell.startsWith('\t') || cell.startsWith('"\t'),
      `${dangerous} was not neutralised: ${cell}`,
    );
  }
  // And the text itself survives, because the export has to stay readable.
  assert.ok(escapeCell('-100 החזר').includes('-100 החזר'));
});

test('a negative number is still a number', () => {
  // Spends are stored negative. Quoting or tab-prefixing them would make every
  // amount a string, and the first thing anyone does with this file is SUM it.
  assert.equal(escapeCell(-243.9), '-243.9');
  assert.equal(escapeCell(0), '0');
  assert.doesNotMatch(escapeCell(-100), /\t|"/);
});

test('quotes, commas and newlines round-trip', () => {
  assert.equal(escapeCell('רמי לוי, סניף רמלה'), '"רמי לוי, סניף רמלה"');
  assert.equal(escapeCell('הוא אמר "שלום"'), '"הוא אמר ""שלום"""');
  assert.equal(escapeCell('שורה\nשנייה'), '"שורה\nשנייה"');
  assert.equal(escapeCell('בלי כלום'), 'בלי כלום');
});

test('empty and missing become empty, not the word null', () => {
  assert.equal(escapeCell(null), '');
  assert.equal(escapeCell(undefined), '');
  assert.equal(escapeCell(''), '');
  assert.equal(escapeCell(NaN), '');
});

test('columns come from the caller, so a null in row one cannot drop one', () => {
  // Inferring columns from the first row is the classic silent data loss: one
  // row missing `note` and the column vanishes for everybody.
  const csv = toCsv(
    [{ a: 1 }, { a: 2, b: 'שם' }],
    ['a', 'b'],
  );
  const [header, first, second] = csv.replace(BOM, '').trim().split('\r\n');
  assert.equal(header, 'a,b');
  assert.equal(first, '1,');
  assert.equal(second, '2,שם');
});

test('an empty export is still a valid file', () => {
  // "You have nothing yet" and "the download failed" must not look the same.
  assert.equal(toCsv([]), BOM);
  const empty = toCsv([], ['occurred_on', 'amount']);
  assert.equal(empty, `${BOM}occurred_on,amount\r\n`);
});

test('rows end with CRLF', () => {
  const csv = toCsv([{ a: 1 }, { a: 2 }]);
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(csv.replace(BOM, '').split('\r\n').filter(Boolean).length, 3);
});

test('a date column stays the string the database sent', () => {
  // A DATE means a calendar day. Turning it into a Date and back shifts it a
  // day in any timezone east of UTC — a bug this project already fixed once, at
  // the database driver.
  assert.equal(escapeCell('2026-09-03'), '2026-09-03');
});

test('the filename is dated and survives every mail client', () => {
  const name = exportFilename('transactions', new Date('2026-09-09T10:00:00Z'));
  assert.equal(name, 'casa-transactions-2026-09-09.csv');
  // A Hebrew filename survives the browser but not every mail client, cloud
  // drive and phone it passes through afterwards — so a name with nothing
  // ASCII in it falls back rather than producing `casa--2026-09-09.csv`.
  assert.match(exportFilename('תנועות', new Date('2026-09-09T10:00:00Z')), /^casa-export-2026-09-09\.csv$/);
  // And a name is never a path: this string reaches a Content-Disposition
  // header, where a slash or a newline is somebody else's problem to explain.
  assert.equal(exportFilename('../../etc/passwd', new Date('2026-09-09T10:00:00Z')), 'casa-etcpasswd-2026-09-09.csv');
  assert.doesNotMatch(exportFilename('a\r\nContent-Type: x'), /[\r\n]/);
});
