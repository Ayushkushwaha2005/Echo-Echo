/* ==========================================================================
   ECHO ECHO — ADMINISTRATOR SIGN-IN STATUS  (read-only)

     npm run admin:status:local                    # the owner
     npm run admin:status:local -- --email a@b.c   # another administrator

   Answers "does this account exist, and is its Campus Control sign-in set
   up?" BEFORE anything is changed. Every query runs inside a READ ONLY
   transaction, so PostgreSQL itself refuses a write from this script, and
   it is rolled back at the end regardless. Nothing secret is printed: not
   the password hash, not the authenticator secret, not ADMIN_TOTP_KEY.

   If an authenticator secret is stored, it also tells you whether the local
   ADMIN_TOTP_KEY is the key that encrypted it, i.e. whether it is the same
   value production uses. That check decrypts in memory and prints only
   "matches" or "does not match".
   ========================================================================== */
import { pool } from '../src/db/index.js';
import { PLATFORM_OWNER, ADMIN_AUTH, DB } from '../src/config.js';
import { decryptSecret } from '../src/services/admin-auth.js';

const i = process.argv.indexOf('--email');
const email = String((i > -1 && process.argv[i + 1]) || PLATFORM_OWNER.email || '').trim().toLowerCase();
const line = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);
const when = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');

if (!DB.configured) { console.error('✗ DATABASE_URL is not set.'); process.exit(1); }
if (!email) { console.error('✗ Set PLATFORM_OWNER_EMAIL, or pass --email.'); process.exit(1); }

const c = await pool.connect();
try {
  await c.query('BEGIN READ ONLY');
  const one = async (sql, args = []) => (await c.query(sql, args)).rows[0] || null;

  console.log('\nWhich database');
  line('host', (() => { try { return new URL(DB.url).hostname; } catch { return '(unparseable URL)'; } })());
  const mig = await one(`SELECT count(*)::int AS n FROM schema_migration`).catch(() => null);
  line('migrations applied', mig ? mig.n : 'no schema_migration table — this is not an ECHO ECHO database');
  const outlets = (await c.query(`SELECT name FROM vendor ORDER BY name`).catch(() => ({ rows: [] }))).rows;
  line('cafeterias', outlets.map((r) => r.name).join(', ') || '(none)');

  console.log(`\nAccount ${email}`);
  const u = await one(`SELECT id, status, student_email_verified_at, created_at FROM app_user WHERE student_email = $1`, [email]);
  if (!u) {
    line('exists', 'NO — admin:setup would create it (owner only)');
  } else {
    line('exists', `yes, created ${when(u.created_at)}`);
    line('status', u.status);
    line('mailbox proven', when(u.student_email_verified_at));
    const roles = (await c.query(
      `SELECT role, status FROM user_role WHERE user_id = $1 ORDER BY role`, [u.id])).rows;
    line('roles', roles.map((r) => `${r.role}${r.status === 'active' ? '' : ` (${r.status})`}`).join(', ') || '(none)');

    const cred = await one(
      `SELECT password_hash IS NOT NULL AS has_password, password_updated_at,
              totp_secret_enc, totp_confirmed_at, locked_until, last_login_at, failed_attempts
         FROM admin_credential WHERE user_id = $1`, [u.id]);
    console.log('\nCampus Control sign-in');
    line('password set', cred?.has_password ? `yes, ${when(cred.password_updated_at)}` : 'NO');
    line('authenticator stored', cred?.totp_secret_enc ? 'yes' : 'NO');
    line('authenticator confirmed', cred?.totp_confirmed_at ? when(cred.totp_confirmed_at) : 'no');
    line('last sign-in', when(cred?.last_login_at));
    line('locked until', cred?.locked_until && new Date(cred.locked_until) > new Date() ? when(cred.locked_until) : 'not locked');

    console.log('\nLocal ADMIN_TOTP_KEY');
    if (!ADMIN_AUTH.totpKey) {
      line('present', 'NO — admin:setup needs the exact value from Render');
    } else if (ADMIN_AUTH.totpKey.length < 32) {
      line('present', `too short (${ADMIN_AUTH.totpKey.length} chars) — not Render's generated value`);
    } else if (cred?.totp_secret_enc) {
      let ok = false;
      try { decryptSecret(cred.totp_secret_enc); ok = true; } catch { ok = false; }
      line('matches production', ok ? 'YES — it decrypts the stored authenticator'
        : 'NO — it did not encrypt the stored authenticator; re-copy it from Render');
    } else {
      line('present', `yes (${ADMIN_AUTH.totpKey.length} chars); nothing stored to check it against`);
    }
  }
  console.log('\nNothing was changed (read-only transaction, rolled back).\n');
} finally {
  await c.query('ROLLBACK').catch(() => {});
  c.release();
  await pool.end();
}
