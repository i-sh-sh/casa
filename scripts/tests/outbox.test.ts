import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffMs, classify, discard, EMPTY, enqueue, head, MAX_ATTEMPTS,
  parked, parkStale, pendingCount, pendingSubjects, resolve, retryAll, STALE_MS,
} from '../../shared/outbox.ts';

const tick = (id: string, subject?: string) =>
  ({ id, verb: 'POST' as const, path: `/shopping/items/${id}/buy`, subject });

// Reception in a supermarket is not off — it is slow and intermittent, and the
// failure that matters is the request that succeeded and said nothing. Every
// test here is about that request.

test('a tick queued twice is one tick', () => {
  // One tap can reach this twice: a re-render, a double press, a retry of the
  // enqueue itself. Two ticks would consume the stock twice.
  const box = enqueue(enqueue(EMPTY, tick('a')), tick('a'));
  assert.equal(box.actions.length, 1);
  assert.equal(pendingCount(box), 1);
});

test('order is preserved, because a tick and an untick are not commutative', () => {
  let box = enqueue(EMPTY, tick('1'));
  box = enqueue(box, { id: '2', verb: 'POST', path: '/shopping/items/1/unbuy' });
  assert.equal(head(box)?.id, '1');
  box = resolve(box, '1', { kind: 'done' });
  assert.equal(head(box)?.id, '2');
});

test('a 404 on a buy means it already happened', () => {
  // The handler matches `status = 'open'`, so the second attempt finds nothing
  // — which is exactly what a successful first attempt leaves behind. Parking
  // it would show a red error for an item correctly bought and in the pantry.
  assert.deepEqual(
    classify(404, 'הפריט לא נמצא ברשימה הפתוחה'),
    { kind: 'done' },
  );
});

test('a 404 from a path that does not exist is parked, not swallowed', () => {
  // Otherwise a routing bug looks exactly like a successful shop.
  const out = classify(404, 'אין נתיב כזה: /api/shopping/oops');
  assert.equal(out.kind, 'park');
});

test('no response at all is a retry and does not count as a failure', () => {
  assert.deepEqual(classify(0), { kind: 'retry' });
});

test('an expired session is a retry, never a discard', () => {
  // A session that died in the aisle comes back when the app refreshes it.
  // Dropping the tick would be the one unrecoverable outcome.
  assert.deepEqual(classify(401), { kind: 'retry' });
});

test('a validation error is parked rather than retried forever', () => {
  // It will fail identically every time, and a queue that keeps retrying it
  // blocks every action behind it — the whole list stuck on one bad line.
  const out = classify(400, 'כמות חייבת להיות מספר');
  assert.deepEqual(out, { kind: 'park', reason: 'כמות חייבת להיות מספר' });
});

test('a server error is a retry', () => {
  assert.deepEqual(classify(503), { kind: 'retry' });
  assert.deepEqual(classify(500), { kind: 'retry' });
});

test('success removes the action; retry keeps it and counts', () => {
  let box = enqueue(EMPTY, tick('a'));
  box = resolve(box, 'a', { kind: 'retry' });
  assert.equal(box.actions[0]?.attempts, 1);
  assert.equal(pendingCount(box), 1);
  box = resolve(box, 'a', { kind: 'done' });
  assert.equal(box.actions.length, 0);
});

test('a retry that never succeeds eventually parks itself', () => {
  // Without this, one broken action silently blocks the queue behind it.
  let box = enqueue(EMPTY, tick('a'));
  for (let i = 0; i < MAX_ATTEMPTS; i++) box = resolve(box, 'a', { kind: 'retry' });
  assert.equal(pendingCount(box), 0);
  assert.equal(parked(box).length, 1);
  assert.match(parked(box)[0]!.failure!, /לא הצלחנו/);
  // And it is still there — parked, not lost. Nothing disappears silently.
  assert.equal(box.actions.length, 1);
});

test('a parked action does not block the ones behind it', () => {
  let box = enqueue(EMPTY, tick('bad'));
  box = enqueue(box, tick('good'));
  box = resolve(box, 'bad', { kind: 'park', reason: 'שגיאה' });
  assert.equal(head(box)?.id, 'good');
});

test('parked actions can be retried or given up on, by hand', () => {
  let box = resolve(enqueue(EMPTY, tick('a')), 'a', { kind: 'park', reason: 'x' });
  assert.equal(head(box), null);

  const again = retryAll(box);
  assert.equal(head(again)?.id, 'a');
  assert.equal(again.actions[0]?.attempts, 0);

  assert.equal(discard(box, 'a').actions.length, 0);
});

test('a tick from three days ago is parked with a reason, not replayed', () => {
  // Replayed into a list that has moved on, it does more harm than it was
  // worth — but a person has to be told their shopping never saved.
  let box = enqueue(EMPTY, tick('old'));
  box = { actions: box.actions.map((a) => ({ ...a, queuedAt: Date.now() - STALE_MS - 1000 })) };
  box = parkStale(box);
  assert.equal(pendingCount(box), 0);
  assert.match(parked(box)[0]!.failure!, /חיכתה יותר מדי זמן/);
});

test('a fresh action survives the staleness sweep', () => {
  const box = parkStale(enqueue(EMPTY, tick('new')));
  assert.equal(pendingCount(box), 1);
});

test('pending subjects mark the rows the list should show as in-flight', () => {
  let box = enqueue(EMPTY, tick('a', 'item:12'));
  box = enqueue(box, tick('b', 'item:13'));
  assert.deepEqual([...pendingSubjects(box)].sort(), ['item:12', 'item:13']);
  box = resolve(box, 'a', { kind: 'done' });
  assert.deepEqual([...pendingSubjects(box)], ['item:13']);
});

test('backoff climbs and then stops climbing', () => {
  assert.equal(backoffMs(0), 1000);
  assert.equal(backoffMs(1), 2000);
  assert.ok(backoffMs(10) <= 30_000, 'the wait must stay short — the person is still in the shop');
  assert.ok(backoffMs(3) > backoffMs(2));
});

test('every function returns a new outbox and mutates nothing', () => {
  // The runtime keeps this in React state and in localStorage; a mutation in
  // place would show a stale list and persist the wrong thing.
  const box = enqueue(EMPTY, tick('a'));
  const before = JSON.stringify(box);
  resolve(box, 'a', { kind: 'retry' });
  discard(box, 'a');
  retryAll(box);
  parkStale(box);
  assert.equal(JSON.stringify(box), before);
  assert.equal(EMPTY.actions.length, 0);
});
