import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectStore, findDate, matchLine, parseReceipt, parseReceiptJson, parseReceiptText,
  planListClear, receiptFingerprint,
} from '../../shared/receipts.ts';
import { takeReceiptMatch } from '../../shared/budget-workbook.ts';

// Receipt pages are not documented by anyone, so these are the shapes a
// receipt takes once copied off a phone: one line per item, or the name on
// one line and its numbers on the next.

const ONE_LINE = `
רמי לוי שיווק השקמה 2011 בע"מ
סניף גוש עציון
תאריך: 18/11/2026 שעה 18:42
חלב תנובה 3% 1 ליטר 7290004131074 2 6.90 13.80
לחם אחיד פרוס 7290000000017 1 7.40 7.40
עגבניות 0.512 7.90 4.04
הנחת מבצע -2.00
סה"כ לתשלום 23.24
ויזה 1234 23.24
`;

test('one item per line: name, barcode, quantity, price', () => {
  const r = parseReceiptText(ONE_LINE);
  assert.equal(r.store, 'רמי לוי');
  assert.equal(r.purchased_on, '2026-11-18');
  assert.equal(r.total, 23.24);
  assert.equal(r.lines.length, 3);
  const milk = r.lines[0]!;
  assert.equal(milk.name, 'חלב תנובה 3% 1 ליטר');
  assert.equal(milk.barcode, '7290004131074');
  assert.equal(milk.qty, 2);
  assert.equal(milk.total, 13.8);
  assert.equal(r.lines[2]!.qty, 0.512, 'a weighed item keeps its weight');
  assert.equal(r.lines[2]!.total, 2.04, 'the discount comes off the line above it');
});

test('the name on one line, its numbers on the next', () => {
  const r = parseReceiptText(`אושר עד
2026-11-17
במבה אסם 80 גרם
7290000066318
3 4.50 13.50
שקית
0.10
סה״כ 13.60`);
  assert.equal(r.store, 'אושר עד');
  assert.equal(r.purchased_on, '2026-11-17');
  assert.deepEqual(r.lines.map((l) => [l.name, l.barcode, l.qty, l.total]), [
    ['במבה אסם 80 גרם', '7290000066318', 3, 13.5],
    ['שקית', null, 1, 0.1],
  ]);
});

test('payment, VAT and header lines are never items', () => {
  const r = parseReceiptText(`מע"מ 17% 3.38\nעודף 0.00\nמספר קופה 3\nאשראי 23.24`);
  assert.equal(r.lines.length, 0);
  assert.ok(r.warnings.length > 0);
});

test('a receipt as data: whatever the field names, the items are found', () => {
  const r = parseReceiptJson({
    document: {
      storeName: 'רמי לוי שיווק השקמה',
      date: '2026-11-18T18:42:00',
      totalAmount: 21.2,
      items: [
        { itemName: 'חלב תנובה 3%', barcode: '7290004131074', quantity: 2, unitPrice: 6.9, totalPrice: 13.8 },
        { itemName: 'לחם אחיד', barcode: '7290000000017', quantity: 1, unitPrice: 7.4 },
      ],
      payments: [{ type: 'credit', amount: 21.2 }],
    },
  });
  assert.equal(r.store, 'רמי לוי');
  assert.equal(r.purchased_on, '2026-11-18');
  assert.equal(r.total, 21.2);
  assert.deepEqual(r.lines.map((l) => [l.name, l.barcode, l.qty, l.total]), [
    ['חלב תנובה 3%', '7290004131074', 2, 13.8],
    ['לחם אחיד', '7290000000017', 1, 7.4],
  ]);
});

test('parseReceipt picks JSON or text, and says when the lines do not add up', () => {
  assert.equal(parseReceipt('{"items":[{"name":"חלב","price":6.9}]}').lines.length, 1);
  const r = parseReceipt('חלב 6.90\nסה"כ לתשלום 50.00');
  assert.equal(r.total, 50);
  assert.ok(r.warnings.some((w) => w.includes('שונה')));
  assert.equal(parseReceipt('חלב 6.90\nלחם 7.40').total, 14.3, 'no total on the slip: the lines are the total');
});

test('stores and dates', () => {
  assert.equal(detectStore('RAMI LEVY'), 'רמי לוי');
  assert.equal(detectStore('מכולת השכונה'), '');
  assert.equal(findDate('18.11.26'), '2026-11-18');
  assert.equal(findDate('אין כאן תאריך'), null);
});

test('matching: barcode, then what we answered before, then the exact name', () => {
  const products = [
    { id: 1, name: 'חלב', name_key: 'חלב', barcode: '7290004131074' },
    { id: 2, name: 'לחם', name_key: 'לחם', barcode: null },
  ];
  const rules = [
    { item_key: 'לחם אחיד פרוס', product_id: 2, ignored: false },
    { item_key: 'שקית', product_id: null, ignored: true },
  ];
  const line = (name: string, barcode: string | null = null) => ({ name, barcode, qty: 1, total: 1 });
  assert.deepEqual(matchLine(line('חלב תנובה 3%', '7290004131074'), products, rules), { product_id: 1, how: 'barcode' });
  assert.deepEqual(matchLine(line('לחם אחיד פרוס'), products, rules), { product_id: 2, how: 'learned' });
  assert.deepEqual(matchLine(line('לחם'), products, rules), { product_id: 2, how: 'name' });
  assert.deepEqual(matchLine(line('שקית'), products, rules), { product_id: null, how: 'ignored' });
  assert.deepEqual(matchLine(line('חלב עמיד'), products, rules), { product_id: null, how: null }, 'nothing fuzzier than that');
});

test('the list: open items come off, items ticked in the shop are not stocked twice', () => {
  const { clear, alreadyStocked } = planListClear(
    [{ product_id: 1, name: 'חלב תנובה' }, { product_id: null, name: 'סוללות' }, { product_id: 3, name: 'ביצים' }],
    [
      { id: 10, product_id: 1, name_key: 'חלב', status: 'open' },
      { id: 11, product_id: 3, name_key: 'ביצים', status: 'bought' },
      { id: 12, product_id: null, name_key: 'סוללות', status: 'open' },
      { id: 13, product_id: 4, name_key: 'קפה', status: 'open' },
    ],
  );
  assert.deepEqual(clear, [10, 11, 12]);
  assert.deepEqual([...alreadyStocked], [3]);
});

test('the same receipt pasted twice has the same fingerprint', () => {
  const a = parseReceiptText(ONE_LINE);
  const b = parseReceiptText(ONE_LINE.replace(/ /g, '  ').replace(/\n/g, '\n\n'));
  const fp = (r: typeof a) => receiptFingerprint({ ...r, purchased_on: r.purchased_on! });
  assert.equal(fp(a), fp(b));
  assert.notEqual(fp(a), fp({ ...a, total: 99 }));
});

test('a statement row finds the receipt by amount and a few days, once', () => {
  const receipts = [{ id: 1, occurred_on: '2026-11-18', amount: -23.24 }];
  const used = new Set<number>();
  assert.equal(takeReceiptMatch({ date: '2026-11-20', amount: -23.24 }, receipts, used), 1);
  assert.equal(takeReceiptMatch({ date: '2026-11-20', amount: -23.24 }, receipts, used), null, 'each receipt is used once');
  assert.equal(takeReceiptMatch({ date: '2026-11-25', amount: -23.24 }, receipts, new Set()), null);
});
