import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareVersions, parseVersion } from '../shared/version.ts';

const rootDir = resolve(process.cwd());

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(rootDir, path), 'utf-8'));
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(resolve(rootDir, path), JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function replaceInFile(path: string, pattern: RegExp, replacement: string): void {
  const fullPath = resolve(rootDir, path);
  const content = readFileSync(fullPath, 'utf-8');
  const next = content.replace(pattern, replacement);
  writeFileSync(fullPath, next, 'utf-8');
}

function bumpVersion(current: string, type: string): string {
  const parsed = parseVersion(current);
  if (!parsed) throw new Error(`Invalid current version: ${current}`);
  let [major, minor, patch] = parsed;

  if (type === 'patch') {
    patch++;
  } else if (type === 'minor') {
    minor++;
    patch = 0;
  } else if (type === 'major') {
    major++;
    minor = 0;
    patch = 0;
  } else if (parseVersion(type)) {
    return type;
  } else {
    throw new Error(`Unknown bump type or version format: ${type}`);
  }

  return `${major}.${minor}.${patch}`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  npm run release patch                    # 0.1.0 → 0.1.1
  npm run release minor --notes "..."      # 0.1.0 → 0.2.0
  npm run release 1.0.0 --mandatory        # Force immediate reload for all
  npm run release 1.0.0 --min same         # Lift minimum version floor to 1.0.0
  npm run release patch --dry-run          # Preview changes without writing
`);
    process.exit(0);
  }

  const bumpType = args[0]!;
  const isDryRun = args.includes('--dry-run') || process.env['npm_config_dry_run'] === 'true';
  const isMandatory = args.includes('--mandatory');

  let notes = '';
  const notesIdx = args.indexOf('--notes');
  if (notesIdx !== -1 && args[notesIdx + 1]) {
    notes = args[notesIdx + 1]!;
  }

  const pkg = readJson<{ version: string }>('package.json');
  const currentVersion = pkg.version;
  const nextVersion = bumpVersion(currentVersion, bumpType);

  if (compareVersions(nextVersion, currentVersion) <= 0) {
    throw new Error(`Cannot release version ${nextVersion}: must be greater than current version ${currentVersion}`);
  }

  let minVersion = currentVersion;
  const minIdx = args.indexOf('--min');
  if (minIdx !== -1 && args[minIdx + 1]) {
    const rawMin = args[minIdx + 1]!;
    minVersion = rawMin === 'same' ? nextVersion : rawMin;
  } else {
    // Keep existing min_version if version.json exists
    try {
      const currentManifest = readJson<{ min_version?: string }>('public/version.json');
      if (currentManifest.min_version) minVersion = currentManifest.min_version;
    } catch {
      minVersion = nextVersion;
    }
  }

  if (compareVersions(minVersion, nextVersion) > 0) {
    throw new Error(`min_version (${minVersion}) cannot be greater than release version (${nextVersion})`);
  }

  const releasedAt = new Date().toISOString();
  const manifest = {
    version: nextVersion,
    min_version: minVersion,
    mandatory: isMandatory,
    notes,
    released_at: releasedAt,
  };

  console.log(`Release plan:`);
  console.log(`  Version:     ${currentVersion} → ${nextVersion}`);
  console.log(`  Min Version: ${minVersion}`);
  console.log(`  Mandatory:   ${isMandatory}`);
  console.log(`  Notes:       ${notes || '(none)'}`);
  console.log(`  Dry run:     ${isDryRun}`);

  if (isDryRun) {
    console.log('\n[Dry Run] No files modified.');
    return;
  }

  // 1. package.json
  writeJson('package.json', { ...readJson<Record<string, unknown>>('package.json'), version: nextVersion });
  console.log(`✔ Updated package.json`);

  // 1b. package-lock.json — not optional, and not cosmetic.
  //
  // Vercel installs with `npm ci`, which refuses to run at all when the lock
  // file's version disagrees with package.json. Leaving the lock behind does
  // not produce a stale build; it produces no build, with the deploy failing
  // during install — on the release after this one, so the cause looks
  // unrelated. The version appears twice: at the root and in the "" package.
  writeJson('package-lock.json', (() => {
    const lock = readJson<Record<string, unknown>>('package-lock.json');
    const packages = lock['packages'] as Record<string, Record<string, unknown>> | undefined;
    const root = packages?.[''];
    if (root) root['version'] = nextVersion;
    return { ...lock, version: nextVersion };
  })());
  console.log(`✔ Updated package-lock.json`);

  // 2. public/version.json
  writeJson('public/version.json', manifest);
  console.log(`✔ Updated public/version.json`);

  // 3. public/sw.js
  replaceInFile('public/sw.js', /(const CACHE_NAME = ')[^']*(')/, `$1casa-v${nextVersion}$2`);
  console.log(`✔ Updated public/sw.js`);

  console.log(`\nSuccessfully prepared release v${nextVersion}!`);
  console.log(`Run git commit and push to deploy.`);
}

main();
