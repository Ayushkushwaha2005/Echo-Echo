/* ==========================================================================
   TEAM CHAT (routes/chat.js, migration 035)

   * Membership is the whole access model: someone not in a conversation gets
     404 for its messages, for sending, and for marking it read, and does not
     see it in their list.
   * Only ECHO ECHO staff, from an administrator session, start conversations;
     reaching partners or cafés needs permission to view them.
   * A café conversation stays inside one café.
   * A retried send with the same clientRef stores the message once.
   * Unread counts follow last_read_at; sending is rate-limited per person.
   * Message text never reaches the audit log.
   Synthetic accounts only.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser, makeVendor } from './helpers/db.mjs';
import { makeApp, client, sessionFor } from './helpers/api.mjs';

let app, pool;
let nth = 0;
const phone = () => `+9196700${String(10000 + nth++).slice(-5)}`;

before(async () => {
  await startDb();
  Object.assign(process.env, {
    ADMIN_TOTP_KEY: 'test-admin-totp-key-0123456789abcdef',
    COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    ADMIN_PASSKEY_REQUIRED: 'true', PLATFORM_OWNER_EMAIL: 'owner.chat@stu.upes.ac.in',
  });
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE admin_account, admin_profile CASCADE');
});

const as = async (u, method = 'admin_totp') => client(app, await sessionFor(pool, u.id, { method }));
async function admin(name, permissions) {
  const u = await makeUser(pool, { phone: phone(), name, roles: ['platform_admin'] });
  await pool.query(`INSERT INTO admin_account (user_id, status, permissions, activated_at) VALUES ($1,'active',$2,now())`, [u.id, permissions]);
  return u;
}
const ownerUser = () => makeUser(pool, { phone: phone(), name: 'Owner Person', roles: ['student', 'platform_owner'] });
async function partner(name) {
  const u = await makeUser(pool, { phone: phone(), name, roles: ['student', 'delivery_partner'] });
  await pool.query(`INSERT INTO partner_profile (user_id, status) VALUES ($1,'approved')`, [u.id]);
  return u;
}
const cafeStaff = (name, vendorId, role = 'vendor_owner') => makeUser(pool, { phone: phone(), name, roles: [role], vendorId });

test('a direct chat is private to its two members', async () => {
  const o = await ownerUser();
  const p1 = await partner('Partner One');
  const p2 = await partner('Partner Two');
  const co = await as(o);
  const people = (await co.get('/chat/people?audience=partners')).body.people.map((x) => x.id).sort();
  assert.deepEqual(people, [p1.id, p2.id].sort());

  const made = await co.post('/chat/conversations', { audience: 'partners', memberIds: [p1.id] });
  assert.equal(made.status, 200);
  const id = made.body.id;
  assert.equal((await co.post('/chat/conversations', { audience: 'partners', memberIds: [p1.id] })).body.id, id, 'one direct chat per pair');

  assert.equal((await co.post(`/chat/conversations/${id}/messages`, { body: 'Can you take the 6 pm run?' })).status, 200);
  const c1 = await as(p1, 'code');
  const list = (await c1.get('/chat/conversations')).body.conversations;
  assert.equal(list.length, 1);
  assert.equal(list[0].unread, 1);
  assert.equal((await c1.get('/chat/unread')).body.unread, 1);
  assert.equal((await c1.post(`/chat/conversations/${id}/messages`, { body: 'Yes, on it.' })).status, 200);
  assert.equal((await c1.get('/chat/unread')).body.unread, 0, 'replying reads the conversation');
  const msgs = (await c1.get(`/chat/conversations/${id}/messages`)).body.messages.map((m) => m.body);
  assert.deepEqual(msgs, ['Can you take the 6 pm run?', 'Yes, on it.']);

  const c2 = await as(p2, 'code');
  assert.equal((await c2.get('/chat/conversations')).body.conversations.length, 0);
  assert.equal((await c2.get(`/chat/conversations/${id}/messages`)).status, 404);
  assert.equal((await c2.post(`/chat/conversations/${id}/messages`, { body: 'let me in' })).status, 404);
  assert.equal((await c2.post(`/chat/conversations/${id}/read`, {})).status, 404);
  assert.equal((await c2.get('/chat/conversations/not-a-uuid/messages')).status, 404);
  const n = (await pool.query(`SELECT count(*)::int AS n FROM chat_message WHERE conversation_id = $1`, [id])).rows[0].n;
  assert.equal(n, 2, 'the outsider wrote nothing');
});

test('only staff from an administrator session start conversations, within their permissions', async () => {
  const o = await ownerUser();
  const p = await partner('Partner One');
  const narrow = await admin('Narrow Admin', []);
  const v = await makeVendor(pool, { name: 'Tulips', slug: 'tulips' });
  const cafe = await cafeStaff('Cafe Owner', v.id);

  const student = await as(o, 'code');
  assert.equal((await student.post('/chat/conversations', { audience: 'partners', memberIds: [p.id] })).status, 403,
    'the student session of the owner is not an administrator session');
  assert.equal((await (await as(p, 'code')).post('/chat/conversations', { audience: 'staff', memberIds: [o.id] })).status, 403,
    'a partner cannot start conversations');
  assert.equal((await (await as(cafe, 'code')).get('/chat/people?audience=cafes')).status, 403);

  const cn = await as(narrow);
  assert.equal((await cn.post('/chat/conversations', { audience: 'partners', memberIds: [p.id] })).status, 403, 'needs partners.view');
  assert.equal((await cn.post('/chat/conversations', { audience: 'cafes', memberIds: [cafe.id] })).status, 403, 'needs cafeterias.view');
  assert.equal((await cn.post('/chat/conversations', { audience: 'staff', memberIds: [o.id] })).status, 200, 'staff may always reach staff');
  assert.equal((await cn.post('/chat/conversations', { audience: 'staff', memberIds: [p.id] })).status, 400,
    'a partner is not on the Employees tab');
  assert.equal((await client(app).get('/chat/conversations')).status, 401, 'signed out: the default-deny gate answers first');
});

test('a café conversation stays inside one café', async () => {
  const o = await ownerUser();
  const a = await makeVendor(pool, { name: 'Tulips', slug: 'tulips' });
  const b = await makeVendor(pool, { name: 'Chai Garam', slug: 'chai-garam' });
  const aOwner = await cafeStaff('Tulips Owner', a.id);
  const aStaff = await cafeStaff('Tulips Staff', a.id, 'vendor_staff');
  const bOwner = await cafeStaff('Chai Owner', b.id);
  const co = await as(o);
  const ids = async (qs) => (await co.get(`/chat/people?audience=cafes${qs}`)).body.people.map((p) => p.id).sort();
  assert.deepEqual(await ids('&role=owner'), [aOwner.id, bOwner.id].sort(), 'owners only');
  assert.deepEqual(await ids('&role=staff'), [aStaff.id], 'counter staff only');
  assert.equal((await ids('')).length, 3);
  assert.equal((await co.get('/chat/people?audience=partners&role=owner')).status, 400, 'the role filter is for cafés');

  assert.equal((await co.post('/chat/conversations', { audience: 'cafes', title: 'Mixed', memberIds: [aOwner.id, bOwner.id] })).status, 400);
  const g = await co.post('/chat/conversations', { audience: 'cafes', title: 'Tulips counter', memberIds: [aOwner.id, aStaff.id] });
  assert.equal(g.status, 200);
  assert.equal((await co.post(`/chat/conversations/${g.body.id}/members`, { userIds: [bOwner.id] })).status, 400, 'no one from another café');
  assert.equal((await co.post('/chat/conversations', { audience: 'cafes', memberIds: [aOwner.id, aStaff.id] })).status, 400,
    'a group needs a title');

  await co.post(`/chat/conversations/${g.body.id}/messages`, { body: 'Menu prices change on Monday.' });
  assert.equal((await (await as(aStaff, 'code')).get(`/chat/conversations/${g.body.id}/messages`)).status, 200);
  const outsider = await as(bOwner, 'code');
  assert.equal((await outsider.get(`/chat/conversations/${g.body.id}/messages`)).status, 404);
  assert.equal((await outsider.get('/chat/conversations?audience=cafes')).body.conversations.length, 0);
});

test('a retried send is stored once; bad input is refused; text stays out of the audit log', async () => {
  const o = await ownerUser();
  const s = await admin('Second Admin', []);
  const co = await as(o);
  const id = (await co.post('/chat/conversations', { audience: 'staff', memberIds: [s.id] })).body.id;
  const first = await co.post(`/chat/conversations/${id}/messages`, { body: 'secret-ish note', clientRef: 'retry-ref-0001' });
  const again = await co.post(`/chat/conversations/${id}/messages`, { body: 'secret-ish note', clientRef: 'retry-ref-0001' });
  assert.equal(first.status, 200);
  assert.equal(again.body.message.id, first.body.message.id);
  assert.equal(again.body.message.duplicate, true);
  for (const bad of [{ body: '' }, { body: '   ' }, { body: 'x'.repeat(4001) }, { body: 'ok', clientRef: 'bad ref!' }]) {
    assert.equal((await co.post(`/chat/conversations/${id}/messages`, bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  }
  const n = (await pool.query(`SELECT count(*)::int AS n FROM chat_message`)).rows[0].n;
  assert.equal(n, 1);
  const logged = (await pool.query(`SELECT action, detail::text AS d FROM audit_log WHERE action LIKE 'chat.%'`)).rows;
  assert.ok(logged.some((r) => r.action === 'chat.conversation.create'));
  assert.ok(logged.every((r) => !r.d.includes('secret-ish')), 'no message text in the audit log');
});

test('sending is rate-limited per person', async () => {
  const o = await ownerUser();
  const s = await admin('Second Admin', []);
  const co = await as(o);
  const id = (await co.post('/chat/conversations', { audience: 'staff', memberIds: [s.id] })).body.id;
  const codes = [];
  for (let i = 0; i < 31; i++) codes.push((await co.post(`/chat/conversations/${id}/messages`, { body: `m${i}` })).status);
  assert.equal(codes.filter((c) => c === 200).length, 30);
  assert.equal(codes[30], 429);
  const cs = await as(s);
  assert.equal((await cs.post(`/chat/conversations/${id}/messages`, { body: 'still fine for me' })).status, 200, 'the limit is per sender');
  const page = (await cs.get(`/chat/conversations/${id}/messages?limit=10`)).body.messages;
  assert.equal(page.length, 10, 'the newest page');
  assert.equal(page.at(-1).body, 'still fine for me');
  const older = (await cs.get(`/chat/conversations/${id}/messages?before=${page[0].id}&limit=100`)).body.messages;
  assert.equal(older.length, 21);
  const newer = (await cs.get(`/chat/conversations/${id}/messages?after=${page.at(-2).id}`)).body.messages;
  assert.deepEqual(newer.map((m) => m.body), ['still fine for me'], 'polling with after= returns only what is new');
});

test('signed out gets 401 everywhere; an empty list is an answer; a sent message is there after signing in again', async () => {
  const anon = client(app);
  for (const [m, u] of [['get', '/chat/conversations'], ['get', '/chat/unread'], ['get', '/chat/people?audience=staff'],
                        ['get', '/chat/conversations/00000000-0000-0000-0000-000000000000/messages']]) {
    assert.equal((await anon[m](u)).status, 401, `${u} signed out`);
  }
  assert.equal((await anon.post('/chat/conversations/00000000-0000-0000-0000-000000000000/messages', { body: 'x' })).status, 401);

  const o = await ownerUser();
  const p = await partner('Partner Fresh');
  const co = await as(o);
  const none = await co.get('/chat/conversations');
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.conversations, [], 'nobody to talk to yet: an empty list, not an error');

  const id = (await co.post('/chat/conversations', { audience: 'partners', memberIds: [p.id] })).body.id;
  const sent = await co.post(`/chat/conversations/${id}/messages`, { body: 'Persisted message check', clientRef: 'persist-1' });
  assert.equal(sent.status, 200);
  /* A new session for the same person, as after a reload or a new sign-in. */
  const again = await as(o);
  const list = (await again.get('/chat/conversations')).body.conversations;
  assert.equal(list[0].id, id);
  assert.equal(list[0].lastMessage.body, 'Persisted message check');
  const msgs = (await again.get(`/chat/conversations/${id}/messages`)).body.messages;
  assert.deepEqual(msgs.map((m) => m.id), [sent.body.message.id]);
  /* The partner, in their own session, reads it too. */
  assert.equal((await (await as(p, 'code')).get(`/chat/conversations/${id}/messages`)).body.messages[0].body, 'Persisted message check');
});
