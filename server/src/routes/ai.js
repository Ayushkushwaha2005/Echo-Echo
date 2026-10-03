/* ==========================================================================
   ECHO ECHO — ASK ECHO ECHO, THE ORDERING ASSISTANT

   Default provider: `local` — the assistant in services/agent/, running in
   this process. No model API is called, nothing leaves ECHO ECHO's server,
   and there is no per-message cost. It reads the live menu and the café
   status the rest of the product reads, prices a basket with the same
   quote() the checkout uses, and can only ever PROPOSE: the student
   confirms, the normal checkout builds the real draft from the database,
   and payment goes through the gateway as for any order.

   It answers signed-out visitors too, because everything it can say — the
   menu, prices, hours — is already public. Putting the order in the cart
   and paying still need a verified student account at checkout.

   `anthropic` remains available only if an operator explicitly sets
   AI_PROVIDER=anthropic with a key; the deployment does not use it.
   ========================================================================== */
import { AI, RATE_LIMITS } from '../config.js';
import { q } from '../db/index.js';
import { authorize, assertMayOrder, ProviderUnavailable, BadRequest } from '../auth/rbac.js';
import { TOOLS, TOOL_SPECS, SYSTEM_PROMPT } from '../services/ai-tools.js';
import { converse } from '../services/agent/engine.js';
import { statusOf } from '../services/hours.js';
import { livePolicy, quote } from '../services/pricing.js';
import { flag } from '../services/flags.js';
import { audit } from '../audit.js';

/* Everything the local assistant may know for one request, read now. */
export async function agentContext(actor, now = new Date()) {
  const campusId = actor?.campusId || null;
  const { rows: vendors } = await q(
    `SELECT v.id, v.slug, v.name, v.opens_at, v.closes_at, v.open_days, v.is_open, v.accepting,
            v.delivery_enabled, v.active, cs.service_status
       FROM vendor v LEFT JOIN campus_site cs ON cs.id = v.campus_site_id
      WHERE v.active AND ($1::uuid IS NULL OR v.campus_site_id = $1)
      ORDER BY v.name`, [campusId]);
  const ids = vendors.map((v) => v.id);
  const { rows: items } = await q(
    `SELECT i.id, i.vendor_id, i.name, i.aliases, i.price_paise, i.veg, i.available, c.name AS category
       FROM menu_item i LEFT JOIN category c ON c.id = i.category_id
      WHERE i.active AND i.vendor_id = ANY($1::uuid[])
      ORDER BY c.sort NULLS LAST, i.price_paise, i.name`, [ids]);
  const policies = new Map();
  for (const v of vendors) policies.set(v.id, await livePolicy({ query: q }, v.id));
  /* A signed-in account that may not order (a counter, an unverified or
     suspended student) can ask about the menu, but is never handed an order
     to check out. The checkout route enforces the same rule again. */
  let orderBlock = null;
  if (actor) {
    try {
      authorize(actor, 'order.create');
      assertMayOrder(actor);
    } catch (e) {
      orderBlock = [e.message, e.detail].filter(Boolean).join('. ');
    }
  }
  return {
    orderBlock,
    vendors: vendors.map((v) => {
      const status = statusOf(v, now);
      /* A campus that is not in service takes no orders, whatever the hour. */
      return v.service_status && v.service_status !== 'active'
        ? { ...v, status: { open: false, state: 'closed', line: 'Not taking orders on this campus yet' } }
        : { ...v, status };
    }),
    items,
    quote: (vendorId, subtotalPaise, fulfilment) => quote(policies.get(vendorId), { subtotalPaise, fulfilment }),
    signedIn: !!actor,
  };
}

async function callModel(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': AI.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: AI.model,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      tools: TOOL_SPECS,
      messages,
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    const e = new Error(`anthropic ${res.status}: ${body}`);
    e.status = res.status === 429 ? 429 : 502;
    throw e;
  }
  return res.json();
}

export default async function aiRoutes(app) {
  app.get('/ai/status', async () => {
    const available = AI.configured && await flag('ai_ordering');
    return {
      available,
      provider: AI.configured ? AI.provider : null,
      message: available ? null
        : !AI.configured ? 'Ordering assistant is temporarily unavailable. You can still browse and order normally.'
          : 'The ordering assistant is switched off right now. You can still browse and order normally.',
    };
  });

  app.post('/ai/chat', {
    config: { rateLimit: { max: RATE_LIMITS.ai, timeWindow: RATE_LIMITS.windowMinutes * 60_000 } },
  }, async (req) => {
    if (!AI.configured) {
      throw ProviderUnavailable('Ordering assistant is temporarily unavailable',
        'You can still browse and order normally.');
    }
    if (!(await flag('ai_ordering'))) {
      throw ProviderUnavailable('The ordering assistant is switched off',
        'An administrator has disabled it. Browse and order normally.');
    }
    const history = Array.isArray(req.body?.messages) ? req.body.messages.slice(-80) : [];

    if (AI.provider === 'local') {
      /* Only the student's own words are read. Whatever the browser claims
         the assistant said is ignored: the conversation is replayed from
         the user turns, against data read now. */
      const userTexts = history
        .filter((m) => m?.role === 'user' && typeof m.content === 'string' && m.content.trim())
        .map((m) => m.content.slice(0, 500))
        .slice(-40);
      if (!userTexts.length) throw BadRequest('Say something to the assistant');
      const out = converse(userTexts, await agentContext(req.actor));
      if (req.actor) {
        await audit(req, { action: 'ai.chat', outcome: 'ok',
                           detail: { provider: 'local', proposal: !!out.proposal, action: out.action?.type || null } });
      }
      return out;
    }

    /* ---- anthropic (only if explicitly configured) ---------------------- */
    authorize(req.actor, 'order.create');
    assertMayOrder(req.actor, { liveLocationRequired: await flag('live_location') });
    /* Tool results are only ever appended here, from a real TOOLS call, so a
       crafted "tool_result" claiming a ₹1 price cannot come from the browser. */
    const messages = history
      .filter((m) => ['user', 'assistant'].includes(m.role))
      .map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content
               : Array.isArray(m.content) ? m.content.filter((b) => b.type === 'text') : '',
      }))
      .filter((m) => m.content && m.content.length);
    if (!messages.length) throw BadRequest('Say something to the assistant');

    const trace = [];
    for (let turn = 0; turn < AI.maxTurns; turn++) {
      const reply = await callModel(messages);
      messages.push({ role: 'assistant', content: reply.content });

      if (reply.stop_reason !== 'tool_use') {
        const text = reply.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        await audit(req, { action: 'ai.chat', outcome: 'ok',
                           detail: { turns: turn + 1, tools: trace.map((t) => t.tool) } });
        return { reply: text, toolsUsed: trace, messages };
      }

      const results = [];
      for (const block of reply.content.filter((b) => b.type === 'tool_use')) {
        const fn = TOOLS[block.name];
        let out;
        if (!fn) {
          out = { error: `unknown tool ${block.name}` };
        } else {
          try {
            /* The real session actor — the model cannot elevate itself. */
            out = await fn(req.actor, block.input || {});
          } catch (e) {
            out = { error: e.message, detail: e.detail || null };
          }
        }
        trace.push({ tool: block.name, input: block.input, ok: !out.error });
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
      }
      messages.push({ role: 'user', content: results });
    }

    await audit(req, { action: 'ai.chat', outcome: 'error', detail: { reason: 'max_turns' } });
    return { reply: 'I could not finish that. Try ordering from the menu directly.',
             toolsUsed: trace, messages };
  });
}
