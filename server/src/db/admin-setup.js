/* ==========================================================================
   ECHO ECHO — ADMINISTRATOR SIGN-IN SET-UP  (server shell only)

     npm run admin:setup                    # the owner, from PLATFORM_OWNER_EMAIL
     npm run admin:setup -- --email a@b.c   # an existing administrator

   Sets a password and provisions an authenticator secret for an account that
   holds a platform role. It runs on the server, where controlling the host
   is the proof of ownership — the same reason the old owner enrolment code
   was issued here and not over the API.

   The password can be given with --password or ADMIN_SETUP_PASSWORD; with
   neither, it is asked for on the terminal and not echoed.

   The authenticator secret is printed ONCE. It is stored encrypted and no
   API returns it, so if it is lost the only route is to run this again.
   ========================================================================== */
import { createInterface } from 'node:readline';
import { q, one, pool } from './index.js';
import { PLATFORM_OWNER, ADMIN_AUTH } from '../config.js';
import { setPassword, beginAuthenticator, credentialStatus, validatePassword } from '../services/admin-auth.js';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};

const ask = (question, { hidden = false } = {}) => new Promise((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    /* Suppress the echo without suppressing the prompt itself. */
    const out = rl.output;
    rl._writeToOutput = (s) => { if (s.includes(question)) out.write(s); };
  }
  rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
});

const box = (lines) => {
  const w = Math.max(...lines.map((l) => l.length));
  console.log(`\n  ┌─${'─'.repeat(w)}─┐`);
  for (const l of lines) console.log(`  │ ${l.padEnd(w)} │`);
  console.log(`  └─${'─'.repeat(w)}─┘\n`);
};

