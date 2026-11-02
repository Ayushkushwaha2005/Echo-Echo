/* ==========================================================================
   ECHO ECHO — TEAM CHAT (shared by Campus Control and the counter app)

     mountChat(box, { quad, staff, me, toast, explain, can })

   `staff` (Campus Control) shows the Employees / Delivery Partners / Cafés
   tabs and can start one-to-one and group conversations. Without it (the
   counter app) the person sees the conversations they were added to and
   replies in them. The server decides who may read and write each
   conversation; this screen only shows what it is given.

   Loading. The tabs, the list and the thread pane are drawn at once, with
   placeholder rows, and the conversations fill in when the server answers.
   This browser tab keeps the last list it was given for THIS signed-in
   person (sessionStorage, keyed by their id; titles, members and counts,
   never message text) and shows it straight away while the new one loads.
   One list request at a time; a newer one cancels the older, and an answer
   that arrives after a newer one is dropped. A failure is named for what it
   is (packages/data/retry.js) and only a failure another attempt can fix is
   retried, a few times with growing waits. Try again starts a fresh request
   and cannot be pressed twice; the list also recovers by itself when the
   connection comes back or the tab becomes visible.

   No socket: the open conversation asks for new messages every 5 seconds and
   the list every 30, only while the tab is visible and this screen is open.
   A refresh redraws in place: the open conversation, what is being typed and
   both scroll positions stay as they were. A message is shown as
   "Sending…" until the server has stored it, and a failed send keeps its
   text with a Retry that reuses the same clientRef, so a retry never stores
   it twice.
   ========================================================================== */
import { failure, retrying } from '../data/retry.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TABS = [['staff', 'Employees'], ['partners', 'Delivery Partners'], ['cafes', 'Cafés']];
const THREAD_POLL_MS = 5_000;
const LIST_POLL_MS = 30_000;
/* One attempt may take this long; a server waking from sleep answers in about 13 s. */
const REQUEST_TIMEOUT_MS = 20_000;
const CACHE = (me) => `echo.chat.v1.${me}`;

const time = (iso) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const ref = () => (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
/* Message ids are bigserial, sent as strings: compare them as numbers. */
const byId = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);

/* The list as this browser tab last saw it, for this person only. */
function readCache(me) {
  if (!me) return null;
  try {
    const v = JSON.parse(sessionStorage.getItem(CACHE(me)) || 'null');
    return v?.me === me && Array.isArray(v.list) ? v.list : null;
  } catch { return null; }
}
function writeCache(me, list) {
  if (!me) return;
  try {
    const safe = list.map(({ lastMessage, ...c }) => ({ ...c, lastMessage: lastMessage ? { createdAt: lastMessage.createdAt } : null }));
    sessionStorage.setItem(CACHE(me), JSON.stringify({ me, list: safe }));
  } catch { /* storage full or blocked: the list still loads from the server */ }
}

