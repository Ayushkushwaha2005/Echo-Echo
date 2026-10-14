/* ==========================================================================
   ECHO ECHO — OPERATIONS ALERTS

   An email to the owner when something needs a person: a payment whose
   amount did not match, a payout or refund stuck with the provider, an order
   cancelled with its money not returned, the settlement scheduler failing.

   Through the email provider the site already uses for sign-in codes, so it
   needs no new service and no new account. Each alert key is sent at most
   once per ALERT_COOLDOWN_HOURS, remembered in platform_config so a
   restart or a free-tier sleep does not reset it, and the whole thing never
   throws: an alert that cannot be sent is logged, and the money path that
   raised it carries on exactly as before.

   An alert names WHAT happened and WHERE to look. It never carries an
   email address, phone number, bank or UPI detail, or a payment id.
   ========================================================================== */
import { q, one } from '../db/index.js';
import { ALERTS } from '../config.js';
import { sendEmail, emailConfigured } from './email.js';

/**
 * @param key      stable identity of the condition, e.g. 'reconciliation'
 * @param subject  short line, no personal data
 * @param lines    body lines, no personal data
 * @returns 'sent' | 'cooldown' | 'unconfigured' | 'failed'
 */
export async function alertOwner(key, subject, lines = [], { log = console } = {}) {
  try {
    if (!ALERTS.to || !emailConfigured()) return 'unconfigured';
    const k = `ops_alert:${key}`;
    /* Claim the slot atomically: two instances, or two ticks, cannot both send. */
    const claimed = await one(
      `INSERT INTO platform_config (key, value, updated_at) VALUES ($1, to_jsonb(now()), now())
       ON CONFLICT (key) DO UPDATE SET value = to_jsonb(now()), updated_at = now()
         WHERE platform_config.updated_at < now() - ($2 || ' hours')::interval
       RETURNING key`, [k, String(ALERTS.cooldownHours)]);
    if (!claimed) return 'cooldown';
    await sendEmail({
      to: ALERTS.to, kind: 'ops_alert', log,
      subject: `[ECHO ECHO] ${subject}`.slice(0, 140),
      text: [...lines, '', `Next alert of this kind: not before ${ALERTS.cooldownHours} h from now.`,
             'Sent by the ECHO ECHO server. It contains no customer, partner or payment details.'].join('\n'),
    });
    return 'sent';
  } catch (e) {
    log.error?.({ alert: key, err: e?.message }, 'ops alert not sent');
    /* Release the slot so the next occurrence can try again. */
    await q(`DELETE FROM platform_config WHERE key = $1`, [`ops_alert:${key}`]).catch(() => {});
    return 'failed';
  }
}

/** Fire and forget, for callers on a money path. */
export const alertOwnerAsync = (...args) => { alertOwner(...args).catch(() => {}); };
