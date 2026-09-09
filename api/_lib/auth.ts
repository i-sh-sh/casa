import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { OAuth2Client } from 'google-auth-library';
import { one, query, transaction, withHousehold } from './db.js';
import { SEED_SQL } from '../admin/_seed.js';
import { forbidden, unauthorized } from './http.js';

// Sign-in is Google-only. There is no shared password anywhere in this file,
// and that is the point: a password typed at a login box is one screenshot
// away from being everyone's — and it would also be what signs the session.
//
// No fallback secret either. With JWT_SECRET unset, signing and verifying both
// fail closed, rather than accepting tokens forged with a guessable value.
const JWT_SECRET = process.env.JWT_SECRET ?? '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'casa_session';
// Which home to act in, for a person who belongs to more than one. A
// preference, not a permission — see pickHousehold.
export const HOUSEHOLD_COOKIE = 'casa_household';

export type Role = 'owner' | 'member' | 'viewer' | 'pending';

export interface SessionUser {
  email: string;
  name: string | null;
  picture: string | null;
  display_name: string | null;
  color: string | null;
  /** The home this request is acting in, and the role held *there*. */
  household_id: number;
  household_name: string;
  role: Role;
}

/** A signed-in person who does not belong to any home yet. */
export interface HomelessUser {
  email: string;
  name: string | null;
  picture: string | null;
  display_name: string | null;
  color: string | null;
  household_id: null;
}

interface JwtPayload {
  email: string;
  exp: number;
  jti: string;
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

const b64urlDecode = (input: string): string => {
  let s = input.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString();
};

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function signSession(email: string): string {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not set — nobody can sign in.');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload: JwtPayload = {
    email,
    exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
    jti: randomUUID(),
  };
  const encodedPayload = b64url(JSON.stringify(payload));
  const signature = b64url(
    createHmac('sha256', JWT_SECRET).update(`${header}.${encodedPayload}`).digest(),
  );
  return `${header}.${encodedPayload}.${signature}`;
}

