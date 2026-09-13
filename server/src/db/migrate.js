/* Applies numbered .sql files once each, in order, inside a transaction. */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './index.js';
import { PLATFORM_OWNER, DB } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));

if (!DB.configured) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const c = await pool.connect();
try {
  await c.query(`CREATE TABLE IF NOT EXISTS schema_migration (
                   name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(here)).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  for (const f of files) {
    const done = await c.query(`SELECT 1 FROM schema_migration WHERE name = $1`, [f]);
    if (done.rowCount) { console.log(`· ${f} (already applied)`); continue; }
    await c.query('BEGIN');
    try {
      await c.query(await readFile(join(here, f), 'utf8'));
      await c.query(`INSERT INTO schema_migration (name) VALUES ($1)`, [f]);
      await c.query('COMMIT');
      console.log(`✓ ${f}`);
    } catch (e) {
      await c.query('ROLLBACK');
      console.error(`✗ ${f}: ${e.message}`);
      process.exit(1);
    }
  }

  /* Establish the platform owner. This is the ONLY place the role is
     created; no API grants it. Re-running is idempotent, and if the phone
     changes, the previous owner is demoted to admin rather than deleted. */
  if (PLATFORM_OWNER.emailValid && !PLATFORM_OWNER.phoneValid) {
    /* An owner identified by institutional email. The account cannot be
       created here - it comes into existence when that mailbox is proven with
       the email code - but if it already exists, the role is (re)applied. */
    const u = (await c.query(`SELECT id FROM app_user WHERE student_email = $1`, [PLATFORM_OWNER.email])).rows[0];
    if (u) {
      await c.query('BEGIN');
      await c.query(`UPDATE user_role SET role='platform_admin' WHERE role='platform_owner' AND user_id <> $1
                       AND NOT EXISTS (SELECT 1 FROM user_role x WHERE x.user_id = user_role.user_id AND x.role='platform_admin')`, [u.id]);
      await c.query(`UPDATE user_role SET status='revoked', revoked_at=now() WHERE role='platform_owner' AND user_id <> $1`, [u.id]);
      await c.query(`INSERT INTO user_role (user_id, role, granted_via) VALUES ($1,'platform_owner','migration')
                     ON CONFLICT (user_id, role, COALESCE(vendor_id,'00000000-0000-0000-0000-000000000000'::uuid))
                     DO UPDATE SET status='active', revoked_at=NULL`, [u.id]);
      await c.query('COMMIT');
      console.log(`✓ platform owner: ${PLATFORM_OWNER.email}`);
    } else {
      console.log(`· platform owner ${PLATFORM_OWNER.email}: granted when that mailbox first signs in with its email code`);
    }
  } else if (PLATFORM_OWNER.phoneValid) {
    await c.query('BEGIN');
    const u = (await c.query(
      `INSERT INTO app_user (phone, name) VALUES ($1,$2)
       ON CONFLICT (phone) DO UPDATE SET name = coalesce(app_user.name, $2)
       RETURNING id`, [PLATFORM_OWNER.phone, PLATFORM_OWNER.name])).rows[0];
    await c.query(
      `UPDATE user_role SET role='platform_admin'
        WHERE role='platform_owner' AND user_id <> $1`, [u.id]);
    await c.query(
      `INSERT INTO user_role (user_id, role) VALUES ($1,'platform_owner')
       ON CONFLICT DO NOTHING`, [u.id]);
    await c.query(
      `INSERT INTO user_role (user_id, role) VALUES ($1,'student')
       ON CONFLICT DO NOTHING`, [u.id]);
    await c.query('COMMIT');
    console.log(`✓ platform owner: ${PLATFORM_OWNER.phone}`);
  } else {
    console.warn('! Neither PLATFORM_OWNER_EMAIL nor PLATFORM_OWNER_PHONE is set — no platform owner established.');
  }
} finally {
  c.release();
  await pool.end();
}
