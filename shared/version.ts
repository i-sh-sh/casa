export interface VersionManifest {
  version: string;
  min_version: string;
  mandatory?: boolean;
  notes?: string;
  released_at?: string;
}

/**
 * Parses a semver string like "0.1.0" or "1.10.2" into its three numbers.
 *
 * The return type is a fixed triple rather than `number[]`, because this
 * project compiles with `noUncheckedIndexedAccess`: indexing a plain array
 * yields `number | undefined`, and every caller that destructures the result
 * then fails to typecheck. The length is already guaranteed two lines below —
 * the type may as well say so.
 */
export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  if (!v || typeof v !== 'string') return null;
  const parts = v.trim().split('.').map((p) => Number(p));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n) || n < 0)) {
    return null;
  }
  return parts as [number, number, number];
}

/**
 * Compares two semver versions numerically, not lexicographically.
 * Returns > 0 if v1 > v2, 0 if v1 === v2, < 0 if v1 < v2.
 */
export function compareVersions(v1: string, v2: string): number {
  const p1 = parseVersion(v1);
  const p2 = parseVersion(v2);
  if (!p1 || !p2) return 0;

  for (let i = 0; i < 3; i++) {
    const diff = (p1[i] ?? 0) - (p2[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export type UpdateAction = 'none' | 'soft' | 'hard';

/**
 * Determines what update action a tab should take given its current version and the server manifest.
 */
export function shouldUpdate(currentVersion: string | null | undefined, manifest: VersionManifest | null | undefined): UpdateAction {
  if (!currentVersion || !manifest || !manifest.version) return 'none';

  const currentParsed = parseVersion(currentVersion);
  const manifestParsed = parseVersion(manifest.version);
  if (!currentParsed || !manifestParsed) return 'none';

  // If local version is equal or newer than manifest, no update needed
  if (compareVersions(currentVersion, manifest.version) >= 0) {
    return 'none';
  }

  // Mandatory flag or current version below min_version -> hard update
  if (manifest.mandatory || (manifest.min_version && compareVersions(currentVersion, manifest.min_version) < 0)) {
    return 'hard';
  }

  return 'soft';
}
