import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
}

const screen = code(read('src/features/money/TransactionsScreen.tsx'));
const api = code(read('api/money/[...path].ts'));

/**
 * Correcting a transaction, and the one way that goes quietly wrong.
 *
 * `PATCH /money/transactions/:id` writes every column of the row. That is a
 * fine endpoint and a trap for the screen in front of it: a field the form does
 * not send is not left alone, it is overwritten with whatever the form does
 * send. `paid_by` is the field where that costs something real — it is what the
 * balance between two people is computed from, so a PATCH that stamped the
 * editor's own address onto every corrected row would rewrite who owes whom,
 * silently, as a side effect of fixing a typo.
 */

test('the update endpoint replaces every column — which is what makes the rest of this file necessary', () => {
  const handler = api.slice(api.indexOf('async function updateTransaction'));
  const statement = handler.slice(0, handler.indexOf('RETURNING id'));
  for (const column of ['occurred_on', 'account_id', 'category_id', 'amount', 'payee', 'paid_by', 'split']) {
    assert.match(statement, new RegExp(`\\b${column}\\s*=`), `updateTransaction stopped writing ${column}`);
  }
});

test('editing carries who paid, instead of stamping whoever is editing', () => {
  const submit = screen.slice(screen.indexOf('onSubmit={async () => {'));
  const body = submit.slice(0, submit.indexOf('}}'));
  assert.match(body, /paid_by:\s*paidBy/, 'the edit sends the editor as the payer');
  assert.ok(
    !/paid_by:\s*user\?\.email\s*\?\?\s*''/.test(body),
    'the edit defaults the payer to whoever is holding the phone',
  );
});

test('editing carries the split, so a personal expense does not become shared', () => {
  const submit = screen.slice(screen.indexOf('onSubmit={async () => {'));
  const body = submit.slice(0, submit.indexOf('}}'));
  assert.match(body, /split:\s*transaction\?\.split/, 'the edit hardcodes the split');
});

test('an existing transaction pre-fills every field the form will send', () => {
  // A field left blank in the form is not left alone by the endpoint — it is
  // written as blank. So anything the form submits must be seeded from the row.
  for (const [state, source] of [
    ['amount', /useState\(transaction \? String\(Math\.abs\(transaction\.amount\)\) : ''\)/],
    ['payee', /useState\(transaction\?\.payee/],
    ['accountId', /useState\(transaction \? String\(transaction\.account_id\)/],
    ['categoryId', /useState\(transaction\?\.category_id/],
    ['occurredOn', /useState\(transaction\?\.occurred_on/],
    ['paidBy', /useState\(transaction\?\.paid_by/],
  ] as const) {
    assert.match(screen, source, `${state} is not seeded from the transaction being edited`);
  }
});

test('the sign is read from the row, not assumed to be a spend', () => {
  // Amount is stored signed — negative is money out. Opening an income row in
  // "spend" mode and saving would flip a salary into an expense.
  assert.match(screen, /transaction && transaction\.amount > 0 \? 'income' : 'spend'/);
});

test('a row is the way in, and the whole row', () => {
  // docs/DESIGN.md §8: the whole row is the hit area. A pencil icon at one end
  // is a 24px target on a screen used one-handed.
  assert.match(screen, /<button className="row"[^>]*onClick=\{\(\) => setEditing\(t\)\}/);
});

test('deleting asks once, and not with a browser dialog', () => {
  // The delete is soft in the database but has no way back from inside the app,
  // so it is worth one question. `confirm()` is the one piece of chrome this
  // app cannot style — it would be the only rounded thing on the screen.
  assert.match(screen, /confirmingDelete/);
  assert.ok(!/\bconfirm\(/.test(screen), 'a native confirm() dialog reached the interface');
  assert.match(screen, /api\.del\(`\/money\/transactions\/\$\{transaction!\.id\}`\)/);
});

test('a failed delete says so instead of closing the sheet', () => {
  const remove = screen.slice(screen.indexOf('async function remove()'));
  const body = remove.slice(0, remove.indexOf('\n  }'));
  assert.match(body, /catch/);
  assert.match(body, /setDeleteError/);
});