async function main() {
  if (!ADMIN_AUTH.configured) {
    console.error('✗ ADMIN_TOTP_KEY (or a COOKIE_SECRET of at least 32 characters) must be set.');
    console.error('  Authenticator secrets are encrypted with it; without one they cannot be stored.');
    process.exit(1);
  }

  const email = String(arg('email') || PLATFORM_OWNER.email || '').trim().toLowerCase();
  if (!email) {
    console.error('✗ No account given. Set PLATFORM_OWNER_EMAIL, or pass --email someone@stu.upes.ac.in');
    process.exit(1);
  }
  const isOwner = PLATFORM_OWNER.emailValid && email === PLATFORM_OWNER.email;

  /* The account. For the owner this may not exist yet — the mailbox is named
     in server configuration, which is the authority for who the owner is, so
     creating the row here is bootstrap rather than self-promotion. For
     anybody else the account must already hold a platform role, granted by
     the owner. */
  let u = await one(`SELECT id, name, student_email, status FROM app_user WHERE student_email = $1`, [email]);
  if (!u) {
    if (!isOwner) {
      console.error(`✗ No account for ${email}.`);
      console.error('  Invite them from Campus Control first; this command only sets up an existing administrator.');
      process.exit(1);
    }
    u = await one(
      `INSERT INTO app_user (student_email, student_email_verified_at, name, student_status)
       VALUES ($1, now(), $2, 'approved') RETURNING id, name, student_email, status`,
      [email, PLATFORM_OWNER.name]);
    console.log(`· created the platform owner account for ${email}`);
  }
  if (u.status !== 'active') {
    console.error(`✗ ${email} is ${u.status}. Restore the account before setting up sign-in.`);
    process.exit(1);
  }

  if (isOwner) {
    /* One owner, established from configuration and nowhere else. */
    await q(`UPDATE user_role SET role = 'platform_admin'
              WHERE role = 'platform_owner' AND user_id <> $1
                AND NOT EXISTS (SELECT 1 FROM user_role x WHERE x.user_id = user_role.user_id AND x.role = 'platform_admin')`, [u.id]);
    await q(`UPDATE user_role SET status = 'revoked', revoked_at = now()
              WHERE role = 'platform_owner' AND user_id <> $1`, [u.id]);
    await q(`INSERT INTO user_role (user_id, role, granted_via) VALUES ($1,'platform_owner','bootstrap_config')
             ON CONFLICT (user_id, role, COALESCE(vendor_id,'00000000-0000-0000-0000-000000000000'::uuid))
             DO UPDATE SET status = 'active', revoked_at = NULL`, [u.id]);
    await q(`INSERT INTO user_role (user_id, role) VALUES ($1,'student')
             ON CONFLICT DO NOTHING`, [u.id]);
    await q(`UPDATE app_user SET student_email_verified_at = coalesce(student_email_verified_at, now()),
                    student_status = 'approved', name = coalesce(nullif(trim(name),''), $2)
              WHERE id = $1`, [u.id, PLATFORM_OWNER.name]);
  } else {
    const roles = (await q(
      `SELECT role FROM user_role WHERE user_id = $1 AND status = 'active'`, [u.id])).rows.map((r) => r.role);
    if (!roles.some((r) => ['platform_admin', 'support'].includes(r))) {
      console.error(`✗ ${email} holds no administrator role. The owner grants that from Campus Control.`);
      process.exit(1);
    }
    await q(`UPDATE admin_account SET status = 'active', activated_at = coalesce(activated_at, now()),
                    updated_at = now() WHERE user_id = $1 AND status = 'invited'`, [u.id]);
  }

  /* ---- password ---- */
  let password = arg('password') || process.env.ADMIN_SETUP_PASSWORD || null;
  if (!password) {
    password = await ask(`\n  Password for ${email} (at least 12 characters, not echoed): `, { hidden: true });
    const again = await ask('  Type it again: ', { hidden: true });
    if (password !== again) { console.error('\n✗ The two passwords do not match.'); process.exit(1); }
  }
  try { validatePassword(password, { email }); }
  catch (e) { console.error(`\n✗ ${e.message}${e.detail ? ` — ${e.detail}` : ''}`); process.exit(1); }
  await setPassword(u.id, password, { email });

  /* ---- authenticator ---- */
  const before = await credentialStatus(u.id);
  const totp = await beginAuthenticator(u.id, email);

  console.log(`\n✓ Password set for ${email}`);
  if (before.authenticatorReady) {
    console.log('! The authenticator that was enrolled before is now void. Use the new secret below.');
  }
  box([
    'ECHO ECHO — Campus Control sign-in',
    '',
    `Account    ${email}`,
    `Role       ${isOwner ? 'platform owner' : 'administrator'}`,
    '',
    'Add this to Microsoft Authenticator:',
    '  Add account → Other account → Enter key manually',
    '',
    `  Account name   ${ADMIN_AUTH.totpIssuer}`,
    `  Secret key     ${totp.secret}`,
    '',
    'Or open this URI on the phone (it opens the app directly):',
    ...wrap(totp.uri, 66).map((l) => `  ${l}`),
    '',
    `Time-based, ${totp.digits} digits, ${totp.periodSeconds}s, ${totp.algorithm}.`,
  ]);
  console.log('  The secret is shown once and stored encrypted. Nothing can read it back.');
  console.log('  It is NOT confirmed yet: sign in at Campus Control with your email, this');
  console.log('  password and the code the app is showing. That first correct code confirms it.\n');

  /* The secret is usable immediately for sign-in; confirming it is what the
     first successful sign-in does, which is why nothing is marked confirmed
     here. Mark it confirmed only if a code is supplied now. */
  const code = arg('code');
  if (code) {
    const { confirmAuthenticator } = await import('../services/admin-auth.js');
    await confirmAuthenticator(u.id, code);
    console.log('✓ Authenticator confirmed.\n');
  }
}

const wrap = (s, n) => s.match(new RegExp(`.{1,${n}}`, 'g')) || [s];

main()
  .then(() => pool.end())
  .catch(async (e) => { console.error(`\n✗ ${e.message}`); await pool.end(); process.exit(1); });
