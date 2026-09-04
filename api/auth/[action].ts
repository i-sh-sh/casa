import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  clearSessionCookie, currentUser, setSessionCookie, signSession,
  upsertUserOnSignIn, verifyGoogleToken,
} from '../_lib/auth.js';
import { badRequest, handler, json, notFound } from '../_lib/http.js';
import { body as parseBody } from '../_lib/http.js';
import { str } from '../_lib/validate.js';
import { query } from '../_lib/db.js';

// The three endpoints that cannot themselves require a session, which is why
// they live outside the module routers.

async function signIn(req: VercelRequest, res: VercelResponse): Promise<void> {
  const credential = str(parseBody(req)['credential'], 'credential', { max: 4000 });
  const profile = await verifyGoogleToken(credential);
  const user = await upsertUserOnSignIn(profile);
  setSessionCookie(res, signSession(user.email));
  // A pending user gets a session on purpose: they need to be able to load the
  // waiting-room screen and see their own status. The session grants nothing —
  // requireUser refuses 'pending' everywhere else.
  json(res, 200, { user });
}

async function signOut(_req: VercelRequest, res: VercelResponse): Promise<void> {
  clearSessionCookie(res);
  json(res, 200, { ok: true });
}

async function me(req: VercelRequest, res: VercelResponse): Promise<void> {
  const user = await currentUser(req);
  if (!user) {
    json(res, 200, { user: null, google_client_id: process.env.GOOGLE_CLIENT_ID ?? null });
    return;
  }
  // Cheap and worth it: the household roster travels with the session, because
  // every screen that shows "who paid" needs it and none of them should have
  // to ask separately.
  const members = await query(
    `SELECT email, COALESCE(display_name, name, split_part(email, '@', 1)) AS display_name, color, role
       FROM users WHERE role IN ('owner', 'member') ORDER BY created_at`,
  );
  json(res, 200, { user, members, google_client_id: process.env.GOOGLE_CLIENT_ID ?? null });
}

export default handler(async (req, res) => {
  const action = String((req.query as Record<string, unknown>)['action'] ?? '');
  const method = (req.method ?? 'GET').toUpperCase();

  if (action === 'google') {
    if (method !== 'POST') throw badRequest('כניסה מתבצעת ב-POST');
    return signIn(req, res);
  }
  if (action === 'logout') {
    if (method !== 'POST') throw badRequest('יציאה מתבצעת ב-POST');
    return signOut(req, res);
  }
  if (action === 'me') {
    return me(req, res);
  }
  throw notFound(`אין נתיב כזה: /api/auth/${action}`);
});
