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
import { randomBytes, createHmac } from 'node:crypto';
import { q, one, tx } from '../db/index.js';
import { PAYMENTS, PAYOUTS, HTTP } from '../config.js';
import { authorize, BadRequest, NotFound, Forbidden, Conflict, ProviderUnavailable } from '../auth/rbac.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { audit } from '../audit.js';
import { activeAdapter, cashfree as cashfreePayouts } from '../services/payout-providers.js';
import { adapterFor } from '../services/payment-providers.js';
import { detectOperationalDifferences, webhookHealth } from '../services/reconciliation.js';
import { settle } from '../services/payouts.js';
import { partnerWallet, requestWithdrawal, retryPayout, payoutConfig, validatePayoutConfig,
         applyTransferOutcome, syncInFlightPayouts } from '../services/wallet.js';

/* Limits per partner, not per IP: a campus shares a handful of NAT IPs. */
const perActor = (req) => (req.actor?.id ? `actor:${req.actor.id}` : req.ip);

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT = /^\d{9,18}$/;
const VPA = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;

function maskAccount(n) { return 'XXXX' + String(n).slice(-4); }
function maskVpa(v) {
  const [user, host] = String(v).split('@');
  return `${user.slice(0, 2)}***@${host}`;
}

/**
 * Validate payout details and register them with the provider as a
 * beneficiary. Returns the destination row. Throws 503 when no payout
 * provider is connected, because a destination we cannot pay to verified is
 * not a destination.
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

  const adapter = activeAdapter();
  if (!adapter || adapter.id !== 'cashfree_payouts') {
    throw ProviderUnavailable('Payout details cannot be verified yet',
      'The Cashfree Payouts account is not connected on this deployment. Nothing was saved.');
  }
  const fingerprint = createHmac('sha256', HTTP.cookieSecret || 'echo-echo-payee')
    .update(instrument === 'bank' ? `bank:${accountNumber}:${ifsc}` : `upi:${vpa.toLowerCase()}`).digest('hex');

  let b;
  /* Cashfree keeps one beneficiary per instrument. A UPI id cannot be looked
     up there, so a UPI id already registered through Echo Echo is found by
     its fingerprint and its beneficiary reused. */
  const known = await one(`SELECT provider_fund_account_id FROM payout_destination
                            WHERE provider='cashfree' AND instrument_fingerprint=$1
                            ORDER BY created_at DESC LIMIT 1`, [fingerprint]);
  try {
    b = known
      ? await cashfreePayouts.fetchBeneficiary({ beneficiaryId: known.provider_fund_account_id })
      : await cashfreePayouts.createBeneficiary({
          beneficiaryId: `ee_${partnerId ? 'p' : 'v'}_${randomBytes(12).toString('hex')}`,
          name: holderName, instrument, accountNumber, ifsc, vpa,
          phone: contact?.phone || null, email: contact?.email || null });
  } catch (e) {
    /* The provider refused the details. Its own message may echo what was
       sent, so only a plain reason goes back to the payee. */
    if (e.providerStatus && e.providerStatus < 500) {
      throw BadRequest('These payout details could not be registered',
        e.providerCode === 'conflict_with_existing_beneficiary'
          ? 'This UPI ID is already registered with our payout provider. Contact support.'
          : 'Check the account number, IFSC or UPI ID and try again.');
    }
    throw e;
  }
  accountNumber = null; vpa = vpa && maskVpa(vpa);          // drop the secret now

  return tx(async (c) => {
    await c.query(
      `UPDATE payout_destination SET active = false
        WHERE active AND vendor_id IS NOT DISTINCT FROM $1 AND partner_id IS NOT DISTINCT FROM $2`,
      [vendorId, partnerId]);
    return (await c.query(
      `INSERT INTO payout_destination (vendor_id, partner_id, provider, provider_fund_account_id,
         label, instrument, masked, ifsc, holder_name, verification_status, verification_note,
         verified_at, created_by, instrument_fingerprint)
       VALUES ($1,$2,'cashfree',$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $9='verified' THEN now() END, $11, $12)
       RETURNING *`,
      [vendorId, partnerId, b.beneficiaryId, `${instrument} ${instrument === 'bank' ? maskAccount(body.accountNumber) : vpa}`,
       instrument, instrument === 'bank' ? maskAccount(body.accountNumber) : vpa, ifsc, holderName,
       b.verification, `cashfree beneficiary_status=${b.status || 'unknown'}${b.reused ? ' (existing beneficiary)' : ''}`,
       actorId, fingerprint])).rows[0];
  });
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
    const d = await registerDestination({ partnerId: req.actor.id, body: req.body, actorId: req.actor.id, contact });
    await audit(req, { action: 'payout.destination.partner', resource: 'payout_destination', resourceId: d.id,
                       outcome: 'ok', detail: { instrument: d.instrument, status: d.verification_status } });
    return { destination: shapeDest(d) };
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

  /* Easy Split: record the café's Cashfree vendor id and ask Cashfree for its
     status. 'active' comes only from Cashfree's own answer. */
  app.put('/admin/vendors/:id/easy-split', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'changing settlement routing');
    const v = await one(`SELECT id FROM vendor WHERE id=$1`, [req.params.id]);
    if (!v) throw NotFound('No such cafeteria');
    const pvid = String(req.body?.providerVendorId || '').trim();
    if (!/^[A-Za-z0-9_-]{3,50}$/.test(pvid)) throw BadRequest('Enter the Cashfree vendor id');
    if (!PAYMENTS.configured || PAYMENTS.provider !== 'cashfree') {
      throw ProviderUnavailable('Cashfree payments are not configured');
    }
    const r = await adapterFor('cashfree').fetchSplitVendor(pvid);
    const status = r.status === 'ACTIVE' ? 'active' : r.status === 'BLOCKED' ? 'blocked'
      : r.status === 'NOT_FOUND' ? 'rejected' : 'pending';
    const row = await one(
      `INSERT INTO vendor_split_account (vendor_id, provider_vendor_id, status, provider_status, checked_at, created_by)
       VALUES ($1,$2,$3,$4,now(),$5)
       ON CONFLICT (vendor_id) DO UPDATE SET provider_vendor_id=EXCLUDED.provider_vendor_id,
         status=EXCLUDED.status, provider_status=EXCLUDED.provider_status, checked_at=now()
       RETURNING *`, [v.id, pvid, status, r.status, req.actor.id]);
    await audit(req, { action: 'easy_split.vendor', resource: 'vendor', resourceId: v.id, outcome: 'ok',
                       detail: { providerVendorId: pvid, status } });
    return { ...row, easySplitEnabled: PAYMENTS.cashfree.easySplit };
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
    return { vendors, partners, easySplitEnabled: PAYMENTS.cashfree.easySplit };
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

  /* Easy Split: Cashfree settled a café's split share directly. Recorded
     against Cashfree's own settlement reference, as a payout of method
     cashfree_easy_split — the same evidence rule as any other payout, so
     the café's payable is discharged exactly once. */
  app.post('/admin/vendors/:id/easy-split/settled', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'moving or recording money');
    const reference = String(req.body?.reference || '').trim();
    if (reference.length < 4) throw BadRequest("Enter Cashfree's vendor settlement reference / UTR");
    const out = await tx(async (c) => {
      const splits = (await c.query(
        `SELECT * FROM payment_split WHERE vendor_id=$1 AND state='requested' FOR UPDATE`, [req.params.id])).rows;
      const total = splits.reduce((t, x) => t + x.amount_paise, 0);
      if (!total) throw Conflict('No unsettled Easy Split amounts for this café');
      const p = (await c.query(
        `INSERT INTO payout (vendor_id, amount_paise, initiated_by, state) VALUES ($1,$2,$3,'pending') RETURNING *`,
        [req.params.id, total, req.actor.id])).rows[0];
      const done = await settle(c, p.id, { method: 'cashfree_easy_split', externalReference: reference.slice(0, 120),
                                           actorId: req.actor.id });
      await c.query(`UPDATE payment_split SET state='settled', payout_id=$2 WHERE id = ANY($1)`,
                    [splits.map((x) => x.id), p.id]);
      return { payoutId: p.id, amountPaise: total, splits: splits.length, posting: done.posting };
    });
    await audit(req, { action: 'easy_split.settled', resource: 'vendor', resourceId: req.params.id,
                       outcome: 'ok', detail: { ...out, reference } });
    return out;
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
