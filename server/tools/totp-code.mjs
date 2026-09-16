/* Dev helper: prints the authenticator code an administrator's app would be
   showing right now. Used by the test suite and by local QA so a sign-in can
   be exercised without a phone. Reads the encrypted secret the same way the
   server does; it is not a bypass, because it needs the database and the
   ADMIN_TOTP_KEY. */
import pg from 'pg';
import { decryptSecret, totpAt, stepNow } from '../src/services/admin-auth.js';

const [email, offset = '0'] = process.argv.slice(2);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const { rows } = await c.query(
  `SELECT ac.totp_secret_enc FROM admin_credential ac
     JOIN app_user u ON u.id = ac.user_id WHERE u.student_email = $1`, [email]);
await c.end();
if (!rows[0]?.totp_secret_enc) { console.error(`No authenticator enrolled for ${email}`); process.exit(1); }
process.stdout.write(totpAt(decryptSecret(rows[0].totp_secret_enc), stepNow() + Number(offset)));
