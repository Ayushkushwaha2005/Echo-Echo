/* ==========================================================================
   A NEW PARTNER POLICY, AND THE APPLICATIONS MADE UNDER THE OLD ONE

   The production case (28 Oct 2026): a student applied under version 1 of
   the partner policy; migration 028 published version 2 while the
   application waited. Approval rightly refused - consent counts only for the
   version in force - but a pending applicant had no way to accept version 2,
   so the application could never be approved.

   * Accepting an older version does not authorise approval after a change;
     no acceptance at all does not either. Campus Control is told exactly why
     and what the applicant must do, and Approve is not offered.
   * The applicant accepts the version in force themselves
     (POST /partner/policy/accept): signed in, from an allowed origin, for
     their own account only, naming the exact version they were shown.
   * Accepting twice, or at once from two tabs, records one acceptance.
   * Once accepted, Campus Control's live stamp moves and approval works the
     usual way. Nothing else changes: the old acceptance, other applicants,
     deposits, the ledger and payouts are as they were.
   Synthetic accounts only.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser, makePartnerReady } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

let app, pool;
before(async () => {
  await startDb();
  process.env.PLATFORM_OWNER_PHONE = '+919000000000';
  process.env.COOKIE_SECRET = 'test-secret-that-is-at-least-32-chars-long';
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => { await truncateAll(pool); });

let seq = 0;
const phone = () => `+9197${String(30000000 + (seq++)).padStart(8, '0')}`;
const as = async (u, opts) => client(app, await sessionFor(pool, u.id, opts));
const V2_TERMS = 'Version two of the ECHO ECHO delivery partner terms: earnings, payouts, incidents and the security deposit.';

/* An administrator, and a verified student who applied under the policy then
   in force - through the real application route. */
