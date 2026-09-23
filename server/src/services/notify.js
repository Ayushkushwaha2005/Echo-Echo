/* ==========================================================================
   QUAD — NOTIFICATIONS

   Every notification is a row first. Delivery is attempted afterwards and
   the row records what actually happened:

     'sent'                a provider accepted it
     'failed'              a provider rejected it (error recorded)
     'unsent_no_provider'  no provider is configured for that channel

   The last state is the important one. With no SMS or email provider
   connected, a student's "order confirmed" notification is honestly marked
   unsent rather than logged as delivered — and because the in-app channel
   always works (it is just a database row the surface reads), the student
   still sees it when they open the app.
   ========================================================================== */
import { q, one } from '../db/index.js';
import { NOTIFY, OTP } from '../config.js';
import { sendEmail } from './email.js';

/* Which channels this deployment can actually reach. */
export function channelStatus() {
  return {
    inapp: { configured: true, provider: 'database' },
    sms: { configured: OTP.configured, provider: OTP.provider },
    email: { configured: NOTIFY.email.configured, provider: NOTIFY.email.provider },
    push: { configured: false, provider: null, note: 'No push provider implemented.' },
  };
}

const senders = {
  async sms(user, n) {
    if (!OTP.configured) return { state: 'unsent_no_provider' };
    if (!user.phone) return { state: 'failed', error: 'no verified phone on account' };
    /* Reuses the SMS gateway already configured for OTP. */
    if (OTP.provider === 'twilio') {
      const { accountSid, authToken, from } = OTP.twilio;
      const res = await fetch(`${OTP.twilioBase}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: user.phone, From: from, Body: `${n.title}\n${n.body || ''}`.trim() }),
      });
      if (!res.ok) return { state: 'failed', error: `twilio ${res.status}` };
      return { state: 'sent', provider: 'twilio', ref: (await res.json()).sid };
    }
    return { state: 'unsent_no_provider' };
  },

  async email(user, n) {
    if (!NOTIFY.email.configured) return { state: 'unsent_no_provider' };
    /* A proven institutional mailbox is preferred over a typed address. */
    const to = user.student_email || user.email;
    if (!to) return { state: 'failed', error: 'no email address on account' };
    const ref = await sendEmail({ to, subject: n.title, text: n.body || n.title });
    return { state: 'sent', provider: NOTIFY.email.provider, ref };
  },

  async push() { return { state: 'unsent_no_provider' }; },
  async inapp() { return { state: 'sent', provider: 'database' }; },
};

/* The catalogue of things the product notifies about. Channels are listed
   in preference order; 'inapp' is always included so nothing is ever lost. */
export const KINDS = {
  order_confirmed:      { channels: ['inapp', 'sms'], title: 'Order confirmed' },
  payment_failed:       { channels: ['inapp', 'sms'], title: 'Payment failed' },
  order_ready:          { channels: ['inapp', 'sms'], title: 'Your order is ready' },
  partner_assigned:     { channels: ['inapp'], title: 'A delivery partner is on the way' },
  order_delivered:      { channels: ['inapp'], title: 'Order delivered' },
  order_cancelled:      { channels: ['inapp', 'sms'], title: 'Order cancelled' },
  refund_completed:     { channels: ['inapp', 'sms'], title: 'Refund completed' },
  verification_approved:{ channels: ['inapp', 'email', 'sms'], title: 'Student identity verified' },
  verification_rejected:{ channels: ['inapp', 'email', 'sms'], title: 'Verification could not be completed' },
  verification_resubmit:{ channels: ['inapp', 'email', 'sms'], title: 'More information needed for verification' },
  verification_suspended:{ channels: ['inapp', 'email'], title: 'Student verification suspended' },
  partner_approved:     { channels: ['inapp', 'sms'], title: 'You are now a delivery partner' },
  partner_rejected:     { channels: ['inapp'], title: 'Delivery partner application declined' },
  delivery_offer:       { channels: ['inapp'], title: 'New delivery available' },
  order_picked_up:      { channels: ['inapp'], title: 'Your order is on the way' },
  deposit_deduction_proposed: { channels: ['inapp', 'email'], title: 'Security deposit: deduction proposed' },
  deposit_deduction_decided:  { channels: ['inapp', 'email'], title: 'Security deposit: decision recorded' },
  deposit_refunded:     { channels: ['inapp', 'email'], title: 'Security deposit returned' },
  support_reply:        { channels: ['inapp', 'sms'], title: 'Support replied to your case' },
};

/**
 * Queue and attempt a notification. Never throws — a notification failure
 * must not roll back the business event that caused it.
 */
export async function notify(userId, kind, { body, data, title } = {}) {
  const spec = KINDS[kind];
  if (!spec) return { error: `unknown notification kind ${kind}` };

  const user = await one(`SELECT id, phone, email, student_email, name FROM app_user WHERE id = $1`, [userId]);
  if (!user) return { error: 'no such user' };

  const out = [];
  for (const channel of spec.channels) {
    const row = await one(
      `INSERT INTO notification (user_id, kind, channel, title, body, data)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [userId, kind, channel, title || spec.title, body || null, data ? JSON.stringify(data) : null]);
    let res;
    try {
      res = await senders[channel](user, row);
    } catch (e) {
      res = { state: 'failed', error: String(e.message).slice(0, 300) };
    }
    await q(
      `UPDATE notification SET state=$2, provider=$3, provider_ref=$4, error=$5,
              sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END
        WHERE id = $1`,
      [row.id, res.state, res.provider || null, res.ref || null, res.error || null]);
    out.push({ channel, state: res.state });
  }
  return { notified: out };
}

/* Fire-and-forget wrapper for call sites inside request handlers. */
export const notifyAsync = (userId, kind, opts) =>
  notify(userId, kind, opts).catch(() => {});

export async function inbox(userId, { unreadOnly = false } = {}) {
  const { rows } = await q(
    `SELECT id, kind, title, body, data, created_at, read_at
       FROM notification
      WHERE user_id = $1 AND channel = 'inapp'
        AND ($2::boolean IS NOT TRUE OR read_at IS NULL)
      ORDER BY created_at DESC LIMIT 50`, [userId, unreadOnly]);
  return rows;
}

export const markRead = (userId, id) =>
  q(`UPDATE notification SET read_at = now()
      WHERE user_id = $1 AND ($2::uuid IS NULL OR id = $2) AND read_at IS NULL`,
    [userId, id || null]);
