import type { VercelRequest } from '@vercel/node';
import { handler, json, forbidden } from '../_lib/http.js';
import { query } from '../_lib/db.js';
import { syncShoppingListFromStock } from '../_lib/pantry-service.js';
import { claimOncePerDay, push, telegram } from '../_lib/notify.js';

/**
 * The morning pass: regenerate the shopping list, and say the two things worth
 * waking a phone for.
 *
 * What it deliberately does not notify about: anything already expired. By the
 * time that is true the yoghurt is off and the message is about something you
 * can no longer act on. The screen shows it in red; the phone stays quiet.
 */

function authorized(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // Vercel signs its own cron invocations with this header. With no secret
  // configured the endpoint is open — which is fine for an endpoint that only
  // ever reads and re-derives, but the secret is one line and worth setting.
  if (!secret) return true;
  const auth = req.headers.authorization ?? '';
  return auth === `Bearer ${secret}` || req.headers['x-vercel-signature'] !== undefined;
}

export default handler(async (req, res) => {
  if (!authorized(req)) throw forbidden('cron secret mismatch');

  const { added } = await syncShoppingListFromStock(null);

  const [expiring, dueBills, openItems] = await Promise.all([
    query<{ product_name: string; qty: number; unit: string; days_left: number }>(
      `SELECT p.name AS product_name, e.qty, p.unit, (e.expires_on - CURRENT_DATE) AS days_left
         FROM stock_entries e JOIN products p ON p.id = e.product_id
        WHERE e.qty > 0 AND e.expires_on IS NOT NULL
          AND e.expires_on BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '4 days'
        ORDER BY e.expires_on`,
    ),
    query<{ id: number; name: string; amount_estimate: number; next_due: string; days_left: number }>(
      `SELECT id, name, amount_estimate, to_char(next_due, 'YYYY-MM-DD') AS next_due,
              (next_due - CURRENT_DATE) AS days_left
         FROM recurring_bills
        WHERE active AND NOT autopay
          AND next_due <= CURRENT_DATE + (remind_days || ' days')::interval
        ORDER BY next_due`,
    ),
    query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM shopping_items WHERE status = 'open'`),
  ]);

  const lines: string[] = [];

  if (added.length > 0) {
    const names = added.map((p) => p.name).join(', ');
    lines.push(`🛒 <b>נגמר ונוסף לרשימה:</b> ${names}`);
  }
  if (expiring.length > 0) {
    const items = expiring
      .map((e) => `${e.product_name} (${e.days_left === 0 ? 'היום' : `עוד ${e.days_left} ימים`})`)
      .join(', ');
    lines.push(`⏳ <b>עומד להיגמר התוקף:</b> ${items}`);
  }
  for (const bill of dueBills) {
    const when = bill.days_left <= 0 ? 'היום' : `בעוד ${bill.days_left} ימים`;
    lines.push(`💳 <b>${bill.name}</b> — ${when}${bill.amount_estimate ? `, כ-₪${bill.amount_estimate}` : ''}`);
  }

  if (lines.length === 0) {
    json(res, 200, { ok: true, quiet: true, open_items: openItems[0]?.count ?? 0 });
    return;
  }

  // One claim for the whole digest, keyed by its content: a retry an hour later
  // with the same news stays silent, but genuinely new news gets through.
  const digestKey = lines.join('|').slice(0, 200);
  const first = await claimOncePerDay('daily-digest', digestKey);
  if (!first) {
    json(res, 200, { ok: true, already_sent: true });
    return;
  }

  const text = ['<b>הבית מדווח 🏠</b>', '', ...lines].join('\n');
  const [sentTelegram, sentPush] = await Promise.all([
    telegram(text),
    push({
      title: 'הבית מדווח',
      body: lines.map((l) => l.replace(/<[^>]+>/g, '')).join(' · '),
      url: '/shopping',
    }),
  ]);

  json(res, 200, {
    ok: true,
    added: added.map((p) => p.name),
    expiring: expiring.length,
    bills: dueBills.length,
    telegram: sentTelegram,
    push: sentPush,
  });
});
