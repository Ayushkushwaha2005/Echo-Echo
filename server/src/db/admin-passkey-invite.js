/* ==========================================================================
   Issue a one-time passkey invite for an ADMINISTRATOR account, from the
   server. Running this requires shell access to the deployment, which is the
   proof that an administrator is being set up by whoever controls ECHO ECHO.

     npm run admin:invite -- ayush.17551@stu.upes.ac.in

   The account must already exist and hold an administrator role: sign in
   once on the student site with the institutional email listed in
   PLATFORM_OWNER_EMAIL or PLATFORM_ADMIN_EMAILS, then run this. The code is
   printed once; only its hash is stored.
   ========================================================================== */
import { pool, one } from './index.js';
import { issueInvite, platformRolesOf, activeCredentialCount } from '../services/admin-credentials.js';

const email = String(process.argv[2] || '').trim().toLowerCase();
const die = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };
try {
  if (!email) die('Usage: npm run admin:invite -- <institutional email>');
  const u = await one(`SELECT id, name FROM app_user WHERE student_email = $1`, [email]);
  if (!u) die(`No account has verified ${email} yet. Sign in once with it on the student site first.`);
  const roles = await platformRolesOf(u.id);
  if (!roles.length) {
    die(`${email} holds no administrator role. Add it to PLATFORM_OWNER_EMAIL or PLATFORM_ADMIN_EMAILS, restart, and sign in again.`);
  }
  const existing = await activeCredentialCount(u.id);
  const out = await issueInvite(u.id, { issuedBy: null });
  console.log(`
  ECHO ECHO — administrator passkey invite
    Account   ${email}${u.name ? `  (${u.name})` : ''}
    Roles     ${roles.join(', ')}
    Code      ${out.code}
    Expires   ${new Date(out.expiresAt).toUTCString()}
${existing ? `    Note      this account already has ${existing} passkey(s); the invite only matters if all are lost\n` : ''}
    In Campus Control: sign in with the email code, choose "Set up passkey",
    enter this code, and confirm with fingerprint, face or device PIN.
    It works once. Running this again replaces it.
`);
} finally {
  await pool.end();
}
