import { badRequest } from './http.js';

// Everything that arrives from a browser is a string of unknown shape until
// one of these has looked at it. The rule is the same in each: coerce what a
// form legitimately sends, refuse everything else loudly, and never hand a
// `NaN` or an `undefined` to a query — Postgres will accept it and store
// something nobody meant.

export function str(value: unknown, field: string, opts: { max?: number; required?: boolean } = {}): string {
  const { max = 500, required = true } = opts;
  if (value == null || value === '') {
    if (required) throw badRequest(`חסר שדה: ${field}`);
    return '';
  }
  if (typeof value !== 'string') throw badRequest(`${field} חייב להיות טקסט`);
  const trimmed = value.trim();
  if (required && !trimmed) throw badRequest(`חסר שדה: ${field}`);
  if (trimmed.length > max) throw badRequest(`${field} ארוך מדי (מקסימום ${max} תווים)`);
  return trimmed;
}

export function optionalStr(value: unknown, field: string, max = 2000): string | null {
  if (value == null || value === '') return null;
  return str(value, field, { max });
}

export function num(value: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  const { min = -1e9, max = 1e9 } = opts;
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''));
  if (!Number.isFinite(n)) throw badRequest(`${field} חייב להיות מספר`);
  if (n < min || n > max) throw badRequest(`${field} מחוץ לטווח המותר`);
  // Two decimals, because that is what the column holds. Rounding here rather
  // than letting Postgres do it means the number we echo back is the number we
  // stored — otherwise the UI shows 10.005 and the database holds 10.01.
  return Math.round(n * 100) / 100;
}

export function optionalNum(value: unknown, field: string, opts: { min?: number; max?: number } = {}): number | null {
  if (value == null || value === '') return null;
  return num(value, field, opts);
}

export function int(value: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  const n = num(value, field, opts);
  if (!Number.isInteger(n)) throw badRequest(`${field} חייב להיות מספר שלם`);
  return n;
}

export function optionalInt(value: unknown, field: string): number | null {
  if (value == null || value === '') return null;
  return int(value, field);
}

export function bool(value: unknown, fallback = false): boolean {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1' || value === 1;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function date(value: unknown, field: string): string {
  const s = str(value, field, { max: 10 });
  if (!DATE_RE.test(s)) throw badRequest(`${field} חייב להיות תאריך בפורמט YYYY-MM-DD`);
  // A regex match is not a real date: 2026-02-31 passes it. Round-tripping
  // through Date catches the ones the calendar refuses.
  const parsed = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== s) {
    throw badRequest(`${field} אינו תאריך קיים`);
  }
  return s;
}

export function optionalDate(value: unknown, field: string): string | null {
  if (value == null || value === '') return null;
  return date(value, field);
}

export function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[], fallback?: T): T {
  if ((value == null || value === '') && fallback !== undefined) return fallback;
  const s = String(value ?? '');
  if (!(allowed as readonly string[]).includes(s)) {
    throw badRequest(`${field} חייב להיות אחד מ: ${allowed.join(', ')}`);
  }
  return s as T;
}
