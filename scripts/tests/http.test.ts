import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * api/_lib/http.ts is asserted on as text rather than executed.
 *
 * It imports `./db.js` and `./alert.js` — the `.js` specifiers the bundler
 * resolves to `.ts` and `node --test` does not — so it cannot be loaded here at
 * all. That is not an accident of tooling to shrug at: the one file in the
 * error path that no test could reach is exactly where the bug below lived for
 * a release. Reading it is worse than running it, and much better than nothing.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

const http = code(readFileSync(join(root, 'api/_lib/http.ts'), 'utf-8'));

/** The body of `handler`'s catch block, where every failure is disposed of. */
function catchBody(): string {
  const start = http.indexOf('} catch (err) {');
  assert.ok(start > 0, 'the handler no longer has a catch block to read');
  return http.slice(start);
}

test('every 5xx pages us before it answers', () => {
  // The failure this exists for: describeDbError learned to name 28P01, which
  // turned that failure into an early `return` on a 503 — several lines above
  // the alert. The chat went quiet for the exact error being chased, and the
  // silence read as "Telegram is misconfigured" rather than "this branch never
  // reaches the sender".
  //
  // So: split the catch block at each response, and require that every branch
  // answering 5xx has already called the alert.
  const body = catchBody();
  const chunks = body.split(/json\(res,\s*/);
  assert.ok(chunks.length >= 4, 'expected several response branches to check');

  let checked = 0;
  for (let i = 1; i < chunks.length; i++) {
    const status = Number(/^(\d{3})/.exec(chunks[i]!)?.[1]);
    if (!(status >= 500)) continue; // `err.status` and the 4xx branches are not ours

    // Only this branch's own lead-in. Everything up to the previous `return;`
    // belongs to the branch above, and counting its alert as this one's is how
    // the first version of this test passed against the very bug it names.
    const before = chunks[i - 1]!;
    const previousExit = before.lastIndexOf('return;');
    const lead = previousExit >= 0 ? before.slice(previousExit) : before;

    assert.match(
      lead, /await\s+(page|alertServerError)\(/,
      `a ${status} is answered without this branch alerting us first`,
    );
    checked++;
  }
  assert.ok(checked >= 3, `expected isolation, database and generic branches, saw ${checked}`);
});

test('an HttpError is deliberately not paged', () => {
  // A 404 for a deleted item and a 403 for a viewer are the app working. Paging
  // those would bury the one message that means something — the whole reason
  // the rule above is "every 5xx" and not "every error".
  const body = catchBody();
  const start = body.indexOf('err instanceof HttpError');
  assert.ok(start > 0, 'the HttpError branch is gone');
  // The branch itself, not everything up to the next one: the shared `page`
  // helper is declared below it and would otherwise be read as part of it.
  const httpErrorBranch = body.slice(start, body.indexOf('return;', start));
  assert.ok(httpErrorBranch.includes('err.status'), 'sliced the wrong branch');
  assert.ok(!httpErrorBranch.includes('alertServerError'));
  assert.ok(!httpErrorBranch.includes('page()'));
});

test('the alert is awaited, not fired into a freezing instance', () => {
  // A serverless function is frozen once the response is written, so a fetch
  // still in flight is abandoned. `void alertServerError(...)` on an error path
  // is a message that arrives only when the instance happens to survive.
  const body = catchBody();
  assert.ok(!/void\s+alertServerError/.test(body), 'the alert is fired and abandoned');
  assert.match(body, /await\s+(alertServerError|page)\(/);
});

test('the sender cannot hold a request open indefinitely', () => {
  const alert = code(readFileSync(join(root, 'api/_lib/alert.ts'), 'utf-8'));
  // Awaiting is only safe because the wait is bounded.
  assert.match(alert, /AbortSignal\.timeout/);
  assert.match(alert, /signal:/);
});
