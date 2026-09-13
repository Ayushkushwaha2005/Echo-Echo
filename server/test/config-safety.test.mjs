/* ==========================================================================
   CONFIGURATION AND SECRET SAFETY

   Two questions, both answerable from the repository:
     1. Does .env.example document every variable the code actually reads,
        with no value that looks like a real credential?
     2. Can a secret escape — through a log, an API response, or a bundle?
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* fileURLToPath, not URL.pathname — the latter leaves %20 in a path that
   has a space in it, which every directory here does. */
const serverRoot = dirname(fileURLToPath(new URL('.', import.meta.url)));
const repoRoot = join(serverRoot, '..');

const walk = (dir, out = []) => {
  for (const f of readdirSync(dir)) {
    if (['node_modules', 'var', 'dist', '.git', 'prototype'].includes(f)) continue;
    const p = join(dir, f);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};

const serverSources = walk(join(serverRoot, 'src')).filter((f) => f.endsWith('.js'));
const envExample = readFileSync(join(serverRoot, '.env.example'), 'utf8');

/* Every env var the server actually reads. */
function readVars() {
  const names = new Set();
  for (const f of serverSources) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\benv\(\s*'([A-Z0-9_]+)'/g)) names.add(m[1]);
    for (const m of src.matchAll(/\bbool\(\s*'([A-Z0-9_]+)'/g)) names.add(m[1]);
    for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1]);
    for (const m of src.matchAll(/process\.env\[\s*'([A-Z0-9_]+)'/g)) names.add(m[1]);
  }
  /* Set by Node or the platform, not ours to document. */
  for (const n of ['NODE_ENV', 'LOG_LEVEL']) names.delete(n);
  return [...names].sort();
}

test('.env.example documents every variable the server reads', () => {
  const missing = readVars().filter((v) => !new RegExp(`^\\s*#?\\s*${v}=`, 'm').test(envExample));
  assert.deepEqual(missing, [], `undocumented in .env.example: ${missing.join(', ')}`);
});

