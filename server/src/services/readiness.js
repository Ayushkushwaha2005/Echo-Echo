/* ==========================================================================
   ECHO ECHO - LAUNCH READINESS

   One list of everything that must be true before real students use the
   product, each item marked done / pending / not needed yet, with who has to
   act. Derived only from configuration flags and database state. It never
   returns a credential, a URL containing one, or any personal data.
   ========================================================================== */
import { q, one } from '../db/index.js';
import { HTTP, DB, STORAGE, NOTIFY, STUDENT_EMAIL, PLATFORM_OWNER, ADMIN, WEBAUTHN, PAYMENTS } from '../config.js';

const item = (area, key, label, done, { owner = 'Ayush', how, blocking = true, deferred = false } = {}) =>
  ({ area, key, label, status: deferred ? 'deferred' : done ? 'done' : 'pending', blocking: !deferred && blocking, owner, how });

export async function readiness({ campusSlug = 'upes-bidholi' } = {}) {
  const origins = HTTP.origin.split(',').map((s) => s.trim());
  const realDomain = origins.every((o) => /^https:\/\//.test(o) && !/localhost|127\.0\.0\.1|onrender\.com$/.test(o));
  const campus = await one(`SELECT id, name FROM campus_site WHERE slug = $1`, [campusSlug]);
  const counts = campus ? await one(
    `SELECT (SELECT count(*)::int FROM campus_boundary WHERE campus_site_id = $1 AND status = 'active') AS boundary,
            (SELECT count(*)::int FROM campus_boundary WHERE campus_site_id = $1 AND status = 'proposed') AS proposals,
            (SELECT count(*)::int FROM campus_node WHERE campus_site_id = $1 AND active AND verification = 'confirmed'
               AND deliverable AND lat IS NOT NULL) AS delivery_points,
            (SELECT count(*)::int FROM campus_node WHERE campus_site_id = $1 AND active AND verification = 'pending') AS pending_points,
            (SELECT count(*)::int FROM vendor WHERE campus_site_id = $1 AND active) AS cafeterias,
            (SELECT count(*)::int FROM vendor v JOIN campus_node n ON n.id = v.campus_node_id
              WHERE v.campus_site_id = $1 AND v.active AND n.verification = 'confirmed' AND n.lat IS NOT NULL) AS pickups`,
    [campus.id]) : {};
  const admins = await one(
    `SELECT (SELECT count(*)::int FROM user_role r WHERE r.role = 'platform_owner' AND r.status = 'active'
               AND EXISTS (SELECT 1 FROM webauthn_credential w WHERE w.user_id = r.user_id AND w.revoked_at IS NULL)) AS owner_passkey,
            (SELECT count(*)::int FROM admin_account WHERE status = 'active') AS other_admins,
            (SELECT count(*)::int FROM admin_invitation WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS invites`);
  const seed = (await q(`SELECT count(*)::int n FROM campus_node WHERE source = 'unverified_seed'`)).rows[0].n;

  const items = [
    item('Infrastructure', 'domain', 'A domain you own, served over HTTPS (WEB_ORIGIN)', realDomain, { how: 'Buy or use an existing domain; set WEB_ORIGIN, WEBAUTHN_RP_ID, WEBAUTHN_ORIGINS. DEPLOY.md §1.' }),
    item('Infrastructure', 'database', 'Managed PostgreSQL over TLS', DB.configured && !DB.looksLocal && !!DB.ssl, { how: 'Neon Free project; DATABASE_URL with sslmode=require. DEPLOY.md §2.' }),
    item('Infrastructure', 'storage', 'Private S3-compatible bucket', STORAGE.productionReady, { how: 'Backblaze B2 private bucket + restricted key; npm run check:storage. DEPLOY.md §3.' }),
    item('Infrastructure', 'email', 'Resend with a verified sending domain', NOTIFY.email.configured && STUDENT_EMAIL.configured, { how: 'Needs the domain first. npm run check:email. DEPLOY.md §4.' }),
    item('Infrastructure', 'secrets', 'COOKIE_SECRET set (32+ characters)', !!HTTP.cookieSecret && HTTP.cookieSecret.length >= 32, { how: 'openssl rand -hex 32; keep in your password manager.' }),
    item('Infrastructure', 'backups', 'Daily encrypted database backup running', false, { how: 'GitHub Actions db-backup workflow + B2 backups bucket; confirm a file arrives. BACKUP-RECOVERY.md.', blocking: true }),
    item('Administrators', 'owner', 'Owner configured and has a passkey', PLATFORM_OWNER.configured && admins.owner_passkey > 0, { how: 'Sign in, then npm run admin:invite on the server shell. ADMIN-ACCESS.md.' }),
    item('Administrators', 'rp', 'Passkeys bound to the production domain', ADMIN.passkeyRequired && !!process.env.WEBAUTHN_RP_ID && realDomain, { how: `Currently RP ID "${WEBAUTHN.rpId}". Set WEBAUTHN_RP_ID to your domain.` }),
    item('Administrators', 'second_admin', `A second administrator is active (${admins.other_admins} invited through Campus Control)`, admins.other_admins > 0, { how: admins.invites ? 'An invitation is waiting for sign-in.' : 'Invite Anushka with her real UPES email: Administrators → Invite administrator. Check the list to confirm who is active.', blocking: false }),
    item('Campus', 'boundary', `Campus boundary confirmed on the ground${counts.proposals ? ` (${counts.proposals} proposal(s) waiting)` : ''}`, counts.boundary > 0, { how: 'Walk the perimeter, import it, compare with the OSM proposal, then Confirm and activate. CAMPUS-FIELD-COLLECTION.md.' }),
    item('Campus', 'delivery_points', `Confirmed delivery points with positions (${counts.delivery_points || 0})`, counts.delivery_points > 0, { how: `Record on site. ${counts.pending_points || 0} candidate(s) pending confirmation.` }),
    item('Campus', 'cafeterias', `Cafeterias created (${counts.cafeterias || 0})`, counts.cafeterias > 0, { how: 'Create Chai Garam, Frisco, Tulips in Cafeterias.' }),
    item('Campus', 'pickups', `Cafeteria pickup points confirmed (${counts.pickups || 0} of ${counts.cafeterias || 0})`, counts.cafeterias > 0 && counts.pickups >= counts.cafeterias, { how: 'Record each counter with GPS on site; set it on the cafeteria.' }),
    item('Data', 'no_seed', 'No development seed data', seed === 0, { owner: 'automatic', how: 'Never run npm run seed against production.' }),
    item('Policy', 'upes_delivery', 'UPES permission for student delivery on campus and hostels', false, { how: 'Written confirmation from UPES administration / hostel office.', blocking: true }),
    item('Policy', 'alumni_mailboxes', 'UPES answer on when student mailboxes are disabled', false, { how: 'Ask UPES IT; set STUDENT_EMAIL_REVERIFY_DAYS accordingly. STUDENT-VERIFICATION.md.', blocking: false }),
    item('Payments', 'gateway', 'Payment gateway (deferred until after deployment)', PAYMENTS.configured, { how: 'Cashfree/Razorpay KYC. PAYMENTS-PROVIDER.md.', deferred: !PAYMENTS.configured }),
  ];
  const pending = items.filter((i) => i.status === 'pending');
  return {
    campus: campus?.name || null,
    summary: { done: items.filter((i) => i.status === 'done').length, pending: pending.length,
               blocking: pending.filter((i) => i.blocking).length, deferred: items.filter((i) => i.status === 'deferred').length },
    items,
    note: 'Manual items (backups, UPES permission, mailbox policy) stay pending here until you record them elsewhere; the server cannot observe them.',
  };
}
