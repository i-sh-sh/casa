/**
 * Who operates the pilot — and why it is not a role in the database.
 *
 * Every other permission in casa lives in `household_members.role`, per home,
 * because that is where it belongs: an owner admits members, a viewer reads.
 * This one does not, and deliberately.
 *
 * An operator is the person who can see *across* homes. Storing that as a row
 * would mean the app can grant it, which means a compromised session, a bug in
 * a PATCH handler, or a stray SQL statement could grant it — the one privilege
 * in the system where that must be impossible. It lives in an environment
 * variable instead, so the only way to become an operator is to have access to
 * the deployment itself. Nothing reachable from a request can add a name to it.
 *
 * What the privilege actually buys is narrow on purpose: counts and dates for
 * every home, and no content from any of them. See api/admin/_metrics.ts, where
 * the queries are aggregates and a test refuses anything else.
 */

/**
 * Reads CASA_OPERATORS: emails separated by commas, semicolons or whitespace.
 *
 * Lenient about separators because this is typed into a Vercel form by hand, at
 * night, on a phone — and an operator list that silently comes back empty
 * because of a trailing comma is a screen that says "you are not an operator"
 * with no way to tell why.
 */
export function parseOperators(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.includes('@'));
}

/**
 * Case-insensitive, because Google returns the address as the account was
 * created and a person typing the list into Vercel will not match its casing.
 */
export function isOperator(raw: string | null | undefined, email: string | null | undefined): boolean {
  if (!email) return false;
  return parseOperators(raw).includes(email.trim().toLowerCase());
}