test('.env.example contains names only — no value that could be a real credential', () => {
  const suspicious = [];
  for (const line of envExample.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const [, name, raw] = m;
    const value = raw.split('#')[0].trim();
    if (!value) continue;
    /* Numeric tuning and enum-ish defaults are fine to ship. */
    if (/^[0-9]+$/.test(value)) continue;
    if (/^(true|false|local|s3|twilio|msg91|razorpay|razorpayx|anthropic|gcv|resend|csv|api|require|no-verify|disable|imps|neft|rtgs|upi)$/i.test(value)) continue;
    if (/^https?:\/\//.test(value)) continue;
    if (/^\+91X+$/i.test(value) || /^Your Name$/i.test(value)) continue;
    if (/^claude-[a-z0-9-]+$/.test(value)) continue;
    if (/^\.\//.test(value)) continue;
    if (/^postgres:\/\//.test(value)) continue;
    if (/^[0-9.]+$/.test(value)) continue;               // bind addresses, e.g. 0.0.0.0
    /* Dated API-version pins, e.g. Cashfree's x-api-version: 2024-01-01. */
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
    suspicious.push(`${name}=${value}`);
  }
  assert.deepEqual(suspicious, [],
    `these look like real values rather than placeholders: ${suspicious.join(', ')}`);
});

test('no secret-shaped literal is committed anywhere in the server source', () => {
  const patterns = [
    [/\bsk_live_[A-Za-z0-9]{8,}/, 'live secret key'],
    [/\brzp_live_[A-Za-z0-9]{8,}/, 'live Razorpay key'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
    [/\bAC[0-9a-f]{32}\b/, 'Twilio account SID'],
    [/\bsk-ant-[A-Za-z0-9_-]{12,}/, 'Anthropic API key'],
    [/-----BEGIN (RSA )?PRIVATE KEY-----/, 'private key'],
  ];
  const findings = [];
  for (const f of [...serverSources, join(serverRoot, '.env.example')]) {
    const src = readFileSync(f, 'utf8');
    for (const [re, what] of patterns) {
      if (re.test(src)) findings.push(`${f.replace(repoRoot, '')}: ${what}`);
    }
  }
  assert.deepEqual(findings, []);
});

test('a real .env is never committed', () => {
  /* It may exist locally; it must be ignored. */
  const gitignore = existsSync(join(serverRoot, '.gitignore'))
    ? readFileSync(join(serverRoot, '.gitignore'), 'utf8') : '';
  const rootIgnore = existsSync(join(repoRoot, '.gitignore'))
    ? readFileSync(join(repoRoot, '.gitignore'), 'utf8') : '';
  const ignored = /(^|\n)\s*\*?\.env\b/.test(gitignore + '\n' + rootIgnore) ||
                  /(^|\n)\s*\.env($|\n)/.test(gitignore + '\n' + rootIgnore);
  assert.ok(ignored, '.env must be gitignored');
});

/* ---------- logging ------------------------------------------------------ */
test('the logger redacts every credential-shaped field', () => {
  const index = readFileSync(join(serverRoot, 'src', 'index.js'), 'utf8');
  for (const path of ['req.headers.cookie', 'req.headers.authorization',
                      'x-razorpay-signature', 'res.headers["set-cookie"]',
                      'req.body.code', 'req.body.otp', 'req.body.password',
                      '*.code_hash', '*.token_hash', '*.apiKey', '*.secret']) {
    assert.ok(index.includes(path), `logger must redact ${path}`);
  }
});

test('no source line logs a secret directly', () => {
  const bad = [];
  for (const f of serverSources) {
    for (const [i, line] of readFileSync(f, 'utf8').split(/\r?\n/).entries()) {
      if (!/console\.(log|info|warn|error)|log\.(info|warn|error|debug)/.test(line)) continue;
      if (/apiKey|authToken|keySecret|webhookSecret|secretAccessKey|cookieSecret|code_hash|token_hash/.test(line)) {
        bad.push(`${f.replace(repoRoot, '')}:${i + 1}`);
      }
    }
  }
  assert.deepEqual(bad, [], `these log lines reference a secret: ${bad.join(', ')}`);
});

/* ---------- API surface -------------------------------------------------- */
test('no route returns a secret value; provider status is boolean only', async () => {
  process.env.DATABASE_URL ||= 'postgres://unused';
  const { providerStatus } = await import('../src/config.js');
  const dump = JSON.stringify(providerStatus());
  /* Only names and booleans — never a credential. */
  assert.ok(!/[A-Za-z0-9_-]{32,}/.test(dump), 'provider status must not embed a long secret');
  for (const k of ['apiKey', 'authToken', 'keySecret', 'secretAccessKey', 'webhookSecret']) {
    assert.ok(!dump.includes(k), `providerStatus must not expose ${k}`);
  }
});

/* ---------- production boot guards -------------------------------------- */
test('production refuses to start in an unsafe configuration', async () => {
  const original = { ...process.env };
  const attempt = async (env, expect) => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@db.example.com/quad?sslmode=require',
      PLATFORM_OWNER_PHONE: '+919876543210',
      COOKIE_SECRET: 'x'.repeat(48),
      SECURE_COOKIES: 'true',
      WEB_ORIGIN: 'https://quad.example',
      WEBAUTHN_RP_ID: 'quad.example', TRUST_PROXY: 'true',
      OTP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 'b', TWILIO_FROM: 'c',
      PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's',
      RAZORPAY_WEBHOOK_SECRET: 'w',
      STORAGE_PROVIDER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's',
      ...env,
    });
    const mod = await import(`../src/config.js?v=${Math.random()}`);
    const out = mod.assertBootable();
    if (expect === 'ok') {
      assert.equal(out.ok, true, `expected a bootable config, got: ${(out.fatal || []).join(' ')}`);
    } else {
      assert.equal(out.ok, false, `expected a refusal for: ${expect}`);
      assert.ok(out.fatal.some((f) => expect.test(f)),
        `expected a message matching ${expect}, got: ${out.fatal.join(' | ')}`);
    }
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, original);
  };

  await attempt({}, 'ok');
  await attempt({ DATABASE_URL: 'postgres://u:p@localhost/quad' }, /localhost/);
  await attempt({ COOKIE_SECRET: 'short' }, /COOKIE_SECRET/);
  await attempt({ SECURE_COOKIES: 'false' }, /SECURE_COOKIES/);
  await attempt({ WEB_ORIGIN: 'http://localhost:3000' }, /localhost/);
  await attempt({ OTP_PROVIDER: '' }, /student sign-in provider/);
  /* The zero-cost launch: no SMS at all, students verify by institutional email. */
  await attempt({ OTP_PROVIDER: '', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k',
                  EMAIL_FROM: 'ECHO ECHO <verify@echo.example>' }, 'ok');
  await attempt({ OTP_PROVIDER: '', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.c',
                  RESEND_BASE_URL: 'http://127.0.0.1:9999' }, /RESEND_BASE_URL/);
  await attempt({ PAYMENT_PROVIDER: '' }, /payment provider/);
  /* Deploying before payment KYC must be an explicit decision. */
  await attempt({ PAYMENT_PROVIDER: '', PAYMENTS_DEFERRED: 'true' }, 'ok');
  /* Passkeys cannot be switched off, and the RP ID must match the admin origin. */
  await attempt({ ADMIN_PASSKEY_REQUIRED: 'false' }, /ADMIN_PASSKEY_REQUIRED/);
  await attempt({ WEBAUTHN_RP_ID: '' }, /WEBAUTHN_RP_ID/);
  await attempt({ WEBAUTHN_RP_ID: 'other.example' }, /WEBAUTHN_ORIGINS/);
  await attempt({ WEB_ORIGIN: 'https://quad.example,http://quad.example' }, /https in production/);
  /* The owner can be an institutional email instead of a phone. */
  await attempt({ PLATFORM_OWNER_PHONE: '', PLATFORM_OWNER_EMAIL: 'ayush.17551@stu.upes.ac.in' }, 'ok');
  await attempt({ PLATFORM_OWNER_PHONE: '', PLATFORM_OWNER_EMAIL: 'not-an-email' }, /PLATFORM_OWNER_EMAIL/);
  await attempt({ STORAGE_PROVIDER: 's3', S3_ENDPOINT: 'http://127.0.0.1:9000' }, /S3_ENDPOINT/);
  await attempt({ STORAGE_PROVIDER: 'local' }, /storage/i);
  await attempt({ PLATFORM_OWNER_PHONE: '' }, /PLATFORM_OWNER_PHONE/);
  /* A base-URL override pointed at a local stub must never survive to prod. */
  await attempt({ RAZORPAY_BASE_URL: 'http://127.0.0.1:9999' }, /RAZORPAY_BASE_URL/);
  await attempt({ TWILIO_BASE_URL: 'http://127.0.0.1:9999' }, /TWILIO_BASE_URL/);
});
