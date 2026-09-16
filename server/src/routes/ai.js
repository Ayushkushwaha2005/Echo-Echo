/* ==========================================================================
   QUAD — AI ORDERING ASSISTANT

   A real tool-use loop against the Anthropic Messages API. There is no
   canned-response table and no keyword script: the model sees the student's
   words and the tool results, and every fact in its reply had to come back
   from a SQL query in ai-tools.js.

   With no API key configured the endpoint returns 503 and the surface shows
   "Ordering assistant is temporarily unavailable. You can still browse and
   order normally." — not a fake conversation.
   ========================================================================== */
import { AI, RATE_LIMITS } from '../config.js';
import { authorize, assertMayOrder, ProviderUnavailable, BadRequest } from '../auth/rbac.js';
import { TOOLS, TOOL_SPECS, SYSTEM_PROMPT } from '../services/ai-tools.js';
import { flag } from '../services/flags.js';
import { audit } from '../audit.js';

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
  app.get('/ai/status', async () => ({
    available: AI.configured && await flag('ai_ordering'),
    message: AI.configured ? null
      : 'Ordering assistant is temporarily unavailable. You can still browse and order normally.',
  }));

  app.post('/ai/chat', {
    config: { rateLimit: { max: RATE_LIMITS.ai, timeWindow: RATE_LIMITS.windowMinutes * 60_000 } },
  }, async (req) => {
    authorize(req.actor, 'order.create');       // students only
    /* The assistant is an ordering surface like any other, so it meets the
       same gate. An unverified student cannot get past the checkout route
       by asking the AI to place the order instead. */
    assertMayOrder(req.actor, { liveLocationRequired: await flag('live_location') });
    if (!AI.configured) {
      throw ProviderUnavailable(
        'Ordering assistant is temporarily unavailable',
        'Set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY on the server. ' +
        'You can still browse and order normally.');
    }
    if (!(await flag('ai_ordering'))) {
      throw ProviderUnavailable('The ordering assistant is switched off',
        'An administrator has disabled AI ordering. Browse and order normally.');
    }

    /* The client sends conversation history; we keep only the shapes the
       API accepts, so a crafted "tool_result" claiming a ₹1 price cannot be
       injected from the browser — tool results are only ever appended here,
       from a real TOOLS call, in this loop. */
    const history = Array.isArray(req.body?.messages) ? req.body.messages : [];
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
            /* Errors go back to the model as data so it can explain the
               refusal to the student, rather than crashing the turn. */
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
