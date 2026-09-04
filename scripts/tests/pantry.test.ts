import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aisleRank, applyConsumption, consumeOrder, daysBetween, decorateProduct,
  expiryState, normalizeName, restockQty, shouldRestock, sortForShopping, sumStock,
} from '../../shared/pantry.ts';
import type { Product } from '../../shared/types.ts';

// ── Names ────────────────────────────────────────────────────────────────

test('the same thing typed differently is the same thing', () => {
  assert.equal(normalizeName('  חלב 3%  '), normalizeName('חלב 3%'));
  assert.equal(normalizeName('חלב  3%'), normalizeName('חלב 3%'));
  assert.equal(normalizeName('קוטג׳'), normalizeName('קוטג'));
  assert.equal(normalizeName('קוטג"ג'), normalizeName('קוטגג'));
  assert.equal(normalizeName('Milk'), normalizeName('milk'));
});

test('Hebrew final letters are NOT normalised away', () => {
  // The tempting normalisation that must never happen: ם/מ and ן/נ distinguish
  // real words, and merging them would merge unrelated products.
  assert.notEqual(normalizeName('מן'), normalizeName('ממ'));
  assert.notEqual(normalizeName('לחם'), normalizeName('לחמ'));
});

// ── Dates ────────────────────────────────────────────────────────────────

test('days between two calendar days, without timezone drift', () => {
  assert.equal(daysBetween('2026-03-01', '2026-03-08'), 7);
  assert.equal(daysBetween('2026-03-08', '2026-03-01'), -7);
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1, '2026 is not a leap year');
  assert.equal(daysBetween('2028-02-28', '2028-03-01'), 2, '2028 is');
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
});

test('expiry has four states and no date is one of them', () => {
  const today = '2026-03-10';
  assert.equal(expiryState(null, today), 'none');
  assert.equal(expiryState('2026-03-09', today), 'expired');
  assert.equal(expiryState('2026-03-10', today), 'soon', 'today is still usable');
  assert.equal(expiryState('2026-03-14', today), 'soon');
  assert.equal(expiryState('2026-03-15', today), 'ok');
});

// ── The restock rule ─────────────────────────────────────────────────────

test('min_qty of 0 means "do not nag", not "we want none"', () => {
  // Without this carve-out every product ever entered would sit permanently
  // below its minimum the moment it ran out, and the auto-list would become
  // everything the household has ever bought.
  assert.equal(shouldRestock({ min_qty: 0, in_stock: 0 }), false);
  assert.equal(shouldRestock({ min_qty: 2, in_stock: 0 }), true);
  assert.equal(shouldRestock({ min_qty: 2, in_stock: 1.5 }), true);
  assert.equal(shouldRestock({ min_qty: 2, in_stock: 2 }), false, 'at the minimum is not below it');
  assert.equal(shouldRestock({ min_qty: 2, in_stock: 0, archived_at: '2026-01-01' }), false);
});

test('restock quantity reaches the minimum, in whole units', () => {
  assert.equal(restockQty({ min_qty: 6, in_stock: 2 }), 4);
  assert.equal(restockQty({ min_qty: 2, in_stock: 1.5 }), 1, 'half a carton short still buys one');
  assert.equal(restockQty({ min_qty: 2, in_stock: 2 }), 1, 'never zero — it would be an item to buy none of');
});

// ── Consumption ──────────────────────────────────────────────────────────

test('the batch that expires first is the one taken from', () => {
  const entries = [
    { id: 1, qty: 1, expires_on: '2026-04-01', purchased_on: '2026-03-01' },
    { id: 2, qty: 1, expires_on: '2026-03-15', purchased_on: '2026-03-05' },
    { id: 3, qty: 1, expires_on: null, purchased_on: '2026-01-01' },
  ];
  assert.deepEqual(consumeOrder(entries).map((e) => e.id), [2, 1, 3], 'no-expiry batches go last — they keep');
});

