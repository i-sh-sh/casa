#!/usr/bin/env node
/**
 * Release tool — sets one version number everywhere it has to appear.
 *
 * The version lives in three places that must never disagree: package.json,
 * package-lock.json, and public/version.json (the manifest running tabs poll).
 * This writes all of them from one argument.
 *
 * Unlike the wedding system it is descended from, nothing patches HTML: casa
 * is a single-page build, so the running version is injected by Vite from
 * package.json at build time (see `__APP_VERSION__` in vite.config.ts). One
 * fewer file to keep in step, and no way for a page to carry a stale constant.
 *
 *   node scripts/release.ts patch          0.1.0 → 0.1.1
 *   node scripts/release.ts minor          0.1.0 → 0.2.0
 *   node scripts/release.ts major          0.1.0 → 1.0.0
 *   node scripts/release.ts 0.4.0          explicit
 *
 * Update policy:
 *   --mandatory      force this release: every open tab blocks and reloads
 *                    within a minute of the deploy.
 *   --no-mandatory   clear the flag (the default for a normal release).
 *   --min <version>  raise the floor: every build older than <version> is
 *                    forced, not just the ones online for this release.
 *                    `--min same` uses the version being released.
 *   --notes "text"   a line shown in settings and in the forced-update
 *                    dialog. Repeatable. Replaces the previous notes.
 *   --dry-run        print what would change, write nothing.
 *
 * Nothing takes effect until it is deployed. The manifest is a static file,
 * so "forcing" an update means shipping a build that says so.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bumpVersion, compareVersions, VERSION_RE } from '../shared/version.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'package.json');
const LOCK = join(ROOT, 'package-lock.json');
const MANIFEST = join(ROOT, 'public', 'version.json');

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n').filter((l) => l.startsWith(' *')).map((l) => l.slice(3)).join('\n'),
  );
  process.exit(0);
}

const opts: { mandatory: boolean | null; min: string | null; notes: string[]; dryRun: boolean; target: string | null } =
  { mandatory: null, min: null, notes: [], dryRun: false, target: null };

for (let i = 0; i < argv.length; i++) {
  const a = argv[i] as string;
  if (a === '--mandatory') opts.mandatory = true;
  else if (a === '--no-mandatory') opts.mandatory = false;
  else if (a === '--min') opts.min = argv[++i] ?? null;
  else if (a === '--notes') opts.notes.push(argv[++i] ?? '');
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a.startsWith('-')) fail(`Unknown flag: ${a}`);
  else if (opts.target) fail(`Unexpected argument: ${a}`);
  else opts.target = a;
}
if (!opts.target) fail('Missing version or bump keyword (patch | minor | major | X.Y.Z)');

const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as { version: string };
const from = pkg.version;
const next = (['patch', 'minor', 'major'] as const).includes(opts.target as never)
  ? bumpVersion(from, opts.target as 'patch' | 'minor' | 'major')
  : opts.target;

if (!VERSION_RE.test(next)) fail(`Not a valid version: "${next}" (expected X.Y.Z)`);

// Going backwards would leave every running tab thinking it is ahead of the
// deploy — and a tab that believes it is ahead never updates again.
if (compareVersions(next, from) <= 0) fail(`Version must move forward: ${from} → ${next}`);

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
  min_version?: string; notes?: string[];
};

let minVersion = manifest.min_version || '0.0.0';
if (opts.min) {
  const requested = opts.min === 'same' ? next : opts.min;
  if (!VERSION_RE.test(requested)) fail(`--min expects X.Y.Z (or "same"), got "${opts.min}"`);
  // A floor above the release would force a build that does not exist yet, and
  // every tab would block forever with nothing to upgrade to.
  if (compareVersions(requested, next) > 0) fail(`--min ${requested} is newer than the release ${next}`);
  minVersion = requested;
}

const mandatory = opts.mandatory === null ? false : opts.mandatory;
const notes = opts.notes.length ? opts.notes : (manifest.notes ?? []);

const edits: { file: string; after: string }[] = [];

// package.json — keep the file's own formatting decisions intact.
{
  const before = readFileSync(PKG, 'utf8');
  const after = before.replace(/("version":\s*")[^"]*(")/, `$1${next}$2`);
  if (after === before) fail('Could not find "version" in package.json');
  edits.push({ file: PKG, after });
}

// package-lock.json — npm records the version twice; leaving either behind
// makes the next `npm install` rewrite the file underneath you.
{
  const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as { version?: string; packages?: Record<string, { version?: string }> };
  lock.version = next;
  if (lock.packages?.['']) lock.packages[''].version = next;
  edits.push({ file: LOCK, after: `${JSON.stringify(lock, null, 2)}\n` });
}

edits.push({
  file: MANIFEST,
  after: `${JSON.stringify({ version: next, released: new Date().toISOString(), mandatory, min_version: minVersion, notes }, null, 2)}\n`,
});

console.log(`\n  ${from}  →  ${next}${mandatory ? '   [עדכון חובה]' : ''}`);
console.log(`  min_version: ${minVersion}${minVersion === next ? '   (forces every older build)' : ''}`);
if (notes.length) console.log(`  notes:\n${notes.map((n) => `    · ${n}`).join('\n')}`);
console.log('');
for (const { file } of edits) console.log(`  ${opts.dryRun ? 'would write' : 'wrote'}  ${file.replace(`${ROOT}/`, '')}`);

if (opts.dryRun) {
  console.log('\n  --dry-run: nothing written.\n');
  process.exit(0);
}
for (const { file, after } of edits) writeFileSync(file, after);

console.log(`
  Next: commit and deploy. Open tabs notice within ~60s and reload${mandatory ? ' — blocked until they do.' : ' once nobody is mid-action.'}
`);
