import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomBytes } from 'node:crypto';
import {
  clearSessionCookie, createHousehold, currentUser, hasRole, HOUSEHOLD_COOKIE,
  membershipsOf, setSessionCookie, signedInEmail, signSession,
  upsertUserOnSignIn, verifyGoogleToken, type SessionUser,
} from '../_lib/auth.js';
import { badRequest, forbidden, handler, json, notFound, unauthorized } from '../_lib/http.js';
import { body as parseBody } from '../_lib/http.js';
import { str } from '../_lib/validate.js';
import { one, query, transaction } from '../_lib/db.js';
import { isOperator } from '../../shared/operators.js';

// The endpoints that cannot themselves require a household, which is why they
// live outside the module routers.
//
// Everything here reads `households`, `household_members` and
// `household_invites` — the three tables deliberately left outside row-level
// security, because "which homes does this person belong to" is the question
// asked *before* a home is known. They are scoped by hand, and this is the only
// file allowed to do that: every `WHERE household_id` below is load-bearing.

const INVITE_DAYS = 7;

async function signIn(req: VercelRequest, res: VercelResponse): Promise<void> {
  const credential = str(parseBody(req)['credential'], 'credential', { max: 4000 });
  const profile = await verifyGoogleToken(credential);
  await upsertUserOnSignIn(profile);
  setSessionCookie(res, signSession(profile.email));
  // A person with no household still gets a session, on purpose: they need one
  // to open an invitation or to create a home. It grants nothing on its own —
  // requireUser refuses anyone without a membership everywhere else.
  json(res, 200, { ok: true });
}

async function signOut(_req: VercelRequest, res: VercelResponse): Promise<void> {
  clearSessionCookie(res);
  json(res, 200, { ok: true });
}

async function me(req: VercelRequest, res: VercelResponse): Promise<void> {
  const user = await currentUser(req);
  const google_client_id = process.env.GOOGLE_CLIENT_ID ?? null;

  if (!user) {
    json(res, 200, { user: null, members: [], households: [], google_client_id });
    return;
  }

  // Whether to offer the pilot screen at all. It is a hint for the interface,
  // never the authorisation: /api/admin/metrics checks the same list itself, so
  // a forged `is_operator` in a response buys nothing.
  const is_operator = isOperator(process.env.CASA_OPERATORS, user.email);

  const households = await membershipsOf(user.email);

  if (user.household_id === null) {
    json(res, 200, { user, members: [], households, google_client_id, is_operator });
    return;
  }

  // The roster travels with the session: every screen that shows "who paid"
  // needs it, and none of them should have to ask separately.
  const members = await query(
    `SELECT u.email,
            COALESCE(u.display_name, u.name, split_part(u.email, '@', 1)) AS display_name,
            u.color, m.role
       FROM household_members m
       JOIN users u ON u.email = m.email
      WHERE m.household_id = $1 AND m.role IN ('owner', 'member')
      ORDER BY m.joined_at`,
    [user.household_id],
  );
  json(res, 200, { user, members, households, google_client_id, is_operator });
}

/** Opens a new home. Anyone signed in may — they can only ever see their own. */
async function openHousehold(req: VercelRequest, res: VercelResponse): Promise<void> {
  const email = signedInEmail(req);
  if (!email) throw unauthorized();
  const name = str(parseBody(req)['name'], 'שם הבית', { max: 60 });

  const membership = await createHousehold(name, email);
  setHouseholdCookie(res, membership.household_id);
  json(res, 201, { household: membership });
}

/** Switches which home this person is acting in. */
async function switchHousehold(req: VercelRequest, res: VercelResponse): Promise<void> {
  const email = signedInEmail(req);
  if (!email) throw unauthorized();
  const wanted = Number(parseBody(req)['household_id']);

  // Membership is checked here, not trusted from the cookie: the cookie says
  // which home is preferred, never which one is permitted.
  const membership = (await membershipsOf(email)).find((m) => m.household_id === wanted);
  if (!membership) throw notFound('אתם לא שייכים לבית הזה');

  setHouseholdCookie(res, membership.household_id);
  json(res, 200, { household: membership });
}

/**
 * Mints an invitation link.
 *
 * A token rather than an email address: inviting by address means guessing
 * which of a person's Google accounts they will actually sign in with, and
 * getting it wrong strands them in a waiting room with no way to explain why.
 * A link they open while signed in cannot be addressed to the wrong account.
 */
