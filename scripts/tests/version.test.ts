import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareVersions, parseVersion, shouldUpdate } from '../../shared/version.ts';

const root = resolve(process.cwd());

test('parseVersion extracts three numeric components', () => {
  assert.deepEqual(parseVersion('0.1.0'), [0, 1, 0]);
  assert.deepEqual(parseVersion('1.10.2'), [1, 10, 2]);
  assert.equal(parseVersion('invalid'), null);
  assert.equal(parseVersion('1.0'), null);
  assert.equal(parseVersion(undefined), null);
});

test('compareVersions performs numerical, not lexicographical comparison', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0, '1.10.0 must be greater than 1.9.9');
  assert.ok(compareVersions('0.1.0', '0.1.1') < 0);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
});

test('shouldUpdate returns none when local version matches or exceeds manifest version', () => {
  const manifest = { version: '0.1.0', min_version: '0.1.0' };
  assert.equal(shouldUpdate('0.1.0', manifest), 'none');
  assert.equal(shouldUpdate('0.2.0', manifest), 'none', 'ahead of manifest');
});

test('shouldUpdate returns soft for standard patch/minor releases', () => {
  const manifest = { version: '0.1.1', min_version: '0.1.0' };
  assert.equal(shouldUpdate('0.1.0', manifest), 'soft');
});

test('shouldUpdate returns hard when mandatory flag is set', () => {
  const manifest = { version: '0.1.1', min_version: '0.1.0', mandatory: true };
  assert.equal(shouldUpdate('0.1.0', manifest), 'hard');
});

test('shouldUpdate returns hard when local version is below min_version', () => {
  const manifest = { version: '1.0.0', min_version: '0.2.0' };
  assert.equal(shouldUpdate('0.1.0', manifest), 'hard');
});

test('package.json and public/version.json versions must be identical', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
  const ver = JSON.parse(readFileSync(resolve(root, 'public/version.json'), 'utf-8'));
  assert.equal(pkg.version, ver.version, 'package.json and version.json must agree');
});

test('package-lock.json carries the same version, in both places it appears', () => {
  // Vercel installs with `npm ci`, which refuses to run at all when the lock
  // disagrees with package.json. A release that forgets the lock does not ship
  // a stale build — it fails the *next* deploy during install, with an error
  // that names neither the release nor the version.
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf-8'));
  assert.equal(lock.version, pkg.version, 'package-lock.json root version is behind');
  assert.equal(lock.packages?.['']?.version, pkg.version, 'package-lock.json packages[""] version is behind');
});

test('parseVersion returns a fixed triple, so destructuring it typechecks', () => {
  // Under noUncheckedIndexedAccess a `number[]` return makes every caller that
  // writes `const [major, minor, patch] = parsed` fail to compile — which is
  // exactly how the release tool stopped typechecking.
  const parsed = parseVersion('1.2.3');
  assert.ok(parsed);
  const [major, minor, patch] = parsed;
  assert.deepEqual([major, minor, patch], [1, 2, 3]);
});

test('public/sw.js CACHE_NAME contains the version from package.json', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
  const sw = readFileSync(resolve(root, 'public/sw.js'), 'utf-8');
  assert.match(sw, new RegExp(`const CACHE_NAME = ['"]casa-v${pkg.version}['"];`));
});
