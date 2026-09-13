/* ==========================================================================
   Enforced-authentication tests.
   Run with the flag ON, in a separate process, so the live prototype is
   never affected:

       AUTH_ENABLED=true PRIMARY_ADMIN_EMAIL=you@campus.edu.in \
         node tests/auth-enforced.mjs
   ========================================================================== */
import { CONFIG_FLAGS, PRIMARY_ADMIN, assertConfigured } from '../packages/data/config.js';
import {
  login, setCredential, requireSurfaceAccess, requireVendorAccess, issueSession,
  revokeSession, sessionFromToken, seedDemoCredentials, primaryAdminUser,
  Unauthenticated, Forbidden, SESSIONS, clearAttempts,
} from '../packages/data/auth.js';
import { api, authorize, userById, USERS } from '../packages/data/api.js';
import { ITEMS } from '../packages/data/catalog.js';

let fails = 0, count = 0;
const ok = (c, m) => { count++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const rejects = async (m, fn, expect) => {
  count++;
  try { await fn(); console.log(`  FAIL  ${m} — was ALLOWED`); fails++; }
  catch (e) {
    const good = !expect || e.name === expect;
    console.log(`  ${good ? 'PASS' : 'FAIL'}  ${m} → ${e.name} ${e.status || ''}: ${e.message}`);
    if (!good) fails++;
  }
};
const allows = async (m, fn) => {
  count++;
  try { await fn(); console.log(`  PASS  ${m}`); }
  catch (e) { console.log(`  FAIL  ${m} — denied: ${e.name}: ${e.message}`); fails++; }
};

console.log(`\n=== Mode: AUTH_ENABLED=${CONFIG_FLAGS.AUTH_ENABLED} ===`);
ok(CONFIG_FLAGS.AUTH_ENABLED === true, 'Flag is ON for this process only');

console.log('\n== Boot configuration ==');
const boot = assertConfigured();
ok(boot.ok, `Boot check: ${boot.note}`);
ok(PRIMARY_ADMIN.configured, `Primary admin comes from env, not from code: ${PRIMARY_ADMIN.email}`);
ok(!!primaryAdminUser(), 'Primary admin user is derivable from server config');
ok(primaryAdminUser().role === 'platform_owner', 'Primary admin holds platform_owner');
ok(CONFIG_FLAGS.SHOW_DEMO_ACCOUNTS === false, 'Demo account list is off when auth is enforced');

console.log('\n== Demo credentials are refused in enforced mode ==');
const seeded = await seedDemoCredentials(USERS, 'anything');
ok(seeded.seeded === 0, `seedDemoCredentials refused: ${seeded.note}`);

/* Set real credentials the way the enrolment flow would. */
await setCredential('usr_admin', 'correct-horse-battery');
await setCredential('usr_owner_frisco', 'frisco-owner-pw');
await setCredential('usr_1', 'student-pw');

console.log('\n== Authentication ==');
await rejects('Unknown email', () => login({ email: 'nobody@campus.edu.in', password: 'x', surface: 'admin', users: USERS }), 'Unauthenticated');
await rejects('Wrong password', () => login({ email: 'meera.r@campus.edu.in', password: 'wrong', surface: 'admin', users: USERS }), 'Unauthenticated');
clearAttempts('meera.r@campus.edu.in');
let adminSession;
await allows('Correct admin credentials', async () => { adminSession = await login({ email: 'meera.r@campus.edu.in', password: 'correct-horse-battery', surface: 'admin', users: USERS }); });
ok(adminSession && adminSession.authenticated === true, 'Session is marked authenticated');
ok(!!adminSession.token && adminSession.token.length >= 32, 'Session carries an opaque token');
ok(sessionFromToken(adminSession.token) !== null, 'Token resolves to a live session');

console.log('\n== Role verification at the door ==');
let friscoSession;
await allows('Frisco owner signs in to the Counter', async () => { friscoSession = await login({ email: 'ravi.frisco@campus.edu.in', password: 'frisco-owner-pw', surface: 'counter', users: USERS }); });
await rejects('Frisco owner signs in to Campus Control', () => login({ email: 'ravi.frisco@campus.edu.in', password: 'frisco-owner-pw', surface: 'admin', users: USERS }), 'Forbidden');
clearAttempts('ravi.frisco@campus.edu.in');
await rejects('Student signs in to Campus Control', () => login({ email: 'ayush.k23@campus.edu.in', password: 'student-pw', surface: 'admin', users: USERS }), 'Forbidden');
clearAttempts('ayush.k23@campus.edu.in');
await rejects('Student signs in to the Counter', () => login({ email: 'ayush.k23@campus.edu.in', password: 'student-pw', surface: 'counter', users: USERS }), 'Forbidden');
clearAttempts('ayush.k23@campus.edu.in');
ok(friscoSession.vendor === 'caf_frisco', 'Counter session is bound to one cafeteria');

console.log('\n== Surface gate ==');
await rejects('No session reaches Campus Control', () => requireSurfaceAccess(null, 'admin'), 'Unauthenticated');
await rejects('No session reaches the Counter', () => requireSurfaceAccess(null, 'counter'), 'Unauthenticated');
await allows('Admin session opens Campus Control', () => requireSurfaceAccess(adminSession, 'admin'));
await rejects('Counter session opens Campus Control', () => requireSurfaceAccess(friscoSession, 'admin'), 'Forbidden');
await rejects('Unauthenticated object is refused', () => requireSurfaceAccess({ ...userById('usr_admin'), authenticated: false }, 'admin'), 'Unauthenticated');

console.log('\n== Expiry & revocation ==');
const expired = issueSession(userById('usr_admin'));
expired.expiresAt = Date.now() - 1000;
await rejects('Expired session is refused at the door', () => requireSurfaceAccess(expired, 'admin'), 'Unauthenticated');
await rejects('Expired session is refused at authorize()', () => authorize(expired, 'menu.update', 'caf_frisco'), 'Unauthenticated');
ok(sessionFromToken(expired.token) === null, 'Expired token no longer resolves');
const revocable = issueSession(userById('usr_admin'));
revokeSession(revocable.token);
ok(sessionFromToken(revocable.token) === null, 'Revoked token no longer resolves (sign-out works)');

console.log('\n== authorize() demands authentication ==');
const bare = { ...userById('usr_admin') };            // no `authenticated`
await rejects('Hand-made session object cannot mutate', () => api.updateItem(bare, ITEMS[0].id, { desc: 'x' }), 'Unauthenticated');
await rejects('Hand-made admin cannot create a cafeteria', () => api.createVendor(bare, { name: 'Rogue' }), 'Unauthenticated');
await allows('Authenticated admin can mutate', () => api.updateItem(adminSession, ITEMS[0].id, { desc: ITEMS[0].desc }));

console.log('\n== Suspended accounts ==');
const suspended = issueSession(userById('usr_admin'));
suspended.status = 'suspended';
await rejects('Suspended account is refused', () => authorize(suspended, 'menu.update', 'caf_frisco'), 'Forbidden');

console.log('\n== Scoping still applies to authenticated sessions ==');
const tItem = ITEMS.find((i) => i.caf === 'caf_tulips');
await allows('Authenticated Frisco owner edits Frisco', () => api.updateItem(friscoSession, ITEMS.find((i) => i.caf === 'caf_frisco').id, { desc: 'ok' }));
await rejects('Authenticated Frisco owner edits Tulips', () => api.updateItem(friscoSession, tItem.id, { desc: 'x' }), 'Denied');
await rejects('Direct resource access to another outlet returns 403', () => requireVendorAccess(friscoSession, 'caf_tulips'), 'Forbidden');
const fb = (() => { try { requireVendorAccess(friscoSession, 'caf_tulips'); } catch (e) { return e; } })();
ok(fb.status === 403, 'It is a 403 refusal, not a redirect');
await allows('Admin session passes the vendor guard for any outlet', () => requireVendorAccess(adminSession, 'caf_tulips'));

console.log('\n== Lockout ==');
const key = 'ravi.frisco@campus.edu.in';
clearAttempts(key);
for (let i = 0; i < CONFIG_FLAGS.MAX_LOGIN_ATTEMPTS; i++) {
  try { await login({ email: key, password: 'nope', surface: 'counter', users: USERS }); } catch { /* expected */ }
}
await rejects(`Locked out after ${CONFIG_FLAGS.MAX_LOGIN_ATTEMPTS} failures`, () => login({ email: key, password: 'frisco-owner-pw', surface: 'counter', users: USERS }), 'Forbidden');
clearAttempts(key);
await allows('Lockout clears', async () => login({ email: key, password: 'frisco-owner-pw', surface: 'counter', users: USERS }));

console.log('\n== Credentials are never stored in the clear ==');
const { CREDENTIALS } = await import('../packages/data/auth.js');
const rec = CREDENTIALS.get('usr_admin');
ok(rec && rec.hash && rec.hash.length === 64, 'Stored as a 64-char hash');
ok(!JSON.stringify(rec).includes('correct-horse-battery'), 'Plaintext password is not present in the record');
ok(!!rec.salt && rec.salt.length >= 8, 'Each credential has its own salt');

console.log(`\n${fails === 0 ? `ALL ${count} CHECKS PASSED` : `${fails} of ${count} FAILED`}`);
process.exit(fails ? 1 : 0);
