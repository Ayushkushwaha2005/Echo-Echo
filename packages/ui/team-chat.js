/* ==========================================================================
   ECHO ECHO — TEAM CHAT (shared by Campus Control and the counter app)

     mountChat(box, { quad, staff, toast, explain })

   `staff` (Campus Control) shows the Employees / Delivery Partners / Cafés
   tabs and can start one-to-one and group conversations. Without it (the
   counter app) the person sees the conversations they were added to and
   replies in them. The server decides who may read and write each
   conversation; this screen only shows what it is given.

   No socket: the open conversation asks for new messages every 5 seconds and
   the list every 30, only while the tab is visible and this screen is open.
   A message is shown as "Sending…" until the server has stored it, and a
   failed send keeps its text with a Retry that reuses the same clientRef,
   so a retry never stores it twice.
   ========================================================================== */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TABS = [['staff', 'Employees'], ['partners', 'Delivery Partners'], ['cafes', 'Cafés']];
const THREAD_POLL_MS = 5_000;
const LIST_POLL_MS = 30_000;

const time = (iso) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const ref = () => (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

export function mountChat(box, { quad, staff = false, toast = () => {}, explain = (e) => e.message, can = () => true }) {
  const tabs = staff ? TABS.filter(([k]) => k === 'staff' || (k === 'partners' ? can('partners.view') : can('cafeterias.view'))) : [];
  const C = { tab: tabs[0]?.[0] || null, list: [], open: null, thread: null, pending: [], timers: [], error: '', listError: '' };

  const nameOf = (id) => C.thread?.members.find((m) => m.id === id)?.name || 'Someone';
  const titleOf = (c) => c.title || (c.members || []).filter((m) => m.id !== C.me).map((m) => m.name).join(', ') || 'Conversation';

  function paint() {
    if (!box.isConnected) return stop();
    box.innerHTML = `
      ${staff ? `<nav class="chat-tabs" aria-label="Who to message">${tabs.map(([k, l]) => `
        <button type="button" class="chat-tab" data-chat="tab" data-tab="${k}" ${C.tab === k ? 'aria-current="page"' : ''}>${esc(l)}${unreadIn(k) ? ` <span class="chat-badge">${unreadIn(k)}</span>` : ''}</button>`).join('')}</nav>` : ''}
      <div class="chat ${C.open ? 'has-open' : ''}">
        <aside class="chat-list" aria-label="Conversations">
          ${staff ? '<button type="button" class="btn btn-primary btn-sm chat-new" data-chat="new">New conversation</button>' : ''}
          ${C.listError ? `<p class="chat-empty" role="alert">${esc(C.listError)} <button type="button" class="btn btn-ghost btn-sm" data-chat="reload">Try again</button></p>`
            : !visibleList().length ? `<p class="chat-empty">${staff ? 'No conversations here yet. Start one with someone on this tab.' : 'No messages yet. ECHO ECHO staff can message you here, and you can reply.'}</p>`
            : visibleList().map((c) => `
              <button type="button" class="chat-row${C.open === c.id ? ' is-open' : ''}" data-chat="open" data-id="${esc(c.id)}">
                <span class="chat-row-top"><b>${esc(titleOf(c))}</b>${c.unread ? `<span class="chat-badge">${c.unread}</span>` : ''}</span>
                <span class="chat-row-sub">${c.lastMessage ? esc(c.lastMessage.body) : 'No messages yet'}</span>
                <span class="chat-row-time">${c.kind === 'group' ? `Group · ${(c.members || []).length} people` : 'One-to-one'}${c.vendorName ? ` · ${esc(c.vendorName)}` : ''}${c.lastMessageAt ? ` · ${esc(time(c.lastMessageAt))}` : ''}</span>
              </button>`).join('')}
        </aside>
        <section class="chat-thread" aria-label="Messages">${threadHtml()}</section>
      </div>`;
    const log = box.querySelector('.chat-log');
    if (log) log.scrollTop = log.scrollHeight;
  }
  const visibleList = () => (staff ? C.list.filter((c) => c.audience === C.tab) : C.list);
  const unreadIn = (k) => C.list.filter((c) => c.audience === k).reduce((n, c) => n + (c.unread || 0), 0);

  function threadHtml() {
    if (!C.open) return `<p class="chat-empty chat-pick">Choose a conversation${staff ? ', or start a new one' : ''}.</p>`;
    if (C.error && !C.thread) return `<p class="chat-empty" role="alert">${esc(C.error)} <button type="button" class="btn btn-ghost btn-sm" data-chat="reopen">Try again</button></p>`;
    if (!C.thread) return '<p class="chat-empty">Loading messages…</p>';
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

  async function loadList() {
    try {
      const r = await quad.chatConversations();
      C.list = r.conversations; C.me = r.me; C.listError = '';
      if (staff && !tabs.some(([k]) => k === C.tab)) C.tab = tabs[0]?.[0];
    } catch (e) { C.listError = explain(e); }
  }
  async function openThread(id) {
    C.open = id; C.thread = null; C.error = ''; C.pending = []; paint();
    try {
      const r = await quad.chatMessages(id, { limit: 50 });
      if (C.open !== id) return;
      C.thread = { ...r, more: r.messages.length === 50 };
      C.me = r.me;
      await quad.chatRead(id).catch(() => {});
      const row = C.list.find((c) => c.id === id); if (row) row.unread = 0;
    } catch (e) { if (C.open === id) C.error = explain(e); }
    paint();
    box.querySelector('#chat-input')?.focus();
  }
  async function pollThread() {
    const t = C.thread;
    if (!t || document.visibilityState !== 'visible') return;
    const last = t.messages.at(-1)?.id;
    try {
      const r = await quad.chatMessages(t.conversation.id, last ? { after: last } : { limit: 50 });
      if (C.thread !== t || !r.messages.length) return;
      const seen = new Set(t.messages.map((m) => m.id));
      t.messages.push(...r.messages.filter((m) => !seen.has(m.id)));
      t.members = r.members;
      await quad.chatRead(t.conversation.id).catch(() => {});
      paintKeepingDraft();
    } catch { /* the next tick tries again */ }
  }
  async function send(p) {
    p.failed = null; paint();
    try {
      const r = await quad.chatSend(C.thread.conversation.id, { body: p.body, clientRef: p.ref });
      C.pending = C.pending.filter((x) => x !== p);
      if (!C.thread.messages.some((m) => m.id === r.message.id)) C.thread.messages.push(r.message);
      loadList().then(paintKeepingDraft);
    } catch (e) { p.failed = explain(e); }
    paintKeepingDraft();
  }
  /* Repaint without losing what the person is typing, or their cursor. */
  function paintKeepingDraft() {
    const old = box.querySelector('#chat-input');
    const draft = old?.value || '', focused = old && document.activeElement === old;
    paint();
    const input = box.querySelector('#chat-input');
    if (input && draft) input.value = draft;
    if (input && focused) input.focus();
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
            <label class="field"><span class="t-label">Search</span><input class="input" name="q" placeholder="Name${audience === 'cafes' ? ' or café' : ''}" autocomplete="off"></label>
            <div class="chat-people" role="group" aria-label="People"><p class="chat-empty">Loading…</p></div>
            <p class="t-xs muted chat-pick-msg" role="alert"></p>
          </div>
          <div class="modal-foot"><button type="button" class="btn btn-ghost" data-x="cancel">Cancel</button>
            <button type="submit" class="btn btn-primary">${group === true ? 'Add' : 'Start'}</button></div>
        </form>`;
      document.body.append(wrap);
      let kind = group ? 'group' : 'direct';
      const chosen = new Set();
      const list = wrap.querySelector('.chat-people');
      const msg = wrap.querySelector('.chat-pick-msg');
      const done = (v) => { wrap.remove(); resolve(v); };
      let seq = 0;
      async function search() {
        const mine = ++seq;
        try {
          const r = await quad.chatPeople(audience, wrap.querySelector('[name=q]').value.trim());
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
    if (a === 'tab') { C.tab = b.dataset.tab; C.open = null; C.thread = null; paint(); }
    else if (a === 'open') openThread(b.dataset.id);
    else if (a === 'reopen') openThread(C.open);
    else if (a === 'back') { C.open = null; C.thread = null; paint(); }
    else if (a === 'reload') { await loadList(); paint(); }
    else if (a === 'retry') { const p = C.pending.find((x) => x.ref === b.dataset.ref); if (p) send(p); }
    else if (a === 'discard') { C.pending = C.pending.filter((x) => x.ref !== b.dataset.ref); paintKeepingDraft(); }
    else if (a === 'older') {
      const t = C.thread;
      try {
        const r = await quad.chatMessages(t.conversation.id, { before: t.messages[0]?.id, limit: 50 });
        t.messages.unshift(...r.messages); t.more = r.messages.length === 50; paint();
        box.querySelector('.chat-log').scrollTop = 0;
      } catch (err) { toast(explain(err), 'bad'); }
    } else if (a === 'new') {
      const pick = await pickPeople({ title: `New conversation · ${TABS.find(([k]) => k === C.tab)[1]}`, group: null });
      if (!pick) return;
      try {
        const r = await quad.chatStart({ audience: C.tab, memberIds: pick.ids, title: pick.title || undefined });
        await loadList(); openThread(r.id);
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

  function stop() { C.timers.forEach(clearInterval); C.timers = []; }
  C.timers.push(setInterval(() => { if (!box.isConnected) return stop(); pollThread(); }, THREAD_POLL_MS));
  C.timers.push(setInterval(async () => {
    if (!box.isConnected) return stop();
    if (document.visibilityState !== 'visible') return;
    await loadList();
    paintKeepingDraft();
  }, LIST_POLL_MS));

  box.innerHTML = '<p class="chat-empty">Loading conversations…</p>';
  loadList().then(paint);
  return { stop };
}
