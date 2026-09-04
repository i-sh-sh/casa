import type { Product, StockEntry } from './types.js';

/**
 * The key two spellings of the same thing collapse onto.
 *
 * "חלב 3%", "חלב  3%" and "  חלב 3% " are one product; typing the second one
 * at the supermarket should find the first, not create a duplicate that then
 * has its own min-stock rule and its own half-empty shelf.
 *
 * What it deliberately does NOT do is normalise Hebrew final letters. It is
 * tempting — ם/מ, ן/נ — but "מן" and "ממ" are different words, and a key that
 * merges them merges products. The transformations here are all ones a person
 * would call "the same text typed differently": whitespace, niqqud, and the
 * three glyphs Hebrew keyboards produce for a quote (״ ׳ " ').
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[֑-ׇ]/g, '')      // niqqud and cantillation
    .replace(/[׳״"'`´’]/g, '')  // geresh, gershayim, and the ASCII quotes people type instead
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Every open batch of a product, added up. */
export function sumStock(entries: { qty: number }[]): number {
  return Math.round(entries.reduce((sum, e) => sum + e.qty, 0) * 100) / 100;
}

export type ExpiryState = 'none' | 'ok' | 'soon' | 'expired';

/**
 * How worried to be about a date.
 *
 * `soon` is the only one that earns a notification. `expired` is not an alert
 * — by the time it is true the yoghurt is already off, and a push about it is
 * a push about something you can no longer act on. The screen still shows it
 * in red; the phone stays quiet.
 */
export function expiryState(expiresOn: string | null, today: string, soonDays = 4): ExpiryState {
  if (!expiresOn) return 'none';
  const days = daysBetween(today, expiresOn);
  if (days < 0) return 'expired';
  if (days <= soonDays) return 'soon';
  return 'ok';
}

/** Whole days from `from` to `to`, both 'YYYY-MM-DD'. Negative if `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(...dateParts(from));
  const b = Date.UTC(...dateParts(to));
  return Math.round((b - a) / 86_400_000);
}

function dateParts(iso: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`not a date: ${iso}`);
  return [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
}

/**
 * Does this product belong on the shopping list right now?
 *
 * `min_qty = 0` means "we do not track a minimum for this" — not "we want zero
 * of it". Without that carve-out every product ever entered would be
 * permanently below its minimum the moment it ran out, and the auto-list would
 * be everything we have ever bought.
 */
export function shouldRestock(product: { min_qty: number; in_stock: number; archived_at?: string | null }): boolean {
  if (product.archived_at) return false;
  if (product.min_qty <= 0) return false;
  return product.in_stock < product.min_qty;
}

/** How much to put on the list: enough to reach the minimum, rounded up to a whole unit. */
export function restockQty(product: { min_qty: number; in_stock: number }): number {
  return Math.max(1, Math.ceil(product.min_qty - product.in_stock));
}

/**
 * Takes from the batch that expires first.
 *
 * This is the only consumption order that does not systematically throw food
 * away: newest-first leaves the old carton at the back until it turns. Batches
 * with no expiry date go last — they are the ones that keep.
 */
export function consumeOrder<T extends { expires_on: string | null; purchased_on?: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.expires_on && b.expires_on) return a.expires_on < b.expires_on ? -1 : a.expires_on > b.expires_on ? 1 : 0;
    if (a.expires_on) return -1;
    if (b.expires_on) return 1;
    return (a.purchased_on ?? '') < (b.purchased_on ?? '') ? -1 : 1;
  });
}

/**
 * Applies a consumption across batches, oldest-expiry first.
 *
 * Returns what to write back per batch. Consuming more than is on the shelf is
 * allowed and leaves `shortfall` set: the stock count was wrong, which happens
 * constantly in a real kitchen, and refusing the update would just teach us to
 * stop recording. Better to zero out and say so.
 */
export function applyConsumption(
  entries: (Pick<StockEntry, 'id' | 'qty' | 'expires_on' | 'purchased_on'>)[],
  qty: number,
): { updates: { id: number; qty: number; taken: number }[]; shortfall: number } {
  let remaining = qty;
  const updates: { id: number; qty: number; taken: number }[] = [];
  for (const entry of consumeOrder(entries)) {
    if (remaining <= 0) break;
    const taken = Math.min(entry.qty, remaining);
    if (taken <= 0) continue;
    remaining = Math.round((remaining - taken) * 100) / 100;
    updates.push({ id: entry.id, qty: Math.round((entry.qty - taken) * 100) / 100, taken });
  }
  return { updates, shortfall: Math.round(remaining * 100) / 100 };
}

/** The aisles, in the order a supermarket is actually walked. */
export const AISLES = [
  'פירות וירקות',
  'חלב וביצים',
  'בשר ודגים',
  'לחם ומאפים',
  'יבשים ושימורים',
  'קפואים',
  'משקאות',
  'חטיפים ומתוקים',
  'ניקיון',
  'טואלטיקה',
  'כללי',
] as const;

export function aisleRank(category: string): number {
  const i = (AISLES as readonly string[]).indexOf(category);
  return i === -1 ? AISLES.length : i;
}

/** Sorts a shopping list into walking order, then alphabetically inside each aisle. */
export function sortForShopping<T extends { category: string; name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const rank = aisleRank(a.category) - aisleRank(b.category);
    if (rank !== 0) return rank;
    return a.name.localeCompare(b.name, 'he');
  });
}

export function decorateProduct(
  product: Omit<Product, 'in_stock' | 'next_expiry' | 'below_min'>,
  entries: { qty: number; expires_on: string | null }[],
): Product {
  const live = entries.filter((e) => e.qty > 0);
  const in_stock = sumStock(live);
  const expiries = live.map((e) => e.expires_on).filter((d): d is string => !!d).sort();
  return {
    ...product,
    in_stock,
    next_expiry: expiries[0] ?? null,
    below_min: shouldRestock({ ...product, in_stock }),
  };
}
