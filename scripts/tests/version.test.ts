import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bumpVersion, compareVersions, decideUpdate, isNewer, parseVersion, VERSION_RE } from '../../shared/version.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

// ── Comparison ───────────────────────────────────────────────────────────

test('versions compare numerically, not as text', () => {
  // The bug this exists to prevent: "1.10.0" < "1.9.9" under string ordering,
  // so the tenth release of a line would look older than the ninth and every
  // tab would quietly stop updating.
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('a missing segment is a zero, and a prerelease suffix is ignored', () => {
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1.2.0-rc1', '1.2.0'), 0, 'a release candidate that shipped is that release');
  assert.equal(compareVersions('v1.3.0', '1.3.0'), 0, 'a leading v is noise');
});

test('garbage compares as zero rather than throwing', () => {
  // This runs in a tab that must keep working. A malformed manifest is a
  // reason to do nothing, never a reason to crash the page that read it.
  assert.deepEqual(parseVersion(null), [0]);
  assert.deepEqual(parseVersion('abc'), [0]);
  assert.equal(compareVersions(undefined, '1.0.0'), -1);
  assert.equal(isNewer('1.0.1', '1.0.0'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
});

// ── The decision ─────────────────────────────────────────────────────────

const manifest = (over: Record<string, unknown> = {}) => ({
  version: '1.2.0', released: '2026-09-08T10:00:00Z', mandatory: false,
  min_version: '1.0.0', notes: ['משהו'], ...over,
});

test('a current build is left alone', () => {
  const d = decideUpdate('1.2.0', manifest());
  assert.equal(d.behind, false);
  assert.equal(d.mandatory, false);
  assert.equal(d.latest, '1.2.0');
});

test('an older build is behind, but not forced by default', () => {
  const d = decideUpdate('1.1.0', manifest());
  assert.equal(d.behind, true);
  assert.equal(d.mandatory, false, 'a normal release waits for an idle moment');
});

test('a release marked mandatory forces whoever is online for it', () => {
  const d = decideUpdate('1.1.0', manifest({ mandatory: true }));
  assert.equal(d.mandatory, true);
});

test('min_version forces every stale tab, including the one open since March', () => {
  // The difference that matters: `mandatory` catches the people who happen to
  // be online for one release; raising the floor catches everyone at once.
  const d = decideUpdate('0.9.0', manifest({ mandatory: false, min_version: '1.0.0' }));
  assert.equal(d.mandatory, true);
  assert.equal(decideUpdate('1.1.0', manifest({ min_version: '1.0.0' })).mandatory, false,
    'a build above the floor is not forced by the floor');
});

test('a build ahead of the manifest is never touched', () => {
  // A preview deployment is newer than production's manifest. Reloading it
  // would throw the reviewer back onto the old build, repeatedly.
  const d = decideUpdate('2.0.0', manifest());
  assert.equal(d.behind, false);
  assert.equal(d.mandatory, false);
});

test('a build that does not know its own version is never blocked', () => {
  // This is the state a misconfigured build lands in. Blocking it would lock
  // the household out of its own budget with no way back in.
  for (const unknown of [null, '', '0.0.0']) {
    const d = decideUpdate(unknown, manifest({ mandatory: true, min_version: '9.9.9' }));
    assert.equal(d.mandatory, false, `"${unknown}" must not be forced`);
    assert.equal(d.behind, false);
  }
});

test('an unreadable manifest decides nothing', () => {
  for (const bad of [null, {} as never, { version: '' } as never]) {
    const d = decideUpdate('1.0.0', bad);
    assert.equal(d.behind, false);
    assert.equal(d.mandatory, false);
    assert.equal(d.latest, null);
  }
});

// ── Bumping ──────────────────────────────────────────────────────────────

test('bumping moves exactly one segment and zeroes the rest', () => {
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(bumpVersion('1.9.9', 'minor'), '1.10.0');
});

// ── The shipped manifest ─────────────────────────────────────────────────

test('package.json and public/version.json agree', () => {
  // They are written together by the release tool. If they can drift, the app
  // compares itself against a number nobody set, and either nags forever or
  // never updates again.
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const live = JSON.parse(read('public/version.json')) as { version: string; min_version: string };
  assert.match(pkg.version, VERSION_RE, 'package.json version must be X.Y.Z');
  assert.equal(live.version, pkg.version, 'run `npm run release` rather than editing either by hand');
  assert.match(live.min_version, VERSION_RE);
  assert.ok(
    compareVersions(live.min_version, live.version) <= 0,
    'min_version must never be newer than the release — that would force a build nobody can reach',
  );
});
