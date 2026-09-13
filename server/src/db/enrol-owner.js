/* ==========================================================================
   QUAD — BOOTSTRAP THE PLATFORM OWNER

     npm run enrol:owner

   Issues a one-time enrolment code for PLATFORM_OWNER_PHONE and prints it to
   the terminal. This is the only way into the owner account that does not
   need an SMS provider, and it is deliberately a server-side command: being
   able to run it means controlling the host, which is the strongest proof of
   ownership available without a third party.

   No API can do this. `assertEnrollable()` refuses the platform owner
   precisely so that an administrator cannot mint their way into the account
   that can grant admin.
   ========================================================================== */
import { pool } from './index.js';
import { PLATFORM_OWNER, DB } from '../config.js';
import { issueCode, TTL_MINUTES } from '../services/enrolment.js';

const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };

if (!DB.configured) die('DATABASE_URL is not set.');
if (!PLATFORM_OWNER.configured) {
  die('PLATFORM_OWNER_PHONE is not set (E.164, e.g. +919876543210).');
}

try {
  const owner = (await pool.query(
    `SELECT id, name FROM app_user WHERE phone = $1`, [PLATFORM_OWNER.phone])).rows[0];
  if (!owner) {
    die(`No account exists for ${PLATFORM_OWNER.phone}. Run \`npm run migrate\` first — ` +
        'it creates the owner and grants the platform_owner role.');
  }

  const isOwner = await pool.query(
    `SELECT 1 FROM user_role
      WHERE user_id = $1 AND role = 'platform_owner' AND status = 'active'`, [owner.id]);
  if (!isOwner.rowCount) {
    die(`${PLATFORM_OWNER.phone} exists but does not hold platform_owner. ` +
        'Run `npm run migrate` to establish it.');
  }

  const out = await issueCode(owner.id, { issuedBy: null, via: 'bootstrap' });

  const hours = Math.round(TTL_MINUTES / 60);
  console.log(`
  ┌──────────────────────────────────────────────┐
  │  Quad — platform owner enrolment code        │
  └──────────────────────────────────────────────┘

    Account   ${PLATFORM_OWNER.phone}${out.name ? `  (${out.name})` : ''}
    Code      ${out.code}
    Expires   in ${hours} hour${hours === 1 ? '' : 's'}

    Sign in at Campus Control, choose "Use an enrolment code",
    and enter this number and code.

    It works once. Running this command again replaces it.
    This code is not stored anywhere — only its hash is.
`);
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error(`\n✗ ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exit(1);
}
