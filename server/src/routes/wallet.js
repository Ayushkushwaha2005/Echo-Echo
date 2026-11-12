/* ==========================================================================
   ECHO ECHO — WALLET, SETTLEMENT ACCOUNTS, WITHDRAWALS, PAYOUT WEBHOOK

   Who can reach what:
     delivery partner  their own wallet, payout method and withdrawals
     café owner        their own café's settlement account status
     platform admin    settlement accounts, payout config, sync, Easy Split
     student           none of it — no route here accepts a student

   Bank details: a full account number or UPI id arrives in one request, is
   passed straight to the payout provider, and is dropped. The database keeps
   the provider's beneficiary id and a masked hint. The logger redacts both
   body fields (index.js).
   ========================================================================== */
import { q, one } from '../db/index.js';
import { PAYOUTS } from '../config.js';
import { authorize, BadRequest, NotFound, Forbidden, Conflict, ProviderUnavailable } from '../auth/rbac.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { audit } from '../audit.js';
import { activeAdapter } from '../services/payout-providers.js';
import { detectOperationalDifferences, webhookHealth } from '../services/reconciliation.js';
import { partnerWallet, requestWithdrawal, retryPayout, payoutConfig, validatePayoutConfig,
         applyTransferOutcome, syncInFlightPayouts, destinationChangeHold } from '../services/wallet.js';
import { notifyAsync } from '../services/notify.js';

/* Limits per partner, not per IP: a campus shares a handful of NAT IPs. */
const perActor = (req) => (req.actor?.id ? `actor:${req.actor.id}` : req.ip);

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT = /^\d{9,18}$/;
const VPA = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;


/**
 * Validate payout details and register them with the provider as a
 * beneficiary. Returns the destination row. Throws 503 when no payout
 * provider is connected, because a destination we cannot pay to verified is
 * not a destination.
 *
 * Online beneficiary verification was provided by Cashfree Payouts, which
 * was retired on 12 November 2026 (docs/CASHFREE-RETIREMENT.md). Until a
 * payout provider with beneficiary verification is connected, this route
 * validates the input and then refuses: nothing is stored, no bank detail is
 * kept, and settlements are recorded by an administrator against the bank
 * reference of a transfer they actually made.
 */
async function registerDestination({ vendorId = null, partnerId = null, body, actorId, contact }) {
  const instrument = body?.instrument;
  const holderName = String(body?.holderName || '').trim().slice(0, 100);
  if (!['bank', 'upi'].includes(instrument)) throw BadRequest('instrument must be bank or upi');
  if (holderName.length < 3) throw BadRequest('Enter the account holder name as the bank has it');
  let accountNumber = null; let ifsc = null; let vpa = null;
  if (instrument === 'bank') {
    accountNumber = String(body.accountNumber || '').replace(/\s/g, '');
    ifsc = String(body.ifsc || '').trim().toUpperCase();
    if (!ACCOUNT.test(accountNumber)) throw BadRequest('Enter a valid bank account number (9–18 digits)');
    if (!IFSC.test(ifsc)) throw BadRequest('Enter a valid IFSC code (e.g. SBIN0001234)');
  } else {
    vpa = String(body.vpa || '').trim();
    if (!VPA.test(vpa)) throw BadRequest('Enter a valid UPI ID (e.g. name@okhdfc)');
  }

  const cfg = partnerId ? await payoutConfig() : null;
  if (cfg && cfg.method !== 'bank_or_upi' && cfg.method !== instrument) {
    throw Conflict(`Payouts are currently made to ${cfg.method === 'bank' ? 'bank accounts' : 'UPI IDs'} only`);
  }

  /* No connected payout provider verifies beneficiaries on this build, so
     the details are dropped here, unsaved. `actorId` and `contact` are kept
     in the signature for the provider that next implements this. */
  accountNumber = null; vpa = null; ifsc = null;
  void actorId; void contact; void vendorId; void partnerId; void holderName;
  const adapter = activeAdapter();
  throw ProviderUnavailable('Payout details cannot be verified yet',
    adapter
      ? `${adapter.label} is connected but does not verify payout details through ECHO ECHO. Nothing was saved.`
      : 'No payout provider that verifies bank or UPI details is connected on this deployment. ' +
        'Nothing was saved; settlements are paid by bank transfer and recorded by an administrator.');
}