async function appliedUnderV1() {
  const admin = await makeUser(pool, { phone: phone(), name: 'Asha Admin', roles: ['platform_admin'] });
  const ca = await as(admin, { method: 'admin_totp' });
  const applicant = await makeUser(pool, { phone: phone(), name: 'Ayu Applicant' });
  const { policyId: v1 } = await makePartnerReady(pool, applicant.id);
  const ac = await as(applicant);
  const applied = await ac.post('/partner/apply', { acceptPolicyId: v1 });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  return { admin, ca, applicant, ac, v1 };
}
const publishV2 = async (ca) => {
  const r = await ca.put('/admin/partner-deposit-policy', { amountPaise: 0, disputeWindowHours: 72, terms: V2_TERMS });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const row = async (ca, userId) => (await ca.get('/admin/partners?status=pending')).body.partners.find((p) => p.user_id === userId);
const consents = async (userId) => (await pool.query(
  `SELECT policy_id, accepted_at, ip, user_agent FROM partner_policy_consent WHERE user_id = $1 ORDER BY accepted_at`, [userId])).rows;

test('acceptance of an earlier version does not authorise approval after the policy changes', async () => {
  const { ca, applicant, ac, v1 } = await appliedUnderV1();
  const v2 = await publishV2(ca);
  assert.equal(v2.version, 2);

  const listed = await ca.get('/admin/partners?status=pending');
  assert.equal(listed.body.policy.version, 2);
  assert.equal(listed.body.policy.terms, V2_TERMS, 'Campus Control can read the version it requires');
  const p = listed.body.partners.find((x) => x.user_id === applicant.id);
  assert.equal(p.consented, false);
  assert.equal(p.consent.earlier.version, 1, 'shows which version they did accept');
  assert.deepEqual(p.approval_blockers.map((b) => b.code), ['policy_not_accepted']);

  const r = await ca.post(`/admin/partners/${applicant.id}/decide`, { decision: 'approve' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /has not accepted the current partner policy/);
  assert.match(r.body.detail, /accepted version 1 on .+; version 2, in force since .+, replaced it/);
  assert.match(r.body.detail, /Only they can accept it.*Deliver with ECHO ECHO/);
  assert.equal(r.body.detail, p.approval_blockers[0].detail, 'the list and the refusal say the same thing');
  const status = (await pool.query(`SELECT status FROM partner_profile WHERE user_id = $1`, [applicant.id])).rows[0].status;
  assert.equal(status, 'pending');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM user_role WHERE user_id = $1 AND role = 'delivery_partner'`, [applicant.id])).rows[0].n, 0);
  const denied = (await pool.query(`SELECT detail FROM audit_log WHERE action = 'partner.decide' AND outcome = 'denied' AND resource_id = $1`, [applicant.id])).rows;
  assert.equal(denied[0].detail.blocked, 'policy_not_accepted', 'the refused approval is on the record');

  /* Why the new route is needed: applying again is refused while pending. */
  assert.equal((await ac.post('/partner/apply', { acceptPolicyId: v2.id })).status, 409);
  /* The old acceptance cannot be replayed as consent to the new text. */
  assert.equal((await ac.post('/partner/policy/accept', { acceptPolicyId: v1 })).status, 400);
  assert.deepEqual((await consents(applicant.id)).map((k) => k.policy_id), [v1]);
});

test('no acceptance at all blocks approval', async () => {
  const admin = await makeUser(pool, { phone: phone(), name: 'Asha Admin', roles: ['platform_admin'] });
  const ca = await as(admin, { method: 'admin_totp' });
  const u = await makeUser(pool, { phone: phone(), name: 'No Consent' });
  await makePartnerReady(pool, u.id);
  await pool.query(`INSERT INTO partner_profile (user_id, status) VALUES ($1, 'pending')`, [u.id]);
  const r = await ca.post(`/admin/partners/${u.id}/decide`, { decision: 'approve' });
  assert.equal(r.status, 409);
  assert.match(r.body.detail, /They have not accepted version 1, in force since/);
  assert.equal((await row(ca, u.id)).approval_blockers[0].code, 'policy_not_accepted');
});

test('only the signed-in applicant can accept, for themselves', async () => {
  const { ca, applicant } = await appliedUnderV1();
  const v2 = await publishV2(ca);

  /* Signed out. */
  const anon = await client(app).post('/partner/policy/accept', { acceptPolicyId: v2.id });
  assert.equal(anon.status, 401);
  /* With the applicant's session, but from a site that is not ECHO ECHO. */
  const token = await sessionFor(pool, applicant.id);
  const forged = await app.inject({ method: 'POST', url: '/partner/policy/accept', payload: { acceptPolicyId: v2.id },
    headers: { origin: 'https://evil.example', cookie: `quad_session=${token}`, 'content-type': 'application/json' } });
  assert.equal(forged.statusCode, 403);
  /* An administrator cannot accept on their behalf: there is no user to
     name, and accepting is a student's own action. */
  const byAdmin = await ca.post('/partner/policy/accept', { acceptPolicyId: v2.id, userId: applicant.id });
  assert.equal(byAdmin.status, 403);
  /* Another student naming the applicant records only their own acceptance. */
  const other = await makeUser(pool, { phone: phone(), name: 'Other Student' });
  await pool.query(`INSERT INTO partner_profile (user_id, status) VALUES ($1, 'pending')`, [other.id]);
  const oc = await as(other);
  assert.equal((await oc.post('/partner/policy/accept', { acceptPolicyId: v2.id, userId: applicant.id })).status, 200);
  assert.deepEqual((await consents(other.id)).map((k) => k.policy_id), [v2.id]);
  /* A student with no application is sent to apply instead. */
  const stranger = await as(await makeUser(pool, { phone: phone(), name: 'No Application' }));
  assert.equal((await stranger.post('/partner/policy/accept', { acceptPolicyId: v2.id })).status, 409);

  assert.equal((await consents(applicant.id)).length, 1, 'still only their version 1 acceptance');
  assert.equal((await ca.post(`/admin/partners/${applicant.id}/decide`, { decision: 'approve' })).status, 409);
});

test('accepting the version in force, once, lets approval proceed normally - and nothing else changes', async () => {
  const { ca, applicant, ac, v1 } = await appliedUnderV1();

  /* Somebody else's real records, to prove they are untouched. */
  const partner = await makeUser(pool, { phone: phone(), name: 'Kabir Partner', roles: ['student', 'delivery_partner'] });
  await makePartnerReady(pool, partner.id);
  await pool.query(`INSERT INTO partner_profile (user_id, status) VALUES ($1, 'approved')`, [partner.id]);
  await pool.query(`INSERT INTO partner_policy_consent (user_id, policy_id) VALUES ($1, $2)`, [partner.id, v1]);
  assert.equal((await ca.post(`/admin/partners/${partner.id}/deposit/receipts`,
    { amountPaise: 20000, method: 'manual_upi', externalReference: 'UPI400011112222' })).status, 200);
  const bystander = await makeUser(pool, { phone: phone(), name: 'Plain Student' });

  const v2 = await publishV2(ca);
  const fingerprint = async () => (await pool.query(`SELECT
      /* last_seen_at moves with every signed-in request; nothing else may. */
      (SELECT md5(string_agg((to_jsonb(u) - 'last_seen_at')::text, '|' ORDER BY u.id)) FROM app_user u WHERE u.id <> $1) AS users,
      (SELECT md5(string_agg(p::text, '|' ORDER BY p.user_id)) FROM partner_profile p WHERE p.user_id <> $1) AS partners,
      (SELECT md5(COALESCE(string_agg(k::text, '|' ORDER BY k.id), '')) FROM partner_policy_consent k WHERE k.user_id <> $1) AS consents,
      (SELECT md5(COALESCE(string_agg(m::text, '|' ORDER BY m.id), '')) FROM deposit_movement m) AS deposits,
      (SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t.id), '')) FROM ledger_txn t) AS txns,
      (SELECT md5(COALESCE(string_agg(e::text, '|' ORDER BY e.id), '')) FROM ledger_entry e) AS entries,
      (SELECT md5(COALESCE(string_agg(x::text, '|' ORDER BY x.id), '')) FROM payout x) AS payouts,
      (SELECT md5(COALESCE(string_agg(d::text, '|' ORDER BY d.id), '')) FROM payout_destination d) AS destinations,
      (SELECT md5(string_agg(d::text, '|' ORDER BY d.id)) FROM partner_deposit_policy d) AS policies`, [applicant.id])).rows[0];
  const before = await fingerprint();
  const stamp = async () => (await ca.get('/admin/changes')).body.stamps.partners;
  const s0 = await stamp();

  /* What the applicant's screen reads. */
  const view = (await ac.get('/partner/deposit')).body;
  assert.equal(view.consentedToLivePolicy, false);
  assert.equal(view.policy.id, v2.id);
  assert.equal(view.policy.version, 2);
  assert.equal(view.earlierConsent.version, 1);

  /* Two tabs at once, then again: one acceptance. */
  const [a, b] = await Promise.all([1, 2].map(() => ac.post('/partner/policy/accept', { acceptPolicyId: v2.id })));
  assert.deepEqual([a.status, b.status], [200, 200], JSON.stringify([a.body, b.body]));
  assert.deepEqual([a.body.alreadyAccepted, b.body.alreadyAccepted].sort(), [false, true]);
  const again = await ac.post('/partner/policy/accept', { acceptPolicyId: v2.id });
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyAccepted, true);
  assert.equal(new Date(again.body.acceptedAt).getTime(), new Date(a.body.acceptedAt).getTime(), 'the first acceptance stands');
  assert.match(a.body.message, /version 2.*Campus admin can now review/);

  const mine = await consents(applicant.id);
  assert.deepEqual(mine.map((k) => k.policy_id), [v1, v2.id], 'version 1 kept, version 2 added once');
  assert.ok(mine[1].ip && mine[1].user_agent !== null, 'recorded with the request it came from');
  const audits = (await pool.query(`SELECT actor_id, resource_id, detail FROM audit_log WHERE action = 'partner.policy.accept'`)).rows;
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_id, applicant.id);
  assert.equal(audits[0].resource_id, v2.id);
  assert.equal(audits[0].detail.version, 2);
  assert.equal((await ac.get('/partner/deposit')).body.consentedToLivePolicy, true);

  /* Campus Control sees it without being asked, and may now approve. */
  assert.notEqual(await stamp(), s0, 'the partners page refreshes by itself');
  const p = await row(ca, applicant.id);
  assert.equal(p.consented, true);
  assert.deepEqual(p.approval_blockers, []);
  const ok = await ca.post(`/admin/partners/${applicant.id}/decide`, { decision: 'approve' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'approved');
  assert.equal((await pool.query(`SELECT status FROM user_role WHERE user_id = $1 AND role = 'delivery_partner'`, [applicant.id])).rows[0].status, 'active');

  assert.deepEqual(await fingerprint(), before, 'other people, deposits, ledger, payouts and policies unchanged');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM partner_profile WHERE user_id = $1`, [bystander.id])).rows[0].n, 0);
});

test('an approved partner can accept a newer version too; a superseded page is refused', async () => {
  const admin = await makeUser(pool, { phone: phone(), name: 'Asha Admin', roles: ['platform_admin'] });
  const ca = await as(admin, { method: 'admin_totp' });
  const partner = await makeUser(pool, { phone: phone(), name: 'Kabir Partner', roles: ['student', 'delivery_partner'] });
  const { policyId: v1 } = await makePartnerReady(pool, partner.id);
  await pool.query(`INSERT INTO partner_profile (user_id, status) VALUES ($1, 'approved')`, [partner.id]);
  const pc = await as(partner);
  const v2 = await publishV2(ca);
  const v3 = await publishV2(ca);
  assert.equal(v3.version, 3);
  const stale = await pc.post('/partner/policy/accept', { acceptPolicyId: v2.id });
  assert.equal(stale.status, 400, 'version 2 was replaced while the page was open');
  assert.match(stale.body.detail, /changed since you opened this page/);
  assert.equal((await pc.post('/partner/policy/accept', { acceptPolicyId: v3.id })).status, 200);
  assert.deepEqual((await consents(partner.id)).map((k) => k.policy_id), [v3.id]);
  assert.notEqual(v1, v3.id);
});
