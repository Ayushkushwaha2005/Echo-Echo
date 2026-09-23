/* ==========================================================================
   QUAD — EMAIL TRANSPORT

   The one place that talks to the email provider. notify.js, the student
   email verification service and administrator invitations all send through
   here, so there is a single adapter to audit. Returns the provider's
   message id, or throws.

   Like the SMS adapters, a provider's "accepted" is proof of nothing except
   that the provider took the message. Verification is decided by this server
   comparing a code, never by a delivery receipt.

   FREE-TIER BUDGET. Resend Free (checked 13 Sep 2026, resend.com/pricing):
   3,000 emails/month, 100/day, no overage billing - sends past the quota are
   refused with HTTP 429. This adapter keeps its own count (email_send_log)
   and stops BELOW those limits, reserving headroom for administrator
   invitations, so an attacker requesting codes for many addresses cannot
   silently consume the whole day's quota for everyone. Provider details are
   logged server-side only; callers get a generic 503.
   ========================================================================== */
import { NOTIFY } from '../config.js';
import { HttpError, ProviderUnavailable } from '../auth/rbac.js';
import { q, one } from '../db/index.js';

export const emailConfigured = () => NOTIFY.email.configured;

const scrub = (text, secret) =>
  (secret ? String(text).split(secret).join('[code]') : String(text)).slice(0, 300);

export const EmailUnavailable = () => new HttpError(503, 'email_unavailable',
  'We could not send the email right now', 'Please try again later. If this keeps happening, contact campus support.');

async function log(kind, outcome, ref = null) {
  await q(`INSERT INTO email_send_log (kind, outcome, provider_ref) VALUES ($1,$2,$3)`, [kind, outcome, ref]).catch(() => {});
}

export async function budgetState() {
  const r = await one(
    `SELECT count(*) FILTER (WHERE at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS day,
            count(*) FILTER (WHERE at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS month
       FROM email_send_log WHERE outcome = 'sent' AND at > now() - interval '32 days'`);
  const { dailyBudget, monthlyBudget, reserveForAdmin } = NOTIFY.email;
  return { sentToday: r.day, sentThisMonth: r.month, dailyBudget, monthlyBudget, reserveForAdmin };
}

/* "ECHO ECHO <verify@example.com>" or a bare address. */
export function parseSender(from) {
  const m = String(from || '').trim().match(/^(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>$/);
  if (m) return { name: m[1]?.trim() || undefined, email: m[2] };
  return { email: String(from || '').trim() };
}

/* One request shape per provider. Each returns the fetch arguments and a
   function that pulls the provider's message id out of a success body. */
const PROVIDERS = {
  resend: ({ to, subject, text }) => ({
    base: 'resendBase', path: '/emails',
    headers: { Authorization: `Bearer ${NOTIFY.email.apiKey}`, 'Content-Type': 'application/json' },
    body: { from: NOTIFY.email.from, to: [to], subject, text },
    idOf: (json) => json?.id,
  }),
  brevo: ({ to, subject, text }) => ({
    base: 'brevoBase', path: '/v3/smtp/email',
    headers: { 'api-key': NOTIFY.email.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: { sender: parseSender(NOTIFY.email.from), to: [{ email: to }], subject, textContent: text },
    idOf: (json) => json?.messageId,
  }),
};

export async function sendEmail({ to, subject, text, secret, kind = 'notification', log: logger = console }) {
  if (!NOTIFY.email.configured) {
    throw ProviderUnavailable('Email service not configured',
      'Set EMAIL_PROVIDER (resend or brevo), its API key and EMAIL_FROM on the server.');
  }
  const provider = NOTIFY.email.provider;
  const call = PROVIDERS[provider]({ to, subject, text });
  /* Administrator invitations may use the reserved headroom; nothing else can. */
  const b = await budgetState();
  const reserve = kind === 'admin_invite' ? 0 : b.reserveForAdmin;
  if (b.sentToday >= b.dailyBudget - reserve || b.sentThisMonth >= b.monthlyBudget - reserve) {
    await log(kind, 'refused_budget');
    logger.warn?.(`email budget reached (today ${b.sentToday}/${b.dailyBudget}, month ${b.sentThisMonth}/${b.monthlyBudget}); ${kind} not sent`);
    throw EmailUnavailable();
  }
  let res, body;
  try {
    /* The host is always server configuration (NOTIFY.email.*Base). */
    res = await fetch(`${NOTIFY.email[call.base]}${call.path}`, {
      method: 'POST', headers: call.headers, body: JSON.stringify(call.body),
      signal: AbortSignal.timeout(10_000),
    });
    body = await res.text();
  } catch (e) {
    await log(kind, 'provider_error');
    logger.error?.(`email provider unreachable: ${e.message}`);
    throw EmailUnavailable();
  }
  if (!res.ok) {
    const quota = res.status === 429;
    await log(kind, quota ? 'provider_quota' : 'provider_error');
    logger.error?.(`${provider} ${res.status}: ${scrub(body, secret)}`);
    throw EmailUnavailable();
  }
  let json = null;
  try { json = JSON.parse(body); } catch { /* not JSON */ }
  const id = call.idOf(json);
  if (!id) {
    await log(kind, 'provider_error');
    logger.error?.(`${provider} did not confirm the message: ${scrub(body, secret)}`);
    throw EmailUnavailable();
  }
  await log(kind, 'sent', id);
  return id;
}
