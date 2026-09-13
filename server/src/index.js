import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';

import { HTTP, SESSION, STORAGE, assertBootable, providerStatus, PLATFORM } from './config.js';
import { actorFromToken } from './auth/session.js';
import { HttpError, Forbidden, Unauthenticated } from './auth/rbac.js';
import { pool } from './db/index.js';
import { startSweeper } from './services/sweeper.js';
import { startSettlementScheduler } from './services/settlement.js';
import { channelStatus } from './services/notify.js';
import { audit } from './audit.js';

import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import campusRoutes from './routes/campus.js';
import orderRoutes from './routes/orders.js';
import paymentRoutes from './routes/payments.js';
import partnerRoutes from './routes/partner.js';
import verificationRoutes from './routes/verification.js';
import adminRoutes from './routes/admin.js';
import aiRoutes from './routes/ai.js';
import supportRoutes from './routes/support.js';
import assetRoutes from './routes/assets.js';
import enrolmentRoutes from './routes/enrolment.js';
import financeRoutes from './routes/finance.js';
import profileRoutes from './routes/profile.js';
import trustRoutes from './routes/trust.js';
import passkeyRoutes from './routes/passkeys.js';
import adminAccessRoutes from './routes/admin-access.js';
import geodataRoutes from './routes/geodata.js';

const boot = assertBootable();
if (!boot.ok) {
  console.error(`\n${PLATFORM.name} refused to start:\n`);
  boot.fatal.forEach((f) => console.error('  ✗ ' + f));
  console.error('\nSee server/.env.example.\n');
  process.exit(1);
}
boot.warn.forEach((w) => console.warn('  ! ' + w));

