/**
 * A spreadsheet as cells, in and out — and nothing a budget does not use.
 *
 * Reading keeps only what a cell *holds*: its text or number, or the value
 * Excel cached for a formula. Styles, merges and charts are thrown away; the
 * importer finds its tables by the words in their header rows, not by where
 * they sit, because the household's own file has rows they added.
 *
 * Writing takes the stylesheet from the caller, as a constant: a workbook needs
 * a handful of styles, and a generator for them would be the largest part of
 * this file.
 */

export type CellValue = string | number | null;

export interface ReadSheet {
  name: string;
  /** Keyed by A1 reference. */
  cells: Map<string, CellValue>;
}

/** 'A' → 0, 'AB' → 27. */
export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function colLetter(index: number): string {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function splitRef(ref: string): { col: number; row: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`bad cell reference ${ref}`);
  return { col: colIndex(m[1]!), row: Number(m[2]) };
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') {
      return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]!;
  });
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? decodeXml(m[1]!) : null;
}

/** The text of every `<t>` inside a fragment, joined — a rich-text run is several. */
function textRuns(xml: string): string {
  let out = '';
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]!);
  return out;
}

function resolveTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  return `xl/${target}`.replace(/\/\.\//g, '/');
}

export async function readXlsx(bytes: Uint8Array): Promise<ReadSheet[]> {
  const files = await unzip(bytes);
  const decoder = new TextDecoder();
  const text = (name: string) => {
    const f = files.get(name);
    return f ? decoder.decode(f) : '';
  };

  const workbook = text('xl/workbook.xml');
  if (!workbook) throw new Error('not an xlsx workbook');

  const rels = new Map<string, string>();
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\s([^>]*?)\/?>/g)) {
    const id = attr(m[1]!, 'Id');
    const target = attr(m[1]!, 'Target');
    if (id && target) rels.set(id, resolveTarget(target));
  }

  const shared: string[] = [];
  for (const m of text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textRuns(m[1]!));

  const sheets: ReadSheet[] = [];
  for (const m of workbook.matchAll(/<sheet\s([^>]*?)\/?>/g)) {
    const name = attr(m[1]!, 'name') ?? '';
    const rid = attr(m[1]!, 'r:id');
    const path = rid ? rels.get(rid) : undefined;
    if (!path) continue;
    const cells = new Map<string, CellValue>();
    for (const c of text(path).matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1]!, 'r');
      if (!ref) continue;
      const type = attr(c[1]!, 't');
      const inner = c[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value: CellValue = null;
      if (type === 'inlineStr') value = textRuns(inner);
      else if (type === 's') value = v == null ? null : shared[Number(v)] ?? null;
      else if (type === 'str' || type === 'e') value = v == null ? null : decodeXml(v);
      else if (type === 'b') value = v == null ? null : Number(v);
      else if (v != null && v !== '') value = Number(v);
      if (value !== null && value !== '') cells.set(ref, value);
    }
    sheets.push({ name, cells });
  }
  return sheets;
}

// ── Writing ──────────────────────────────────────────────────────────────

export interface WriteCell {
  value?: string | number | null;
  /** Without the leading '='. Excel computes it on open (fullCalcOnLoad). */
  formula?: string;
  style?: number;
}

export interface WriteSheet {
  name: string;
  /** Column widths in characters, from column A. */
  widths?: number[];
  /** Row number → column letter → cell. */
  rows: Map<number, Map<string, WriteCell>>;
  merges?: string[];
}

function escapeXml(text: string): string {
  return text
    // Characters XML 1.0 cannot carry at all. A payee pasted from a bank PDF
    // occasionally brings one, and one is enough for Excel to refuse the file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cellXml(ref: string, cell: WriteCell): string {
  const s = cell.style ? ` s="${cell.style}"` : '';
  if (cell.formula) return `<c r="${ref}"${s}><f>${escapeXml(cell.formula)}</f></c>`;
  const v = cell.value;
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
  if (typeof v === 'string' && v !== '') {
    // Inline text is never parsed as a formula, so a payee that begins with
    // «=» or «-» stays text — the injection shared/csv.ts has to guard against
    // by hand does not exist here.
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`;
  }
  return s ? `<c r="${ref}"${s}/>` : '';
}

function sheetXml(sheet: WriteSheet): string {
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const rows = [...sheet.rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([n, cells]) => {
      const inner = [...cells.entries()]
        .sort(([a], [b]) => colIndex(a) - colIndex(b))
        .map(([col, cell]) => cellXml(`${col}${n}`, cell))
        .join('');
      return `<row r="${n}">${inner}</row>`;
    })
    .join('');
  const merges = sheet.merges?.length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView rightToLeft="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows}</sheetData>${merges}</worksheet>`;
}

/**
 * The workbook as bytes. `stylesXml` is the caller's: the indices a cell's
 * `style` refers to are positions in its cellXfs, so the two belong together.
 */
export function writeXlsx(sheets: WriteSheet[], stylesXml: string): Uint8Array {
  const enc = new TextEncoder();
  const file = (name: string, content: string) => ({ name, data: enc.encode(content) });
  const n = sheets.length;
  const range = Array.from({ length: n }, (_, i) => i + 1);

  return zip([
    file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${range.map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`),
    file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`),
    file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${range.map((i) => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join('')}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    file('xl/styles.xml', stylesXml),
    ...sheets.map((s, i) => file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s))),
  ]);
}

/** Days since 1899-12-30, the epoch every spreadsheet program agrees on. */
export function dateToSerial(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

export function serialToDate(serial: number): string {
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

// ── ZIP ──────────────────────────────────────────────────────────────────
//
// Here rather than in its own module because files in shared/ cannot import
// each other at runtime: Node's type stripping (the tests) resolves only
// `.ts` specifiers, and the deployed functions only `.js` ones.

/**
 * Just enough ZIP to carry an .xlsx in and out.
 *
 * An .xlsx file is a ZIP of XML, and the libraries that read one weigh more
 * than the rest of this app's dependencies together. What we need is narrow:
 * write a handful of small files, and read back the ones Excel or LibreOffice
 * wrote. Both halves are here, pure, so a test can round-trip a workbook with
 * no browser and no network.
 *
 * Writing stores without compression. A budget workbook is tens of kilobytes;
 * deflate would save a few of them and cost a compressor we would have to own.
 * Reading has to inflate, because every real spreadsheet program deflates —
 * and `DecompressionStream('deflate-raw')` exists in every browser this app
 * supports and in Node 22, so inflating costs nothing to carry.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A ZIP of `entries`, stored (method 0). */
export function zip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);         // version needed
    lv.setUint16(6, 0x0800, true);     // UTF-8 names
    lv.setUint16(8, 0, true);          // stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, entry.data);
    centrals.push(central);
    offset += local.length + size;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Every file in a ZIP, by name.
 *
 * Reads the central directory rather than walking local headers: a file
 * written with data descriptors (as most programs do when streaming) leaves
 * the sizes in the local header as zero, and only the directory has them.
 */
export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();

  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('broken zip directory');
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localName + localExtra;
    const raw = bytes.subarray(start, start + compressed);

    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, await inflateRaw(raw));
    else throw new Error(`unsupported zip method ${method} in ${name}`);
  }
  return files;
}