async function createInvite(req: VercelRequest, res: VercelResponse): Promise<void> {
  const user = await requireMember(req, 'owner');
  const role = parseBody(req)['role'] === 'viewer' ? 'viewer' : 'member';

  const token = randomBytes(24).toString('base64url');
  await query(
    `INSERT INTO household_invites (token, household_id, role, created_by, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::interval)`,
    [token, user.household_id, role, user.email, String(INVITE_DAYS)],
  );
  json(res, 201, { token, role, expires_in_days: INVITE_DAYS });
}

/** What an invitation link says about itself, before anyone accepts it. */
async function readInvite(req: VercelRequest, res: VercelResponse): Promise<void> {
  const token = String((req.query as Record<string, unknown>)['token'] ?? '');
  const invite = await one<{ household_name: string; role: string; spent: boolean }>(
    `SELECT h.name AS household_name, i.role,
            (i.accepted_at IS NOT NULL OR i.expires_at < NOW()) AS spent
       FROM household_invites i
       JOIN households h ON h.id = i.household_id
      WHERE i.token = $1`,
    [token],
  );
  if (!invite) throw notFound('ההזמנה לא נמצאה');
  json(res, 200, invite);
}

/**
 * Accepts an invitation.
 *
 * The token is spent and the membership created together, or neither happens:
 * a token marked used with no membership behind it locks the invitee out
 * permanently, and only the owner minting a second link could rescue them.
 */
async function acceptInvite(req: VercelRequest, res: VercelResponse): Promise<void> {
  const email = signedInEmail(req);
  if (!email) throw unauthorized();
  const token = str(parseBody(req)['token'], 'token', { max: 200 });

  const membership = await transaction(async (client) => {
    // The UPDATE is the lock: two taps on the same link race here, and exactly
    // one of them matches `accepted_at IS NULL`.
    const claimed = await client.query<{ household_id: number; role: string }>(
      `UPDATE household_invites
          SET accepted_at = NOW(), accepted_by = $2
        WHERE token = $1 AND accepted_at IS NULL AND expires_at > NOW()
        RETURNING household_id, role`,
      [token, email],
    );
    const invite = claimed.rows[0];
    if (!invite) return null;

    // An existing membership is never demoted by a link — an owner who reopens
    // their own invitation must not become a member of their own home.
    const joined = await client.query<{ household_id: number; role: string }>(
      `INSERT INTO household_members (household_id, email, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (household_id, email) DO UPDATE SET role = household_members.role
       RETURNING household_id, role`,
      [invite.household_id, email, invite.role],
    );
    return joined.rows[0] ?? null;
  });

  if (!membership) throw badRequest('ההזמנה כבר נוצלה או פגה. בקשו קישור חדש.');

  setHouseholdCookie(res, membership.household_id);
  json(res, 200, { household_id: membership.household_id, role: membership.role });
}

// ── Small helpers ────────────────────────────────────────────────────────

function setHouseholdCookie(res: VercelResponse, householdId: number): void {
  const maxAge = 365 * 24 * 60 * 60;
  // Not HttpOnly-critical — it carries a preference, not an authorisation —
  // but there is no reason for script to read it either.
  res.setHeader('set-cookie', [
    `${HOUSEHOLD_COOKIE}=${householdId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
  ]);
}

async function requireMember(req: VercelRequest, minimum: 'owner' | 'member'): Promise<SessionUser> {
  const user = await currentUser(req);
  if (!user) throw unauthorized();
  if (user.household_id === null) throw forbidden('אתם עדיין לא שייכים לבית');
  const member = user as SessionUser;
  if (member.role === 'pending') throw forbidden('החשבון שלך ממתין לאישור');
  if (!hasRole(member.role, minimum)) throw forbidden();
  return member;
}

export default handler(async (req, res) => {
  const action = String((req.query as Record<string, unknown>)['action'] ?? '');
  const method = (req.method ?? 'GET').toUpperCase();
  const post = (): void => { if (method !== 'POST') throw badRequest('הפעולה מתבצעת ב-POST'); };

  if (action === 'google')    { post(); return signIn(req, res); }
  if (action === 'logout')    { post(); return signOut(req, res); }
  if (action === 'me')        { return me(req, res); }
  if (action === 'household') { post(); return openHousehold(req, res); }
  if (action === 'switch')    { post(); return switchHousehold(req, res); }
  if (action === 'invite')    { return method === 'POST' ? createInvite(req, res) : readInvite(req, res); }
  if (action === 'join')      { post(); return acceptInvite(req, res); }

  throw notFound(`אין נתיב כזה: /api/auth/${action}`);
});
