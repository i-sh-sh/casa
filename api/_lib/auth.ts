import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { OAuth2Client } from 'google-auth-library';
import { one, query } from './db.js';
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

export type Role = 'owner' | 'member' | 'viewer' | 'pending';

export interface SessionUser {
  email: string;
  name: string | null;
  picture: string | null;
  role: Role;
  display_name: string | null;
  color: string | null;
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

/** The signed-in user, or null. Never throws for "not signed in". */
export async function currentUser(req: VercelRequest): Promise<SessionUser | null> {
  const token = readCookie(req, SESSION_COOKIE)
    ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if (!token) return null;
  const payload = verifySession(token);
  if (!payload) return null;
  // The role is read fresh from the database on every request, never from the
  // token. Otherwise revoking someone's access would take up to 30 days to
  // take effect — the lifetime of the session they are already holding.
  return await one<SessionUser>(
    `SELECT email, name, picture, role, display_name, color FROM users WHERE email = $1`,
    [payload.email],
  );
}

const RANK: Record<Role, number> = { pending: 0, viewer: 1, member: 2, owner: 3 };

/**
 * The signed-in user, guaranteed to hold at least `minimum`.
 *
 * 'pending' never passes: a stranger who signed in with Google is a person in
 * the waiting room, not a household member.
 */
export async function requireUser(req: VercelRequest, minimum: Role = 'member'): Promise<SessionUser> {
  const user = await currentUser(req);
  if (!user) throw unauthorized();
  if (user.role === 'pending') {
    throw forbidden('החשבון שלך ממתין לאישור. בקשו מבעל הבית לאשר אותך.');
  }
  if (RANK[user.role] < RANK[minimum]) throw forbidden();
  return user;
}

/**
 * Records the sign-in, and hands the very first person the keys.
 *
 * Somebody has to be the owner, and there is no console to promote them from.
 * The first successful Google sign-in on a fresh database becomes the owner;
 * every sign-in after that lands on 'pending' and waits. The window this opens
 * is exactly the gap between deploying and signing in once — so sign in first.
 */
export async function upsertUserOnSignIn(profile: { email: string; name: string | null; picture: string | null }): Promise<SessionUser> {
  const existing = await one<SessionUser>(`SELECT email, name, picture, role, display_name, color FROM users WHERE email = $1`, [profile.email]);
  if (existing) {
    await query(
      `UPDATE users SET name = COALESCE($2, name), picture = COALESCE($3, picture), last_seen_at = NOW() WHERE email = $1`,
      [profile.email, profile.name, profile.picture],
    );
    return { ...existing, name: profile.name ?? existing.name, picture: profile.picture ?? existing.picture };
  }

  const tally = await one<{ count: number }>(`SELECT COUNT(*)::int AS count FROM users`);
  const role: Role = (tally?.count ?? 0) === 0 ? 'owner' : 'pending';
  const created = await one<SessionUser>(
    `INSERT INTO users (email, name, picture, role, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (email) DO UPDATE SET last_seen_at = NOW()
     RETURNING email, name, picture, role, display_name, color`,
    [profile.email, profile.name, profile.picture, role],
  );
  if (!created) throw new Error('failed to create user row');
  return created;
}
