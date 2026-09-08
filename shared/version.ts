/**
 * Version comparison and the update decision — pure, so it is testable.
 *
 * The deployed build publishes its identity in a static /version.json, which
 * costs no serverless function and no database round trip:
 *
 *   {
 *     "version":     "1.2.0",     the build that is live right now
 *     "released":    "2026-09-08T…",
 *     "mandatory":   false,       this release must be taken immediately
 *     "min_version": "1.0.0",     anything older than this is forced
 *     "notes":       ["…"]        what changed
 *   }
 *
 * Every open tab carries the version it was built with and polls the manifest.
 * Two outcomes, and the difference between them is the whole point:
 *
 *   soft — a newer build is live. The tab reloads itself the moment nobody is
 *          mid-action, so a half-typed transaction is never thrown away.
 *   hard — the release is marked `mandatory`, or this build has fallen below
 *          `min_version`. The tab is blocked and reloads on a countdown.
 *          A busy user gets a longer grace period, not an exemption.
 *
 * `min_version` is the lever that matters: `mandatory` forces the people who
 * happen to be online for one release, while raising the floor forces every
 * stale tab in existence, including the one that has been open since March.
 */

export interface VersionManifest {
  version: string;
  released?: string | null;
  mandatory?: boolean;
  min_version?: string | null;
  notes?: string[];
}

export interface UpdateDecision {
  /** The version the manifest says is live, or null when it could not be read. */
  latest: string | null;
  released: string | null;
  notes: string[];
  /** This build is older than the live one. */
  behind: boolean;
  /** …and it must be taken now, rather than at the next idle moment. */
  mandatory: boolean;
}

/**
 * "1.10.0" is newer than "1.9.9" — compared segment by segment, numerically.
 *
 * A missing segment counts as zero, so "1.2" and "1.2.0" are the same build,
 * and a prerelease suffix is ignored: this is a deploy counter, not semver
 * with ranges, and "1.2.0-rc1" being treated as "1.2.0" is the behaviour we
 * want when a release candidate is what actually shipped.
 */
export function parseVersion(value: unknown): number[] {
  return String(value ?? '')
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((part) => {
      const n = parseInt(part, 10);
      return Number.isNaN(n) ? 0 : n;
    });
}

export function compareVersions(a: unknown, b: unknown): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** True when `next` is strictly newer than `current`. */
export function isNewer(next: unknown, current: unknown): boolean {
  return compareVersions(next, current) > 0;
}

export function decideUpdate(current: string | null, manifest: VersionManifest | null): UpdateDecision {
  const out: UpdateDecision = { latest: null, released: null, notes: [], behind: false, mandatory: false };
  if (!manifest || typeof manifest.version !== 'string' || !manifest.version) return out;

  out.latest = manifest.version;
  out.released = typeof manifest.released === 'string' ? manifest.released : null;
  out.notes = Array.isArray(manifest.notes) ? manifest.notes : [];

  // A build that does not know its own version cannot be judged against the
  // manifest. Never nag it and — far more important — never block it: that is
  // the state a misconfigured build lands in, and blocking it would lock the
  // household out of its own budget with no way back.
  if (!current || compareVersions(current, '0.0.0') === 0) return out;

  out.behind = compareVersions(current, manifest.version) < 0;
  if (!out.behind) return out; // current, or ahead on a preview build

  const belowFloor =
    typeof manifest.min_version === 'string' &&
    !!manifest.min_version &&
    compareVersions(current, manifest.min_version) < 0;

  out.mandatory = manifest.mandatory === true || belowFloor;
  return out;
}

/** Bumps a version. The release tool's arithmetic, shared so a test can hold it. */
export function bumpVersion(current: string, kind: 'major' | 'minor' | 'patch'): string {
  const [maj = 0, min = 0, pat = 0] = parseVersion(current);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

export const VERSION_RE = /^\d+\.\d+\.\d+$/;
