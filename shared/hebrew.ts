/**
 * A home's name after ל or ב.
 *
 * Every home now starts as «הבית של יוסי», and Hebrew folds the article into
 * the preposition: «לבית של יוסי», never «להבית». Only that one opening word is
 * folded, because a name that merely starts with ה («הדס והבנות») keeps it,
 * and the app cannot tell an article from a first letter in general.
 */
export function afterPrefix(name: string): string {
  return /^הבית(\s|$)/.test(name) ? name.slice(1) : name;
}