test('consuming spans batches, oldest first', () => {
  const entries = [
    { id: 1, qty: 2, expires_on: '2026-04-01', purchased_on: '2026-03-01' },
    { id: 2, qty: 3, expires_on: '2026-03-15', purchased_on: '2026-03-05' },
  ];
  const { updates, shortfall } = applyConsumption(entries, 4);
  assert.equal(shortfall, 0);
  assert.deepEqual(updates, [
    { id: 2, qty: 0, taken: 3 },
    { id: 1, qty: 1, taken: 1 },
  ]);
});

test('consuming more than we have empties the shelf and reports the gap', () => {
  // Refusing here would teach us to stop recording, which is far worse than a
  // count that was already wrong.
  const entries = [{ id: 1, qty: 1, expires_on: null, purchased_on: '2026-03-01' }];
  const { updates, shortfall } = applyConsumption(entries, 3);
  assert.deepEqual(updates, [{ id: 1, qty: 0, taken: 1 }]);
  assert.equal(shortfall, 2);
});

test('consuming from an empty shelf changes nothing', () => {
  const { updates, shortfall } = applyConsumption([], 2);
  assert.deepEqual(updates, []);
  assert.equal(shortfall, 2);
});

test('fractional quantities do not accumulate float dust', () => {
  const entries = [{ id: 1, qty: 0.3, expires_on: null, purchased_on: '2026-03-01' }];
  const { updates } = applyConsumption(entries, 0.1);
  assert.equal(updates[0]!.qty, 0.2);
});

// ── The list, in walking order ───────────────────────────────────────────

test('the list is sorted the way the shop is walked', () => {
  const items = [
    { category: 'ניקיון', name: 'סבון' },
    { category: 'פירות וירקות', name: 'עגבניות' },
    { category: 'חלב וביצים', name: 'חלב' },
    { category: 'קטגוריה שלא קיימת', name: 'משהו' },
  ];
  assert.deepEqual(
    sortForShopping(items).map((i) => i.category),
    ['פירות וירקות', 'חלב וביצים', 'ניקיון', 'קטגוריה שלא קיימת'],
  );
});

test('an unknown aisle sorts last rather than first', () => {
  assert.ok(aisleRank('מה שזה לא יהיה') > aisleRank('כללי'));
});

test('within an aisle, Hebrew sorts as Hebrew', () => {
  const items = [
    { category: 'כללי', name: 'תפוח' },
    { category: 'כללי', name: 'אבטיח' },
  ];
  assert.deepEqual(sortForShopping(items).map((i) => i.name), ['אבטיח', 'תפוח']);
});

// ── Derived product state ────────────────────────────────────────────────

const base: Omit<Product, 'in_stock' | 'next_expiry' | 'below_min'> = {
  id: 1, name: 'חלב', name_key: 'חלב', unit: 'ליטר', category: 'חלב וביצים',
  min_qty: 2, default_location: 'מקרר', shelf_life_days: 7, barcode: null,
  note: null, archived_at: null,
};

test('a product carries its stock, its soonest expiry, and whether it is short', () => {
  const product = decorateProduct(base, [
    { qty: 1, expires_on: '2026-04-01' },
    { qty: 0.5, expires_on: '2026-03-20' },
    { qty: 0, expires_on: '2026-03-01' },
  ]);
  assert.equal(product.in_stock, 1.5);
  assert.equal(product.next_expiry, '2026-03-20', 'empty batches do not count');
  assert.equal(product.below_min, true);
});

test('a product with nothing on the shelf has no expiry to worry about', () => {
  const product = decorateProduct(base, []);
  assert.equal(product.in_stock, 0);
  assert.equal(product.next_expiry, null);
  assert.equal(product.below_min, true);
});

test('sumStock adds without float dust', () => {
  assert.equal(sumStock([{ qty: 0.1 }, { qty: 0.2 }]), 0.3);
});