const shapeDest = (d) => d && ({
  id: d.id, instrument: d.instrument, masked: d.masked, ifsc: d.ifsc, holderName: d.holder_name,
  status: d.verification_status, verifiedAt: d.verified_at,
});

export default async function walletRoutes(app) {
  /* ======================= delivery partner ============================= */
  const partnerOnly = (actor) => {
    authorize(actor, 'delivery.read', { ownerId: actor?.id });
    if (!actor.roles.includes('delivery_partner')) throw Forbidden('Delivery partners only');
  };

  app.get('/partner/wallet', async (req) => {
    partnerOnly(req.actor);
    return partnerWallet(req.actor.id);
  });

  app.put('/partner/payout-method', { config: { rateLimit: { max: 5, timeWindow: '1 hour', keyGenerator: perActor, hook: 'preHandler' } } }, async (req) => {
    partnerOnly(req.actor);
    const inflight = await one(`SELECT 1 FROM payout WHERE partner_id=$1 AND state IN ('pending','processing')`,
                               [req.actor.id]);
    if (inflight) throw Conflict('A withdrawal is in progress', 'Change your payout details after it completes.');
    const contact = await one(`SELECT coalesce(phone, contact_phone) AS phone, email FROM app_user WHERE id=$1`,
                              [req.actor.id]);
    const previous = await one(`SELECT masked FROM payout_destination WHERE partner_id=$1 AND active`, [req.actor.id]);
    const d = await registerDestination({ partnerId: req.actor.id, body: req.body, actorId: req.actor.id, contact });
    await audit(req, { action: 'payout.destination.partner', resource: 'payout_destination', resourceId: d.id,
                       outcome: 'ok', detail: { instrument: d.instrument, status: d.verification_status,
                                                replaced: previous ? previous.masked : null } });
    /* Every CHANGE is told to the partner on a second channel, with masked
       details only, so a change they did not make is noticed within the hold. */
    let holdUntil = null;
    if (previous) {
      holdUntil = await destinationChangeHold({ query: q }, d, await payoutConfig());
      notifyAsync(req.actor.id, 'payout_destination_changed', {
        body: `Payouts now go to ${d.masked} instead of ${previous.masked}. If you did not make this change, contact support immediately.`,
        data: { destinationId: d.id, holdUntil } });
    }
    return { destination: shapeDest(d), holdUntil };
  });

  app.post('/partner/withdrawals', { config: { rateLimit: { max: 10, timeWindow: '1 hour', keyGenerator: perActor, hook: 'preHandler' } } }, async (req) => {
    partnerOnly(req.actor);
    const key = req.headers['idempotency-key'] || req.body?.idempotencyKey;
    const out = await requestWithdrawal(req.actor.id, { idempotencyKey: key, actorId: req.actor.id });
    if (!out.duplicate) {
      await audit(req, { action: 'payout.withdrawal.request', resource: 'payout', resourceId: out.payout.id,
                         outcome: 'ok', detail: { amount_paise: out.payout.amount_paise } });
    }
    return { id: out.payout.id, state: out.payout.state, amountPaise: out.payout.amount_paise,
             duplicate: out.duplicate,
             note: out.payout.state === 'pending'
               ? 'Requested. It is paid when the payout is processed.' : null };
  });

  app.post('/partner/withdrawals/:id/retry', async (req) => {
    partnerOnly(req.actor);
    const p = await one(`SELECT * FROM payout WHERE id=$1`, [req.params.id]);
    if (!p || p.partner_id !== req.actor.id) throw NotFound('No such withdrawal');
    const out = await retryPayout(p.id, { actorId: req.actor.id });
    await audit(req, { action: 'payout.retry', resource: 'payout', resourceId: out.payout.id,
                       outcome: 'ok', detail: { retry_of: p.id } });
    return { id: out.payout.id, state: out.payout.state, amountPaise: out.payout.amount_paise, retryOf: p.id };
  });

  /* ======================= café ========================================= */
  app.get('/vendors/:id/settlement', async (req) => {
    const vendorId = req.params.id;
    const v = await one(`SELECT id FROM vendor WHERE id=$1`, [vendorId]);
    if (!v) throw NotFound('No such cafeteria');
    try { authorize(req.actor, 'finance.read', { vendorId }); }
    catch { authorize(req.actor, 'finance.read_all'); }
    const acct = await one(`SELECT * FROM v_vendor_settlement_account WHERE vendor_id=$1`, [vendorId]);
    const stmt = await one(`SELECT * FROM v_cafeteria_statement WHERE vendor_id=$1`, [vendorId]);
    const settlements = (await q(
      `SELECT id, amount_paise, state, method, external_reference, provider_status, failure_reason,
              created_at, paid_at
         FROM payout WHERE vendor_id=$1 ORDER BY created_at DESC LIMIT 50`, [vendorId])).rows;
    return {
      settlementStatus: acct.settlement_status,
      account: acct.destination_id ? { instrument: acct.instrument, masked: acct.masked, ifsc: acct.ifsc,
                                       verifiedAt: acct.verified_at } : null,
      note: acct.settlement_status === 'VERIFIED' ? null
        : 'Your earnings are tracked in full. Settlement starts once your bank account is added and verified.',
      statement: stmt,
      settlements,
    };
  });

  /* ======================= admin ======================================== */
  app.put('/admin/vendors/:id/settlement-account', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'moving or recording money');
    const v = await one(`SELECT id, name FROM vendor WHERE id=$1`, [req.params.id]);
    if (!v) throw NotFound('No such cafeteria');
    const d = await registerDestination({ vendorId: v.id, body: req.body, actorId: req.actor.id });
    await audit(req, { action: 'payout.destination.vendor', resource: 'payout_destination', resourceId: d.id,
                       outcome: 'ok', detail: { vendor: v.id, instrument: d.instrument, status: d.verification_status } });
    return { destination: shapeDest(d) };
  });

  /* A human verification, for a destination the provider left pending. It
     needs a written account of what was checked, and it is audited. */
  app.post('/admin/payout-destinations/:id/verify', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'moving or recording money');
    const note = String(req.body?.evidence || '').trim();
    if (note.length < 20) {
      throw BadRequest('Describe how the details were verified (at least 20 characters)',
        'For example: a ₹1 test transfer credited, confirmed by the account holder on a call.');
    }
    const d = await one(
      `UPDATE payout_destination SET verification_status='verified', verified_at=now(), verified_by=$2,
              verification_note=$3
        WHERE id=$1 AND active AND verification_status <> 'verified' RETURNING *`,
      [req.params.id, req.actor.id, note.slice(0, 500)]);
    if (!d) throw Conflict('No active unverified destination with that id');
    await audit(req, { action: 'payout.destination.verify', resource: 'payout_destination', resourceId: d.id,
                       outcome: 'ok', detail: { evidence: note.slice(0, 500) } });
    return { destination: shapeDest(d) };
  });

  app.get('/admin/payout-config', async (req) => {
    authorize(req.actor, 'finance.read_all');
    return { config: await payoutConfig(), provider: { id: PAYOUTS.provider, configured: PAYOUTS.configured } };
  });

  app.put('/admin/payout-config', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'changing payout rules');
    const next = validatePayoutConfig(await payoutConfig(), req.body || {});
    await q(`INSERT INTO platform_config (key, value, updated_at) VALUES ('partner_payout_config', $1, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(next)]);
    await audit(req, { action: 'payout.config', outcome: 'ok', detail: next });
    return { config: next };
  });

  app.post('/admin/payouts/sync', async (req) => {
    authorize(req.actor, 'payout.manage');
    const out = await syncInFlightPayouts();
    await audit(req, { action: 'payout.sync', outcome: 'ok', detail: out });
    return out;
  });

  app.post('/admin/payouts/:id/retry-new', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'moving or recording money');
    const out = await retryPayout(req.params.id, { actorId: req.actor.id });
    await audit(req, { action: 'payout.retry', resource: 'payout', resourceId: out.payout.id,
                       outcome: 'ok', detail: { retry_of: req.params.id } });
    return { id: out.payout.id, state: out.payout.state, retryOf: req.params.id };
  });

  /* Easy Split was a Cashfree product. Cashfree was retired on 12 November
     2026 (docs/CASHFREE-RETIREMENT.md), so this route refuses before
     touching anything. It stays registered so an old Campus Control build
     gets a truthful answer instead of a 404, and so the permission matrix
     over every route is unchanged. Existing vendor_split_account rows are
     history and are not altered. */
  app.put('/admin/vendors/:id/easy-split', async (req) => {
    authorize(req.actor, 'payout.manage');
    throw ProviderUnavailable('Easy Split is retired',
      'Cashfree Easy Split was retired with Cashfree on 12 November 2026. Cafés are settled from the ledger.');
  });

  app.get('/admin/finance/settlement-accounts', async (req) => {
    authorize(req.actor, 'finance.read_all');
    const vendors = (await q(
      `SELECT a.vendor_id, a.name, a.settlement_status, a.instrument, a.masked, a.verified_at,
              s.outstanding_paise, sp.status AS easy_split_status
         FROM v_vendor_settlement_account a
         LEFT JOIN v_cafeteria_statement s ON s.vendor_id = a.vendor_id
         LEFT JOIN vendor_split_account sp ON sp.vendor_id = a.vendor_id
        ORDER BY a.name`)).rows;
    const partners = (await q(
      `SELECT u.id AS partner_id, u.name, d.instrument, d.masked, d.verification_status,
              (SELECT COALESCE(sum(balance_paise),0)::bigint FROM v_account_balance b
                WHERE b.kind='delivery_payable' AND b.partner_id=u.id) AS balance_paise
         FROM partner_profile pp JOIN app_user u ON u.id = pp.user_id
         LEFT JOIN payout_destination d ON d.partner_id = u.id AND d.active
        ORDER BY u.name`)).rows;
    return { vendors, partners, easySplitEnabled: false };
  });

  app.get('/admin/finance/reconciliation/health', async (req) => {
    authorize(req.actor, 'finance.read_all');
    const open = (await q(`SELECT kind, count(*)::int AS n FROM reconciliation_exception
                            WHERE state='open' GROUP BY kind ORDER BY kind`)).rows;
    const inflight = await one(`SELECT count(*)::int AS n FROM payout WHERE state='processing'`);
    return { webhooks: await webhookHealth(), openExceptions: open, payoutsAwaitingProvider: inflight.n };
  });

  app.post('/admin/finance/reconciliation/detect', async (req) => {
    authorize(req.actor, 'finance.read_all');
    const out = await detectOperationalDifferences();
    await audit(req, { action: 'reconciliation.detect', outcome: 'ok', detail: out });
    return out;
  });

  /* Retired with Easy Split (above). No payment_split row can be in state
     'requested' on a build that cannot request one, and a historical one is
     settled, if ever, by an ordinary recorded payout. */
  app.post('/admin/vendors/:id/easy-split/settled', async (req) => {
    authorize(req.actor, 'payout.manage');
    throw ProviderUnavailable('Easy Split is retired',
      'Cashfree Easy Split was retired with Cashfree on 12 November 2026. Record the café\'s settlement as a payout instead.');
  });

  /* ======================= payouts webhook ============================== */
  app.post('/payouts/webhook', { config: { rateLimit: false } }, async (req, reply) => {
    const adapter = activeAdapter();
    if (!adapter?.verifyWebhook) return reply.code(503).send({ error: 'payouts not configured' });
    const v = adapter.verifyWebhook(req.headers, req.rawBody);
    if (!v.ok) {
      await audit(req, { action: 'payout.webhook', outcome: 'denied', detail: { reason: v.reason } });
      return reply.code(400).send({ error: 'invalid signature' });
    }
    const t = adapter.readWebhook(req.body);
    const eventId = String(req.headers['x-idempotency-key'] || `${t.eventType}:${t.transferId}:${t.status}`);
    const fresh = await one(
      `INSERT INTO payout_webhook (provider, event_id, payload) VALUES ($1,$2,$3)
       ON CONFLICT (provider, event_id) DO UPDATE SET duplicate_count = payout_webhook.duplicate_count + 1
       RETURNING (xmax = 0) AS inserted`, [adapter.id, eventId, JSON.stringify(req.body)]);
    if (!fresh.inserted) return { ok: true, duplicate: true };
    if (!t.transferId) return { ok: true, ignored: true };
    const p = await one(`SELECT id FROM payout WHERE id::text = $1`, [t.transferId]);
    if (!p) return { ok: true, ignored: 'unknown transfer' };
    const r = await applyTransferOutcome(p.id, { ...t, method: adapter.id });
    return { ok: true, state: r.state };
  });
}
