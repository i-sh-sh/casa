import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomBytes } from 'node:crypto';
import {
  appendCookie, clearSessionCookie, createHousehold, currentUser, hasRole, HOUSEHOLD_COOKIE,
  membershipsOf, parkedSession, RETURN_COOKIE, sessionToken, setSessionCookie, signedInEmail,
  signSession, upsertUserOnSignIn, verifyGoogleToken, type SessionUser,
} from '../_lib/auth.js';
import { badRequest, forbidden, handler, json, notFound, unauthorized } from '../_lib/http.js';
import { body as parseBody } from '../_lib/http.js';
import { optionalStr, str } from '../_lib/validate.js';
import { one, query, transaction } from '../_lib/db.js';
import { isOperator } from '../../shared/operators.js';
import { isTestEmail, personaByEmail, personaByKey } from '../../shared/testing.js';

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
  // Signing out while stepped into a test person signs the operator out too:
  // a parked session left behind on a shared phone is a session left behind.
  clearSessionCookie(res, RETURN_COOKIE);
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
  const testing = testingBanner(req, user.email);

  const households = await membershipsOf(user.email);

  if (user.household_id === null) {
    json(res, 200, { user, members: [], households, google_client_id, is_operator, testing });
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
  json(res, 200, { user, members, households, google_client_id, is_operator, testing });
}

/** Opens a new home. Anyone signed in may — they can only ever see their own. */
async function openHousehold(req: VercelRequest, res: VercelResponse): Promise<void> {
  const email = signedInEmail(req);
  if (!email) throw unauthorized();
  const name = str(parseBody(req)['name'], 'שם הבית', { max: 60 });

  await rememberName(req, email);
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
  // Who sent it, by the name they gave themselves: the link arrives in a chat,
  // and «יוסי הזמין אותך» is the difference between a message from a person
  // and one from a system the invitee has never heard of.
  const invite = await one<{ household_name: string; role: string; spent: boolean; invited_by: string | null }>(
    `SELECT h.name AS household_name, i.role,
            (i.accepted_at IS NOT NULL OR i.expires_at < NOW()) AS spent,
            COALESCE(u.display_name, split_part(u.name, ' ', 1)) AS invited_by
       FROM household_invites i
       JOIN households h ON h.id = i.household_id
       LEFT JOIN users u ON u.email = i.created_by
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
  await rememberName(req, email);

  setHouseholdCookie(res, membership.household_id);
  json(res, 200, { household_id: membership.household_id, role: membership.role });
}

// ── Test people ──────────────────────────────────────────────────────────
//
// The operator walks the app as one of the people in shared/testing.ts, then
// comes back. The swap is two cookies: the session becomes the test person's,
// and the operator's own session is parked beside it until they return.

/**
 * The operator behind this request: the parked session when stepped in (so
 * moving from one test person to another needs no trip back), else whoever is
 * signed in. Checked against CASA_OPERATORS every time, never remembered.
 */
function operatorOf(req: VercelRequest): { token: string; email: string } {
  const operators = process.env.CASA_OPERATORS;
  const parked = parkedSession(req);
  if (parked && isOperator(operators, parked.email)) return parked;

  const email = signedInEmail(req);
  const token = sessionToken(req);
  if (!email || !token) throw unauthorized();
  if (!isOperator(operators, email)) throw forbidden();
  return { token, email };
}

async function stepIn(req: VercelRequest, res: VercelResponse): Promise<void> {
  const operator = operatorOf(req);
  // A key, looked up in a fixed list. The request never names an address, so
  // this route can only ever produce one of the `.invalid` people.
  const persona = personaByKey(parseBody(req)['persona']);
  if (!persona) throw badRequest('אין משתמש בדיקה כזה');

  const exists = await one(`SELECT 1 FROM users WHERE email = $1`, [persona.email]);
  if (!exists) throw badRequest('משתמשי הבדיקה עוד לא נבנו. לחצו «לבנות מחדש» במסך הניהול.');
  await query(`UPDATE users SET last_seen_at = NOW() WHERE email = $1`, [persona.email]);

  setSessionCookie(res, signSession(persona.email));
  setSessionCookie(res, operator.token, RETURN_COOKIE);
  // The operator's choice of home means nothing to the test person.
  clearHouseholdCookie(res);
  json(res, 200, { persona: persona.key });
}

async function stepBack(req: VercelRequest, res: VercelResponse): Promise<void> {
  const parked = parkedSession(req);
  clearSessionCookie(res, RETURN_COOKIE);
  clearHouseholdCookie(res);
  if (!parked) {
    if (!isTestEmail(signedInEmail(req))) { json(res, 200, { ok: true }); return; }
    // Expired or tampered with: there is nobody to hand back to, and staying
    // signed in as a test person would look like being signed in as yourself.
    clearSessionCookie(res);
    throw unauthorized('החיבור שלך פג. היכנסו שוב עם Google.');
  }
  setSessionCookie(res, parked.token);
  json(res, 200, { ok: true });
}

/** What the strip across the top of the screen says while stepped in. */
function testingBanner(req: VercelRequest, email: string): { persona: string; display_name: string } | null {
  if (!isTestEmail(email)) return null;
  const persona = personaByEmail(email);
  if (!persona || !parkedSession(req)) return null;
  return { persona: persona.key, display_name: persona.display_name };
}

// ── Small helpers ────────────────────────────────────────────────────────

/**
 * «איך לקרוא לך», asked once, when a person opens a home or joins one.
 *
 * Google's name is the one on the account — «Yossi Cohen», or a work
 * address's formal one — and it is what «מי שילם» showed until now. The name
 * a couple uses for each other is a different thing, and only they know it.
 * Absent or blank leaves whatever is there.
 */
async function rememberName(req: VercelRequest, email: string): Promise<void> {
  const name = optionalStr(parseBody(req)['display_name'], 'איך לקרוא לך', 40);
  if (!name) return;
  await query(`UPDATE users SET display_name = $2 WHERE email = $1`, [email, name]);
}

function setHouseholdCookie(res: VercelResponse, householdId: number): void {
  const maxAge = 365 * 24 * 60 * 60;
  // Not HttpOnly-critical — it carries a preference, not an authorisation —
  // but there is no reason for script to read it either.
  appendCookie(res, `${HOUSEHOLD_COOKIE}=${householdId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}

function clearHouseholdCookie(res: VercelResponse): void {
  appendCookie(res, `${HOUSEHOLD_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
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
  if (action === 'test-as')   { post(); return stepIn(req, res); }
  if (action === 'test-back') { post(); return stepBack(req, res); }

  throw notFound(`אין נתיב כזה: /api/auth/${action}`);
});
