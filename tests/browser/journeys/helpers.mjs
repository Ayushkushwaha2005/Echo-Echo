/* Synthetic fixtures for the browser journeys. Written straight to the disposable
   test database; nothing here can reach a real service. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, createHmac } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, '..', '..', '..', 'server');
const require = createRequire(join(server, 'package.json'));
const pg = require('pg');
const scrypt = await import('node:crypto');

const port = readFileSync(join(server, 'var', 'pgport'), 'utf8').trim();
export const db = new pg.Pool({ connectionString: `postgres://quad:quad@127.0.0.1:${port}/quad_test`, max: 2 });

export const PASSWORD = 'Correct-Horse-Battery-77!';

export async function mailbox() {
  return (await fetch('http://127.0.0.1:4175/')).json();
}
export async function lastMailTo(email, re) {
  for (let i = 0; i < 40; i++) {
    const hit = [...await mailbox()].reverse().find((m) => m.to?.[0] === email && re.test(m.text));
    if (hit) return hit.text.match(re);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no mail to ${email} matching ${re}`);
}

/* RFC 6238, the same construction the server verifies. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function totp(secret) {
  let bits = '';
  for (const ch of secret.replace(/\s/g, '').toUpperCase()) { const v = B32.indexOf(ch); if (v >= 0) bits += v.toString(2).padStart(5, '0'); }
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const step = Buffer.alloc(8);
  step.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', key).update(step).digest();
  const off = h[h.length - 1] & 15;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1000000).padStart(6, '0');
}

let n = 0;
export const phone = () => `+9198${String(Date.now() % 100000).padStart(5, '0')}${String(n++ % 1000).padStart(3, '0')}`;

export async function userWith({ name, roles = ['student'], email = null, permissions = null, vendorId = null }) {
  const { rows: [u] } = await db.query(`INSERT INTO app_user (phone, name) VALUES ($1,$2) RETURNING id`, [phone(), name]);
  if (email) await db.query(`UPDATE app_user SET student_email = $2, student_email_verified_at = now() WHERE id = $1`, [u.id, email]);
  for (const role of roles) {
    await db.query(`INSERT INTO user_role (user_id, role, vendor_id, granted_via) VALUES ($1,$2,$3,'api')`, [u.id, role, role.startsWith('vendor') ? vendorId : null]);
  }
  if (permissions) await db.query(`INSERT INTO admin_account (user_id, status, permissions, activated_at) VALUES ($1,'active',$2, now())`, [u.id, permissions]);
  return u;
}

/* A signed-in browser, using the real cookie. */
export async function signInAs(context, userId, method = 'admin_totp') {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO session (token_hash, user_id, expires_at, auth_method, passkey_verified_at, campus_presence_at, campus_presence_site_id)
     VALUES ($1,$2, now() + interval '2 hours', $3, CASE WHEN $3 IN ('passkey','admin_totp') THEN now() END, now(),
             (SELECT campus_site_id FROM app_user WHERE id = $2))`,
    [createHash('sha256').update(token).digest('hex'), userId, method]);
  await context.addCookies([{ name: 'quad_session', value: token, url: 'http://127.0.0.1:4173' }]);
  return token;
}

export async function owner() {
  const existing = (await db.query(`SELECT user_id FROM user_role WHERE role = 'platform_owner' AND status = 'active' LIMIT 1`)).rows[0];
  if (existing) return { id: existing.user_id };
  return userWith({ name: 'Test Owner', roles: ['student', 'platform_owner'], email: `owner.browser@stu.upes.ac.in` });
}

export async function vendor(name = 'Browser Cafe') {
  const site = (await db.query(`SELECT id FROM campus_site ORDER BY created_at LIMIT 1`)).rows[0];
  const { rows: [v] } = await db.query(
    `INSERT INTO vendor (slug, name, kind, campus_site_id, is_open, accepting, active, description)
     VALUES ($1,$2,'Campus outlet',$3,true,true,true,'A synthetic cafe') RETURNING *`,
    [`${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now() % 100000}-${n++}`, name, site?.id || null]);
  return v;
}

/* Everything the page logged as blocked or broken. A CSP violation fails a journey. */
export function watchProblems(page) {
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}
export { scrypt };