export function build() {
  const app = Fastify({
    /* Structured logs with a request id on every line. The redact list is
       the security control: an OTP code, a cookie or an API key must never
       reach a log aggregator, so they are stripped at the logger. */
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      redact: {
        paths: [
          'req.headers.cookie', 'req.headers.authorization',
          'req.headers["x-razorpay-signature"]', 'res.headers["set-cookie"]',
          'req.body.code', 'req.body.otp', 'req.body.password',
          'req.body.inviteCode', 'req.body.credential', '*.public_key_jwk',
          '*.code_hash', '*.token_hash', '*.apiKey', '*.secret',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req: (r) => ({ method: r.method, url: r.url, id: r.id, ip: r.ip }),
      },
    },
    genReqId: (req) => req.headers['x-request-id'] || randomUUID(),
    trustProxy: process.env.TRUST_PROXY === 'true',
    bodyLimit: 1_048_576,
  });

  return (async () => {
    /* A POST with `Content-Type: application/json` and no body is normal
       (logout, toggles). Fastify rejects that by default; we accept it as {}.
       payments.js overrides this for the webhook, where the raw bytes are
       needed for the HMAC check. */
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      /* Kept verbatim so /payments/webhook can verify the gateway's HMAC
         over exactly the bytes that were signed. */
      req.rawBody = body;
      if (!body || !body.length) return done(null, {});
      try { done(null, JSON.parse(body.toString('utf8'))); }
      catch { done(Object.assign(new Error('Malformed JSON'), { statusCode: 400 })); }
    });

    await app.register(cookie, { secret: HTTP.cookieSecret || undefined });
    await app.register(rateLimit, { global: false });
    await app.register(multipart, { limits: { fileSize: STORAGE.maxBytes, files: 2 } });

    const allowedOrigins = HTTP.origin.split(',').map((s) => s.trim()).filter(Boolean);

    app.addHook('onRequest', async (req, reply) => {
      reply.header('x-request-id', req.id);
      /* Security headers. The API serves JSON only, so the CSP can be
         maximally restrictive — nothing it returns is ever rendered. */
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      if (HTTP.secureCookies) {
        reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }

      const origin = req.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Access-Control-Allow-Credentials', 'true');
        reply.header('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE');
        reply.header('Access-Control-Allow-Headers', 'content-type,x-request-id');
        reply.header('Access-Control-Max-Age', '600');
        return reply.code(204).send();
      }

      /* CSRF. The session cookie is SameSite=Lax, which already blocks
         cross-site POSTs from a form. This is the second layer: a
         state-changing request carrying a cookie must come from an origin
         we recognise. The gateway webhook is exempt — it is authenticated
         by an HMAC signature instead, and has no cookie to abuse. */
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      const isWebhook = req.url.startsWith('/payments/webhook');
      if (mutating && !isWebhook && req.headers.cookie?.includes(SESSION.cookieName)) {
        let source = origin;
        if (!source && req.headers.referer) {
          try { source = new URL(req.headers.referer).origin; } catch { source = 'invalid'; }
        }
        if (source && !allowedOrigins.includes(source)) {
          throw Forbidden('Cross-origin request rejected',
            `Origin ${source} is not an allowed origin for this deployment.`);
        }
        /* Browsers always send Origin on a cross-site or credentialed fetch.
           In production a cookie-bearing write with neither header is not
           something the ECHO ECHO surfaces ever produce, so it is refused. */
        if (!source && process.env.NODE_ENV === 'production') {
          throw Forbidden('Request origin missing', 'State-changing requests must come from the ECHO ECHO site.');
        }
      }
    });

    /* ---------- default-deny -----------------------------------------------
       Anything not on this list requires a session. A route that forgets its
       own authorize() call therefore fails closed with 401 rather than
       reaching a handler that dereferences a null actor and returns 500.
       Public reads are deliberate and enumerated. */
    const PUBLIC = [
      /^\/health$/, /^\/ready$/,
      /^\/auth\/(status|otp\/send|otp\/verify|email\/send|email\/verify|logout|me)$/,
      /* Redeeming an enrolment code is public in exactly the sense that
         verifying an OTP is: it proves possession of a secret, and only
         then does a session exist. */
      /^\/auth\/enrol$/, /^\/auth\/enrol\/available$/,
      /* Passkey sign-in proves possession of a registered private key. */
      /^\/auth\/passkey\/login\/(options|verify)$/,
      /^\/payments\/webhook$/,
      /^\/vendors(\/[^/]+\/(menu|contact))?$/,      // browsing before sign-in
      /^\/menu\/search/, /^\/reviews/,
      /^\/campus\/(tree|destinations|search|resolve|boundary)/,
      /^\/ai\/status$/, /^\/campuses$/, /^\/partner\/policy$/,
      /^\/assets\/[0-9a-f-]{36}$/, /^\/assets\/limits$/,
    ];

    app.addHook('preHandler', async (req) => {
      req.actor = await actorFromToken(req.cookies?.[SESSION.cookieName]);
      const path = req.url.split('?')[0];
      if (!req.actor && !PUBLIC.some((re) => re.test(path))) {
        throw Unauthenticated('Sign in required', `${path} requires an account.`);
      }
    });

    app.setErrorHandler((err, req, reply) => {
      /* Central denial auditing. authorize() throws before a route reaches
         its own audit() call, so without this every refusal would be
         invisible — and an audit log that records only successes tells you
         nothing about who has been probing. */
      if (err instanceof HttpError && [401, 403].includes(err.status)) {
        audit(req, {
          action: 'access.denied',
          resource: req.routeOptions?.url || req.url.split('?')[0],
          outcome: 'denied',
          detail: { method: req.method, path: req.url.split('?')[0],
                    reason: err.message, code: err.code },
        }).catch(() => {});
      }
      if (err instanceof HttpError) {
        return reply.code(err.status).send({ error: err.message, code: err.code, detail: err.detail });
      }
      if (err.validation || err.statusCode === 400) {
        return reply.code(400).send({ error: err.message, code: 'bad_request' });
      }
      if (err.statusCode === 429) {
        return reply.code(429).send({ error: 'Too many requests', code: 'rate_limited' });
      }
      if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err.statusCode === 413) {
        return reply.code(413).send({ error: 'That request is too large', code: 'payload_too_large' });
      }
      if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ error: 'That file is too large', code: 'bad_request' });
      }
      if (err.code === '22P02') {
        return reply.code(400).send({ error: 'Malformed identifier', code: 'bad_request' });
      }
      if (err.code === '23505') return reply.code(409).send({ error: 'Already exists', code: 'conflict' });
      if (err.code === '23503') {
        return reply.code(400).send({ error: 'That reference does not exist', code: 'bad_request' });
      }
      if (err.code === '23514') {
        return reply.code(400).send({ error: 'That value is not allowed', code: 'bad_request' });
      }
      /* Any other client error raised by the framework itself (unsupported
         media type, malformed headers...) is the client's, not a 500. */
      if (Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 500) {
        return reply.code(err.statusCode).send({ error: 'The request could not be processed', code: 'bad_request' });
      }
      /* Never leak an internal message or stack to a client. */
      req.log.error({ err, reqId: req.id }, 'unhandled');
      return reply.code(500).send({ error: 'Something went wrong', code: 'internal', requestId: req.id });
    });

    /* ---------- probes ---------------------------------------------------
       health  = the process is up.
       ready   = it can actually serve: the database answers.              */
    app.get('/health', async () => ({ ok: true, platform: PLATFORM.name }));

    /* ready = the database answers AND every migration shipped with this
       build has been applied. A half-migrated instance is kept out of the
       load balancer instead of serving queries against a missing column. */
    app.get('/ready', async (req, reply) => {
      const checks = {};
      const { health, migrationState } = await import('./db/index.js');
      const db = await health();
      checks.database = { ok: db.ok, latencyMs: db.latencyMs, pool: db.pool, ...(db.ok ? {} : { error: db.error }) };
      if (db.ok) {
        const { readdir } = await import('node:fs/promises');
        const shipped = (await readdir(new URL('./db/', import.meta.url))).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
        const state = await migrationState();
        const pending = shipped.filter((f) => !(state.applied || []).includes(f));
        checks.migrations = { ok: pending.length === 0, applied: state.count || 0, pending };
        /* Development seed rows must never be in production. */
        const seeded = await pool.query(`SELECT count(*)::int AS n FROM campus_node WHERE source = 'unverified_seed'`)
          .then((r) => r.rows[0].n).catch(() => 0);
        checks.data = { developmentSeedRows: seeded,
                        ok: !(process.env.NODE_ENV === 'production' && seeded > 0) };
      }
      checks.providers = providerStatus();
      checks.notifications = channelStatus();
      const ready = db.ok && checks.migrations?.ok !== false && checks.data?.ok !== false;
      return reply.code(ready ? 200 : 503).send({ ready, checks });
    });

    await app.register(authRoutes);
    await app.register(catalogRoutes);
    await app.register(campusRoutes);
    await app.register(orderRoutes);
    await app.register(paymentRoutes);
    await app.register(partnerRoutes);
    await app.register(verificationRoutes);
    await app.register(adminRoutes);
    await app.register(aiRoutes);
    await app.register(supportRoutes);
    await app.register(assetRoutes);
    await app.register(enrolmentRoutes);
    await app.register(financeRoutes);
    await app.register(profileRoutes);
    await app.register(trustRoutes);
    await app.register(passkeyRoutes);
    await app.register(adminAccessRoutes);
    await app.register(geodataRoutes);

    return app;
  })();
}

/* Only listen when run directly — tests import build(). */
const isMain = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isMain) {
  const app = await build();
  if (process.env.SWEEPER !== 'off') {
    /* Intervals are configurable because every tick queries the database: on
       a scale-to-zero free database (Neon Free suspends after 5 idle minutes,
       100 CU-hours/month) a 30-second tick keeps compute awake around the
       clock. See docs/DEPLOY.md, "Free-tier database". */
    startSweeper(app, Number(process.env.SWEEPER_INTERVAL_SECONDS || 30) * 1000);
    /* Builds the evening cafeteria batch and the weekly partner batch. It
       only ever CALCULATES: releasing money stays an admin action. */
    startSettlementScheduler(app, Number(process.env.SETTLEMENT_INTERVAL_SECONDS || 60) * 1000);
  }
  await app.listen({ port: HTTP.port, host: HTTP.host });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      app.log.info('shutting down');
      await app.close();
      await pool.end();
      process.exit(0);
    });
  }
}