export function verifySession(token: string): JwtPayload | null {
  if (!JWT_SECRET || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  const expected = b64url(createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
  if (!safeEqual(signature, expected)) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(payload)) as JwtPayload;
    if (!parsed.email || typeof parsed.exp !== 'number') return null;
    if (Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── The Google side ──────────────────────────────────────────────────────

let googleClient: OAuth2Client | undefined;

/**
 * Turns a Google ID token into an email we are willing to believe.
 *
 * `verifyIdToken` with an explicit audience is the whole security boundary
 * here: it checks Google's signature, the issuer, the expiry, AND that the
 * token was minted for *this* app. Skipping the audience check would let a
 * token issued to any other Google app log someone in here.
 */
export async function verifyGoogleToken(idToken: string): Promise<{ email: string; name: string | null; picture: string | null }> {
  if (!GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID is not set — Google sign-in cannot work.');
  googleClient ??= new OAuth2Client(GOOGLE_CLIENT_ID);
  const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload?.email) throw unauthorized('גוגל לא החזירה כתובת מייל');
  // An unverified email is an email somebody typed, not one they proved.
  if (payload.email_verified === false) throw unauthorized('כתובת המייל לא מאומתת בגוגל');
  return {
    email: payload.email.toLowerCase(),
    name: payload.name ?? null,
    picture: payload.picture ?? null,
  };
}

// ── Cookies ──────────────────────────────────────────────────────────────

export function setSessionCookie(res: VercelResponse, token: string): void {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  res.setHeader('set-cookie', [
    // HttpOnly: script on the page cannot read it, so an XSS bug does not
    // hand over the session. SameSite=Lax: it still rides a normal navigation
    // back into the app, but not a cross-site form post.
    `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
  ]);
}

export function clearSessionCookie(res: VercelResponse): void {
  res.setHeader('set-cookie', [`${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`]);
}

function readCookie(req: VercelRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// ── What the rest of the API calls ───────────────────────────────────────

/** Who is signed in, before any household is chosen. Null when nobody is. */
export function signedInEmail(req: VercelRequest): string | null {
  const token = readCookie(req, SESSION_COOKIE)
    ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (!token) return null;
  return verifySession(token)?.email ?? null;
}

export interface Membership {
  household_id: number;
  household_name: string;
  role: Role;
}

/**
 * Every home this person belongs to.
 *
 * Read without a household scope, because it is the question asked *before* one
 * is known — which is why `households` and `household_members` are the two
 * tables not under row-level security. They are read here and nowhere else.
 *
 * A database that predates households has neither table, and 42P01 here would
 * be fatal in the worst place: `/auth/me` calls this, so the app could not even
 * load far enough to offer the migration that creates them. On that one error,
 * the honest answer is "no memberships" — which is true, and which lands the
 * person on the screen with the migration button.
 */
export async function membershipsOf(email: string): Promise<Membership[]> {
  try {
    return await query<Membership>(
      `SELECT m.household_id, h.name AS household_name, m.role
         FROM household_members m
         JOIN households h ON h.id = m.household_id
        WHERE m.email = $1
        ORDER BY m.joined_at`,
      [email],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') return [];  // undefined_table: not migrated yet
    throw err;
  }
}

/**
 * The signed-in user, or null. Never throws for "not signed in".
 *
 * The role is read fresh from the database on every request, never from the
 * token. Otherwise revoking someone's access would take up to 30 days to take
 * effect — the lifetime of the session they are already holding.
 */
export async function currentUser(req: VercelRequest): Promise<SessionUser | HomelessUser | null> {
  const email = signedInEmail(req);
  if (!email) return null;

  const person = await one<{
    email: string; name: string | null; picture: string | null;
    display_name: string | null; color: string | null;
  }>(
    `SELECT email, name, picture, display_name, color FROM users WHERE email = $1`,
    [email],
  );
  if (!person) return null;

  const memberships = await membershipsOf(email);
  const chosen = pickHousehold(memberships, readCookie(req, HOUSEHOLD_COOKIE));
  if (!chosen) return { ...person, household_id: null };

  return { ...person, ...chosen };
}

/**
 * Which home a request acts in when a person belongs to more than one.
 *
 * The cookie is a preference, never an authorisation: a household the person
 * does not belong to is not in `memberships` and therefore cannot be selected,
 * whatever the cookie says.
 */
export function pickHousehold(memberships: Membership[], preferred: string | null): Membership | null {
  if (preferred) {
    const wanted = Number(preferred);
    const match = memberships.find((m) => m.household_id === wanted);
    if (match) return match;
  }
  return memberships[0] ?? null;
}

const RANK: Record<Role, number> = { pending: 0, viewer: 1, member: 2, owner: 3 };

export const hasRole = (role: Role, minimum: Role): boolean => RANK[role] >= RANK[minimum];

/**
 * The signed-in user, guaranteed to belong to a home and hold at least
 * `minimum` in it.
 *
 * 'pending' never passes: a person an owner has not admitted yet is in the
 * waiting room, not in the household.
 */
export async function requireUser(req: VercelRequest, minimum: Role = 'member'): Promise<SessionUser> {
  const user = await currentUser(req);
  if (!user) throw unauthorized();
  if (user.household_id === null) {
    throw forbidden('אתם עדיין לא שייכים לבית. פתחו בית חדש, או בקשו קישור הזמנה.');
  }
  const member = user as SessionUser;
  if (member.role === 'pending') {
    throw forbidden('החשבון שלך ממתין לאישור. בקשו מבעל הבית לאשר אותך.');
  }
  if (!hasRole(member.role, minimum)) throw forbidden();
  return member;
}

/**
 * The one authorisation that has to work before any household exists.
 *
 * There is a deadlock otherwise: the migration is what creates the
 * `households` table and adopts the existing data into the first home — but the
 * router will not run anything for a person with no home, and nobody has one
 * until the migration has run. That is not hypothetical; it is exactly the
 * state every database upgrading to this version is in.
 *
 * So this opens a window, and the window closes by itself: an owner of any
 * household passes normally, and if there are no households at all, the legacy
 * `users.role = 'owner'` passes instead. The moment the migration succeeds the
 * first household exists and the fallback stops applying. It is also the only
 * code left that reads `users.role`.
 */
export async function requireMigrator(req: VercelRequest): Promise<string> {
  const email = signedInEmail(req);
  if (!email) throw unauthorized();

  const memberships = await membershipsOf(email);
  if (memberships.some((m) => m.role === 'owner')) return email;
  if (memberships.length > 0) throw forbidden('רק בעל הבית יכול להריץ מיגרציה');

  const legacy = await one<{ role: string }>(
    `SELECT role FROM users WHERE email = $1`, [email],
  ).catch(() => null);
  const anyHousehold = await one<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM households`,
  ).catch(() => ({ count: 0 }));   // the table may not exist yet — that is the case this exists for

  if ((anyHousehold?.count ?? 0) === 0 && legacy?.role === 'owner') return email;
  throw forbidden('רק בעל הבית יכול להריץ מיגרציה');
}

/**
 * Records the sign-in. Creates a person, never a household.
 *
 * This used to hand the first person on a fresh database the keys to
 * everything, because there was one home and somebody had to own it. With more
 * than one home that shortcut becomes a race — whoever signs in first owns the
 * database — so signing in now means only that Google knows who you are.
 * Belonging is a separate, deliberate act: open a home, or open an invitation.
 */
export async function upsertUserOnSignIn(
  profile: { email: string; name: string | null; picture: string | null },
): Promise<void> {
  await query(
    `INSERT INTO users (email, name, picture, last_seen_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (email) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, users.name),
           picture = COALESCE(EXCLUDED.picture, users.picture),
           last_seen_at = NOW()`,
    [profile.email, profile.name, profile.picture],
  );
}

/**
 * Opens a home and makes this person its owner.
 *
 * Both rows or neither: a household with no owner is unreachable — nobody can
 * admit anyone to it, including themselves — and it cannot be cleaned up from
 * inside the app either.
 *
 * Runs outside any household scope, which is the point: this is what creates
 * the scope that everything else runs inside.
 */
export async function createHousehold(name: string, email: string): Promise<Membership> {
  const membership = await transaction(async (client) => {
    const created = await client.query<{ id: number; name: string }>(
      `INSERT INTO households (name, created_by) VALUES ($1, $2) RETURNING id, name`,
      [name, email],
    );
    const home = created.rows[0];
    if (!home) throw new Error('failed to create household');
    await client.query(
      `INSERT INTO household_members (household_id, email, role) VALUES ($1, $2, 'owner')`,
      [home.id, email],
    );
    return { household_id: home.id, household_name: home.name, role: 'owner' as Role };
  });

  await furnish(membership.household_id);
  return membership;
}

/**
 * A new home arrives furnished.
 *
 * The seed has existed since the first week, with a comment on it that argues
 * its own case better than this one can: «an empty budget is not a blank canvas
 * — it is homework». It was reachable from exactly one place: a button in
 * settings, visible to owners only, labelled «זריעת קטגוריות ומוצרי ברירת
 * מחדל». A couple opening casa for the first time was never going to find that,
 * and what they got instead was every screen empty at once — no categories to
 * budget, no account to hang a transaction on, no products to shop for. The
 * first evening decides whether there is a second one, and that first evening
 * was homework.
 *
 * It is done here rather than in the route so that it belongs to *creating a
 * home*, not to one path that creates one. Anything that opens a household in
 * future inherits it without having to remember.
 *
 * **A failure here does not fail the creation.** The home exists, the person is
 * its owner, and the seed is idempotent — every statement is ON CONFLICT DO
 * NOTHING, so the settings button fixes it with one press. Refusing to open a
 * home because we could not pre-fill its shopping list would be the wrong trade
 * in every direction.
 */
async function furnish(householdId: number): Promise<void> {
  try {
    await withHousehold(householdId, () => query(SEED_SQL));
  } catch (err) {
    console.error('could not furnish new household', householdId, err);
  }
}
