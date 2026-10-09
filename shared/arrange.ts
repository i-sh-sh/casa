/**
 * Arranging the budget's own structure: which groups, in what order, and
 * which categories in each.
 *
 * The seed names thirty categories in eight groups so that the first screen
 * is not homework (api/admin/_seed.ts). That is only a fair offer if every one
 * of them can be renamed, moved and put away by the household, without a file
 * round trip — renaming in the Excel file creates a second category and splits
 * the history in two, because the import matches by group and name.
 */

import type { Category, CategoryGroup } from './types.js';

export interface ArrangedGroup {
  /** null for the categories that belong to no group. */
  group: CategoryGroup | null;
  categories: Category[];
}

export interface Arrangement {
  groups: ArrangedGroup[];
  archivedGroups: CategoryGroup[];
  archivedCategories: Category[];
}

const byOrder = <T extends { sort_order: number; id: number }>(a: T, b: T) =>
  a.sort_order - b.sort_order || a.id - b.id;

/**
 * Open groups in their order, each with its open categories in theirs.
 *
 * A category whose group was archived is shown under no group rather than
 * hidden with it: a group can only be archived empty (see `groupArchiveBlock`),
 * so this is a guard against data the app did not write, not a path it takes.
 */
export function arrange(groups: CategoryGroup[], categories: Category[]): Arrangement {
  const open = groups.filter((g) => !g.archived_at).sort(byOrder);
  const openIds = new Set(open.map((g) => g.id));
  const live = categories.filter((c) => !c.archived_at).sort(byOrder);

  const arranged: ArrangedGroup[] = open.map((group) => ({
    group,
    categories: live.filter((c) => c.group_id === group.id),
  }));
  const loose = live.filter((c) => c.group_id == null || !openIds.has(c.group_id));
  if (loose.length > 0) arranged.push({ group: null, categories: loose });

  return {
    groups: arranged,
    archivedGroups: groups.filter((g) => g.archived_at).sort(byOrder),
    archivedCategories: categories.filter((c) => c.archived_at).sort((a, b) => a.name.localeCompare(b.name, 'he')),
  };
}

/**
 * One step up or down. At either end the list comes back unchanged, so a
 * double tap on «למעלה» at the top is a no-op rather than a wrap-around.
 */
export function moveInList(ids: number[], id: number, direction: -1 | 1): number[] {
  const at = ids.indexOf(id);
  const to = at + direction;
  if (at < 0 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  next[at] = ids[to]!;
  next[to] = id;
  return next;
}

/**
 * What a screen reader hears after a move, and what a sighted person can
 * check against: the position in words, since the motion itself is not shown.
 */
export function movedAnnouncement(name: string, ids: number[], id: number, where: string): string {
  return `${name} עכשיו במקום ${ids.indexOf(id) + 1} מתוך ${ids.length} ב${where}`;
}

/**
 * Why a group cannot be archived yet, or null when it can.
 *
 * Archiving a group with categories in it would either take them along — and
 * a category nobody chose to archive would vanish from the budget — or leave
 * them stranded under no group. Neither is something a person asked for, so
 * the group has to be emptied first, and the sentence says so.
 */
export function groupArchiveBlock(openCategories: number): string | null {
  if (openCategories === 0) return null;
  return openCategories === 1
    ? 'יש בקבוצה סעיף אחד. צריך להעביר אותו לקבוצה אחרת או לארכיון קודם.'
    : `יש בקבוצה ${openCategories} סעיפים. צריך להעביר אותם לקבוצה אחרת או לארכיון קודם.`;
}
