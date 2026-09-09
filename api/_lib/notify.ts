import webpush from 'web-push';
import { query, one } from './db.js';

// Two channels, on purpose.
//
// Telegram is the one that actually gets read: it is a chat we already have
// open, it survives a phone reinstall, and it costs one env var. Web push is
// the one that works on the lock screen. Neither is required — with no tokens
// configured the app is simply quiet, which is a valid way to run it and must
// never be an error.

// Telegram itself lives in alert.js, which the error path of every request
// imports — keeping it there means importing it never pulls `web-push` into a
// serverless bundle that has no use for it.
export { telegram } from './alert.js';

let pushConfigured: boolean | null = null;

function configurePush(): boolean {
  if (pushConfigured !== null) return pushConfigured;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? 'mailto:casa@example.com';
  if (!publicKey || !privateKey) {
    pushConfigured = false;
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  pushConfigured = true;
  return true;
}

export async function push(payload: { title: string; body: string; url?: string }): Promise<number> {
  if (!configurePush()) return 0;
  const subs = await query<{ endpoint: string; p256dh: string; auth: string }>(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions`,
  );
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      );
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404/410 mean the browser threw the subscription away — uninstalled the
      // PWA, cleared site data. Keeping it means retrying a dead endpoint every
      // morning forever.
      if (status === 404 || status === 410) {
        await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [sub.endpoint]);
      } else {
        console.error('push failed', status, err);
      }
    }
  }
  return sent;
}

/**
 * True the first time it is asked today for this subject, false after.
 *
 * Crons get retried, and a person poking the endpoint by hand is a normal way
 * to test it. Neither should produce a second "החלב נגמר" at 09:14. The unique
 * index on (kind, subject_key, sent_on) is what makes this a race-free claim
 * rather than a check followed by a hope.
 */
export async function claimOncePerDay(kind: string, subjectKey: string): Promise<boolean> {
  const row = await one(
    `INSERT INTO sent_notifications (kind, subject_key) VALUES ($1, $2)
     ON CONFLICT (kind, subject_key, sent_on) DO NOTHING RETURNING id`,
    [kind, subjectKey],
  );
  return row !== null;
}