export function mountChat(box, { quad, staff = false, me = null, toast = () => {}, explain = (e) => e.message, can = () => true }) {
  const tabs = staff ? TABS.filter(([k]) => k === 'staff' || (k === 'partners' ? can('partners.view') : can('cafeterias.view'))) : [];
  const cached = readCache(me);
  const C = {
    tab: tabs[0]?.[0] || null, me, list: cached || [], loaded: !!cached, fromCache: !!cached,
    listFail: null, staleFail: null, listRetry: null, open: null, thread: null, threadFail: null, threadRetry: null,
    pending: [], timers: [], stopped: false,
  };
  const L = { req: null, ctl: null, seq: 0 };          // the one list request in flight
  const T = { ctl: null, seq: 0, polling: false };      // the open conversation's requests

  const nameOf = (id) => C.thread?.members.find((m) => m.id === id)?.name || 'Someone';
  const titleOf = (c) => c.title || (c.members || []).filter((m) => m.id !== C.me).map((m) => m.name).join(', ') || 'Conversation';
  const visibleList = () => (staff ? C.list.filter((c) => c.audience === C.tab) : C.list);
  const unreadIn = (k) => C.list.filter((c) => c.audience === k).reduce((n, c) => n + (c.unread || 0), 0);

  /* One redraw for everything, which keeps what the person is doing: the
     draft and its cursor, the list's scroll, and the thread's scroll - kept
     on the newest message only if they were already at the bottom. */
  function paint({ toEnd = false } = {}) {
    if (!box.isConnected) return stop();
    const old = box.querySelector('#chat-input');
    const draft = old?.value || '', focused = !!old && document.activeElement === old;
    const caret = focused ? [old.selectionStart, old.selectionEnd] : null;
    const listY = box.querySelector('.chat-list')?.scrollTop || 0;
    const oldLog = box.querySelector('.chat-log');
    const atEnd = !oldLog || oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 40;
    const logY = oldLog?.scrollTop || 0;
    box.innerHTML = `
      ${staff ? `<nav class="chat-tabs" aria-label="Who to message">${tabs.map(([k, l]) => `
        <button type="button" class="chat-tab" data-chat="tab" data-tab="${k}" ${C.tab === k ? 'aria-current="page"' : ''}>${esc(l)}${unreadIn(k) ? ` <span class="chat-badge">${unreadIn(k)}</span>` : ''}</button>`).join('')}</nav>` : ''}
      <div class="chat ${C.open ? 'has-open' : ''}">
        <aside class="chat-list" aria-label="Conversations" aria-busy="${!C.loaded && !C.listFail}">
          ${staff ? '<button type="button" class="btn btn-primary btn-sm chat-new" data-chat="new">New conversation</button>' : ''}
          ${listHtml()}
        </aside>
        <section class="chat-thread" aria-label="Messages">${threadHtml()}</section>
      </div>`;
    box.querySelector('.chat-list').scrollTop = listY;
    const log = box.querySelector('.chat-log');
    if (log) log.scrollTop = toEnd || atEnd ? log.scrollHeight : logY;
    const input = box.querySelector('#chat-input');
    if (input && draft) input.value = draft;
    if (input && focused) { input.focus(); if (caret) input.setSelectionRange(...caret); }
  }

  /* A named failure: what happened, what to do, and Try again only if it can help. */
  function failHtml(f, act, busy) {
    const action = f.kind === 'signed_out'
      ? `<a class="btn btn-primary btn-sm" href="${esc(location.pathname)}">Sign in again</a>`
      : f.retryable
        ? `<button type="button" class="btn btn-secondary btn-sm" data-chat="${act}"${busy ? ' disabled' : ''}>${busy ? 'Trying…' : 'Try again'}</button>`
        : '';
    return `<div class="chat-state chat-state-${esc(f.kind)}" role="alert">
      <b>${esc(f.title)}</b>${f.detail ? `<span>${esc(f.detail)}</span>` : ''}${action}</div>`;
  }
  const retryNote = (r) => (r ? `<p class="chat-note" role="status">${esc(r.failure.title)}. Trying again (${r.attempt} of ${r.of})…</p>` : '');

  function listHtml() {
    if (!C.loaded) {
      if (C.listFail) return failHtml(C.listFail, 'reload', !!L.req);
      return `${retryNote(C.listRetry)}<p class="chat-sr" role="status">Loading conversations</p>
        ${[0, 1, 2, 3].map(() => '<div class="chat-skel" aria-hidden="true"><span class="skel"></span><span class="skel"></span></div>').join('')}`;
    }
    let note = '';
    if (C.staleFail) {
      const f = C.staleFail;
      const act = f.kind === 'signed_out' ? `<a href="${esc(location.pathname)}">Sign in again</a>`
        : f.retryable ? `<button type="button" class="btn btn-ghost btn-sm" data-chat="reload"${L.req ? ' disabled' : ''}>Try again</button>` : '';
      note = `<div class="chat-note is-warn" role="status">Not up to date: ${esc(f.title)} ${act}</div>`;
    } else if (C.fromCache) note = '<p class="chat-note" role="status">Showing your last list · updating…</p>';
    const rows = visibleList();
    if (!rows.length) {
      return `${note}<p class="chat-empty">${staff ? 'No conversations here yet. Start one with someone on this tab.'
        : 'No messages yet. ECHO ECHO staff can message you here, and you can reply.'}</p>`;
    }
    return note + rows.map((c) => `
      <button type="button" class="chat-row${C.open === c.id ? ' is-open' : ''}" data-chat="open" data-id="${esc(c.id)}">
        <span class="chat-row-top"><b>${esc(titleOf(c))}</b>${c.unread ? `<span class="chat-badge">${c.unread}</span>` : ''}</span>
        <span class="chat-row-sub">${c.lastMessage?.body ? esc(c.lastMessage.body) : c.lastMessage ? '…' : 'No messages yet'}</span>
        <span class="chat-row-time">${c.kind === 'group' ? `Group · ${(c.members || []).length} people` : 'One-to-one'}${c.vendorName ? ` · ${esc(c.vendorName)}` : ''}${c.lastMessageAt ? ` · ${esc(time(c.lastMessageAt))}` : ''}</span>
      </button>`).join('');
  }

  function threadHtml() {
    if (!C.open) return `<p class="chat-empty chat-pick">Choose a conversation${staff ? ', or start a new one' : ''}.</p>`;
    if (!C.thread) {
      if (C.threadFail) return `<div class="chat-pad">${failHtml(C.threadFail, 'reopen', !!T.ctl)}</div>`;
      return `<div class="chat-log" aria-busy="true">${retryNote(C.threadRetry)}<p class="chat-sr" role="status">Loading messages</p>
        ${['', ' mine', ''].map((m) => `<div class="chat-msg chat-msg-skel${m}" aria-hidden="true"><span class="skel"></span></div>`).join('')}</div>`;
    }
    const t = C.thread;
    return `
      <header class="chat-head">
        <button type="button" class="btn btn-ghost btn-sm chat-back" data-chat="back" aria-label="Back to conversations">←</button>
        <div><b>${esc(t.conversation.title || t.members.filter((m) => m.id !== t.me).map((m) => m.name).join(', '))}</b>
          <span class="chat-members">${esc(t.members.map((m) => (m.id === t.me ? 'You' : m.name)).join(', '))}</span></div>
        ${staff && t.conversation.kind === 'group' ? '<button type="button" class="btn btn-ghost btn-sm" data-chat="add">Add people</button>' : ''}
      </header>
      <div class="chat-log" role="log" aria-live="polite">
        ${t.more ? '<button type="button" class="btn btn-ghost btn-sm chat-older" data-chat="older">Show earlier messages</button>' : ''}
        ${!t.messages.length && !C.pending.length ? '<p class="chat-empty">No messages yet. Say hello.</p>' : ''}
        ${t.messages.map((m) => `
          <div class="chat-msg${m.senderId === t.me ? ' mine' : ''}">
            ${m.senderId === t.me ? '' : `<span class="chat-who">${esc(nameOf(m.senderId))}</span>`}
            <p>${esc(m.body)}</p><time datetime="${esc(m.createdAt)}">${esc(time(m.createdAt))}</time></div>`).join('')}
        ${C.pending.map((p) => `
          <div class="chat-msg mine is-pending">
            <p>${esc(p.body)}</p>
            ${p.failed ? `<span class="chat-fail" role="alert">Not sent: ${esc(p.failed)} <button type="button" class="btn btn-ghost btn-sm" data-chat="retry" data-ref="${esc(p.ref)}">Retry</button>
              <button type="button" class="btn btn-ghost btn-sm" data-chat="discard" data-ref="${esc(p.ref)}">Discard</button></span>` : '<time>Sending…</time>'}</div>`).join('')}
      </div>
      <form class="chat-compose" data-chat-form>
        <label class="chat-sr" for="chat-input">Message</label>
        <textarea id="chat-input" class="input" name="body" rows="2" maxlength="4000" placeholder="Write a message" required></textarea>
        <button type="submit" class="btn btn-primary">Send</button>
      </form>`;
  }

  /* The conversation list. A call while one is in flight joins it, unless
     `fresh` (Try again), which cancels it and starts over. A background
     refresh tries once and, if it fails, keeps the list on screen. */
  function loadList({ fresh = false, background = false } = {}) {
    if (L.req && !fresh) return L.req;
    L.ctl?.abort('cancelled');
    const ctl = new AbortController(), mine = ++L.seq;
    L.ctl = ctl;
    L.req = retrying(() => quad.chatConversations(undefined, { signal: ctl.signal, timeoutMs: REQUEST_TIMEOUT_MS }), {
      attempts: background ? 1 : 3, signal: ctl.signal, what: 'Your conversations',
      onRetry: (r) => { if (mine === L.seq && !C.loaded) { C.listRetry = r; paint(); } },
    }).then((r) => {
      if (mine !== L.seq) return;
      C.list = r.conversations; C.me = r.me; C.loaded = true; C.fromCache = false;
      C.listFail = C.staleFail = C.listRetry = null;
      if (staff && !tabs.some(([k]) => k === C.tab)) C.tab = tabs[0]?.[0];
      if (r.me === me) writeCache(me, r.conversations);
    }, (e) => {
      if (mine !== L.seq) return;
      const f = failure(e, 'Your conversations');
      if (f.kind === 'cancelled') return;
      C.listRetry = null;
      if (C.loaded) C.staleFail = f; else C.listFail = f;
    }).finally(() => { if (mine === L.seq) { L.req = null; L.ctl = null; } });
    return L.req;
  }
  const refreshList = (opts) => loadList(opts).then(() => { if (!C.stopped) paint(); });

  async function openThread(id) {
    T.ctl?.abort('cancelled');
    const ctl = new AbortController(), mine = ++T.seq;
    T.ctl = ctl;
    C.open = id; C.thread = null; C.threadFail = null; C.threadRetry = null; C.pending = [];
    paint();
    try {
      const r = await retrying(() => quad.chatMessages(id, { limit: 50 }, { signal: ctl.signal, timeoutMs: REQUEST_TIMEOUT_MS }), {
        signal: ctl.signal, what: 'This conversation',
        onRetry: (x) => { if (mine === T.seq) { C.threadRetry = x; paint(); } },
      });
      if (mine !== T.seq) return;
      C.thread = { ...r, messages: [...r.messages].sort(byId), more: r.messages.length === 50 };
      C.me = r.me;
      quad.chatRead(id).catch(() => {});
      const row = C.list.find((c) => c.id === id); if (row) row.unread = 0;
    } catch (e) {
      if (mine !== T.seq) return;
      const f = failure(e, 'This conversation');
      if (f.kind === 'cancelled') return;
      C.threadFail = f;
    } finally { if (mine === T.seq) T.ctl = null; }
    C.threadRetry = null;
    paint({ toEnd: true });
    if (C.thread) box.querySelector('#chat-input')?.focus();
  }
  async function pollThread() {
    const t = C.thread;
    if (!t || T.polling || document.visibilityState !== 'visible') return;
    T.polling = true;
    const last = t.messages.at(-1)?.id;
    try {
      const r = await quad.chatMessages(t.conversation.id, last ? { after: last } : { limit: 50 }, { timeoutMs: REQUEST_TIMEOUT_MS });
      if (C.thread !== t || !r.messages.length) return;
      const seen = new Set(t.messages.map((m) => m.id));
      t.messages.push(...r.messages.filter((m) => !seen.has(m.id)));
      t.messages.sort(byId);
      t.members = r.members;
      quad.chatRead(t.conversation.id).catch(() => {});
      paint();
    } catch { /* the next tick tries again */ } finally { T.polling = false; }
  }
  async function send(p) {
    const t = C.thread;
    p.failed = null; paint({ toEnd: true });
    try {
      const r = await quad.chatSend(t.conversation.id, { body: p.body, clientRef: p.ref });
      C.pending = C.pending.filter((x) => x !== p);
      if (!t.messages.some((m) => m.id === r.message.id)) { t.messages.push(r.message); t.messages.sort(byId); }
      refreshList({ background: true });
    } catch (e) { p.failed = explain(e); }
    if (C.thread === t) paint({ toEnd: true });
  }

  /* Choosing people: a search over who this tab can reach. */
  async function pickPeople({ title, group, existing = [] }) {
    const audience = C.tab;
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modalwrap';
      wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-labelledby', 'chat-pick-title');
      wrap.innerHTML = `<div class="scrim-fixed" data-x="cancel"></div>
        <form class="modal" novalidate>
          <div class="modal-head"><h2 class="t-h3" id="chat-pick-title">${esc(title)}</h2></div>
          <div class="modal-body stack">
            ${group === null ? `<div class="chat-seg" role="group" aria-label="Kind">
              <button type="button" class="chat-seg-btn" data-kind="direct" aria-pressed="true">One-to-one</button>
              <button type="button" class="chat-seg-btn" data-kind="group" aria-pressed="false">Group</button></div>` : ''}
            <label class="field chat-title-field" ${group ? '' : 'hidden'}><span class="t-label">Group name</span>
              <input class="input" name="title" maxlength="80" placeholder="e.g. Evening delivery shift"></label>
            ${audience === 'cafes' ? `<div class="chat-seg" role="group" aria-label="Who at the café">
              <button type="button" class="chat-seg-btn" data-role="" aria-pressed="true">Owners and staff</button>
              <button type="button" class="chat-seg-btn" data-role="owner" aria-pressed="false">Owners</button>
              <button type="button" class="chat-seg-btn" data-role="staff" aria-pressed="false">Staff</button></div>` : ''}
            <label class="field"><span class="t-label">Search</span><input class="input" name="q" placeholder="Name${audience === 'cafes' ? ' or café' : ''}" autocomplete="off"></label>
            <div class="chat-people" role="group" aria-label="People"><p class="chat-empty">Loading…</p></div>
            <p class="t-xs muted chat-pick-msg" role="alert"></p>
          </div>
          <div class="modal-foot"><button type="button" class="btn btn-ghost" data-x="cancel">Cancel</button>
            <button type="submit" class="btn btn-primary">${group === true ? 'Add' : 'Start'}</button></div>
        </form>`;
      document.body.append(wrap);
      let kind = group ? 'group' : 'direct';
      let role = '';
      const chosen = new Set();
      const list = wrap.querySelector('.chat-people');
      const msg = wrap.querySelector('.chat-pick-msg');
      const done = (v) => { wrap.remove(); resolve(v); };
      let seq = 0;
      async function search() {
        const mine = ++seq;
        try {
          const r = await quad.chatPeople(audience, wrap.querySelector('[name=q]').value.trim(), role || undefined);
          if (mine !== seq) return;
          const people = r.people.filter((p) => !existing.includes(p.id));
          list.innerHTML = people.length ? people.map((p) => `
            <label class="chat-person"><input type="${kind === 'group' ? 'checkbox' : 'radio'}" name="who" value="${esc(p.id)}" ${chosen.has(p.id) ? 'checked' : ''}>
              <span><b>${esc(p.name)}</b><span class="t-xs muted"> ${esc(p.detail)}</span></span></label>`).join('')
            : '<p class="chat-empty">No one to show. Only active accounts on this tab can be messaged.</p>';
        } catch (e) { list.innerHTML = `<p class="chat-empty" role="alert">${esc(explain(e))}</p>`; }
      }
      let debounce;
      wrap.querySelector('[name=q]').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(search, 250); });
      list.addEventListener('change', (e) => {
        if (kind === 'direct') chosen.clear();
        if (e.target.checked) chosen.add(e.target.value); else chosen.delete(e.target.value);
      });
      wrap.addEventListener('click', (e) => {
        if (e.target.closest('[data-x="cancel"]')) return done(null);
        const rb = e.target.closest('[data-role]');
        if (rb) {
          role = rb.dataset.role;
          wrap.querySelectorAll('[data-role]').forEach((b) => b.setAttribute('aria-pressed', String(b === rb)));
          search(); return;
        }
        const k = e.target.closest('[data-kind]');
        if (k) {
          kind = k.dataset.kind; chosen.clear();
          wrap.querySelectorAll('[data-kind]').forEach((b) => b.setAttribute('aria-pressed', String(b === k)));
          wrap.querySelector('.chat-title-field').hidden = kind !== 'group';
          search();
        }
      });
      wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
      wrap.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        const t = wrap.querySelector('[name=title]').value.trim();
        if (!chosen.size) { msg.textContent = 'Choose at least one person.'; return; }
        if (group === null && kind === 'group' && !t) { msg.textContent = 'Give the group a name.'; return; }
        done({ ids: [...chosen], title: kind === 'group' ? t : '' });
      });
      search();
      wrap.querySelector('[name=q]').focus();
    });
  }

  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-chat]');
    if (!b) return;
    const a = b.dataset.chat;
    if (a === 'tab') { C.tab = b.dataset.tab; C.open = null; C.thread = null; T.ctl?.abort('cancelled'); paint(); }
    else if (a === 'open') openThread(b.dataset.id);
    else if (a === 'reopen') { if (!T.ctl) openThread(C.open); }
    else if (a === 'back') { C.open = null; C.thread = null; T.ctl?.abort('cancelled'); paint(); }
    else if (a === 'reload') {
      /* A fresh request, once: the button shows "Trying…" and is disabled while it runs. */
      if (b.disabled) return;
      C.listFail = null; C.staleFail = null; C.listRetry = null;
      const p = refreshList({ fresh: true });
      paint();
      await p;
    }
    else if (a === 'retry') { const p = C.pending.find((x) => x.ref === b.dataset.ref); if (p) send(p); }
    else if (a === 'discard') { C.pending = C.pending.filter((x) => x.ref !== b.dataset.ref); paint(); }
    else if (a === 'older') {
      const t = C.thread;
      try {
        const r = await quad.chatMessages(t.conversation.id, { before: t.messages[0]?.id, limit: 50 }, { timeoutMs: REQUEST_TIMEOUT_MS });
        if (C.thread !== t) return;
        const seen = new Set(t.messages.map((m) => m.id));
        t.messages.unshift(...r.messages.filter((m) => !seen.has(m.id)));
        t.messages.sort(byId);
        t.more = r.messages.length === 50; paint();
        box.querySelector('.chat-log').scrollTop = 0;
      } catch (err) { toast(explain(err), 'bad'); }
    } else if (a === 'new') {
      const pick = await pickPeople({ title: `New conversation · ${TABS.find(([k]) => k === C.tab)[1]}`, group: null });
      if (!pick) return;
      try {
        const r = await quad.chatStart({ audience: C.tab, memberIds: pick.ids, title: pick.title || undefined });
        await loadList({ fresh: true }); openThread(r.id);
      } catch (err) { toast(explain(err), 'bad'); }
    } else if (a === 'add') {
      const pick = await pickPeople({ title: 'Add people', group: true, existing: C.thread.members.map((m) => m.id) });
      if (!pick) return;
      try { await quad.chatAddMembers(C.thread.conversation.id, pick.ids); toast('Added'); openThread(C.thread.conversation.id); }
      catch (err) { toast(explain(err), 'bad'); }
    }
  });
  box.addEventListener('submit', (e) => {
    if (!e.target.matches('[data-chat-form]')) return;
    e.preventDefault();
    const input = e.target.elements.body;
    const body = input.value.trim();
    if (!body || !C.thread) return;
    input.value = '';
    const p = { ref: ref(), body, failed: null };
    C.pending.push(p);
    send(p);
  });
  box.addEventListener('keydown', (e) => {
    if (e.target.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault(); e.target.form.requestSubmit();
    }
  });

  /* Recovering by itself: when the connection comes back or the tab is
     looked at again, a list or conversation that failed is asked for once. */
  const recover = () => {
    if (C.stopped || !box.isConnected) return stop();
    if (document.visibilityState !== 'visible') return;
    if (!L.req && (C.listFail?.retryable || C.staleFail?.retryable)) {
      C.listFail = null; C.staleFail = null;
      const p = refreshList({ fresh: true }); paint(); return p;
    }
    if (C.threadFail?.retryable && !T.ctl) openThread(C.open);
  };
  globalThis.addEventListener?.('online', recover);
  document.addEventListener('visibilitychange', recover);

  function stop() {
    if (C.stopped) return;
    C.stopped = true;
    C.timers.forEach(clearInterval); C.timers = [];
    L.ctl?.abort('cancelled'); T.ctl?.abort('cancelled');
    globalThis.removeEventListener?.('online', recover);
    document.removeEventListener('visibilitychange', recover);
  }
  C.timers.push(setInterval(() => { if (!box.isConnected) return stop(); pollThread(); }, THREAD_POLL_MS));
  C.timers.push(setInterval(() => {
    if (!box.isConnected) return stop();
    if (document.visibilityState !== 'visible' || C.listFail) return;
    refreshList({ background: true });
  }, LIST_POLL_MS));

  /* Drawn now; filled in when the server answers. */
  paint();
  refreshList();
  return { stop };
}
