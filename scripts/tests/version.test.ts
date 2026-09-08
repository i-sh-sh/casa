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

test('public/sw.js CACHE_NAME contains the version from package.json', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
  const sw = readFileSync(resolve(root, 'public/sw.js'), 'utf-8');
  assert.match(sw, new RegExp(`const CACHE_NAME = ['"]casa-v${pkg.version}['"];`));
});
