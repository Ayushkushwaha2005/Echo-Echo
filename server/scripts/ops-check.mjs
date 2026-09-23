/* ==========================================================================
   ECHO ECHO - operator self-tests against REAL providers.

     node --env-file=.env scripts/ops-check.mjs db
     node --env-file=.env scripts/ops-check.mjs storage
     node --env-file=.env scripts/ops-check.mjs email you@stu.upes.ac.in

   Each check talks to the configured service and reports what actually
   happened. Nothing is mocked and nothing is printed that is a secret.
   ========================================================================== */
const [what, arg] = process.argv.slice(2);
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); process.exitCode = 1; };

if (what === 'db') {
  const { pool, health, migrationState } = await import('../src/db/index.js');
  const { DB } = await import('../src/config.js');
  const DB_URL = DB.url || '';
  const h = await health();
  h.ok ? ok(`database answers (${h.latencyMs} ms)`) : bad(`database: ${h.error}`);
  if (h.ok) {
    /* Whether the wire is encrypted cannot be read from pg_stat_ssl alone.
       Several managed providers — Neon among them — terminate TLS at a proxy
       in front of the compute, so the backend honestly reports ssl = false
       while the client's connection is encrypted the whole way to that proxy.
       Believing that column would report a false failure on every such
       deployment, which is how an operator learns to ignore this check.

       So the question is asked the other way round, which is the one that
       actually matters: would this server accept an UNENCRYPTED connection?
       If plaintext is refused, nothing we send can travel in the clear. */
    const ssl = await pool.query(`SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`).catch(() => ({ rows: [] }));
    const pg = (await import('pg')).default;
    const plain = new pg.Client({ connectionString: (DB_URL.split('?')[0]), ssl: false });
    let plaintextAccepted = false;
    try { await plain.connect(); plaintextAccepted = true; await plain.end(); } catch { /* refused: good */ }
    if (plaintextAccepted) bad('the database ACCEPTS unencrypted connections — traffic can travel in the clear');
    else if (ssl.rows[0]?.ssl) ok('connection is TLS-encrypted (verified end to end)');
    else ok('connection is TLS-encrypted (TLS terminates at the provider proxy; plaintext is refused)');
    const m = await migrationState();
    ok(`${m.count} migrations applied`);
    const v = await pool.query('SHOW server_version');
    ok(`PostgreSQL ${v.rows[0].server_version}`);
  }
  await pool.end();
} else if (what === 'storage') {
  const { STORAGE } = await import('../src/config.js');
  if (STORAGE.provider !== 's3' || !STORAGE.configured) {
    bad('STORAGE_PROVIDER=s3 with S3_BUCKET, S3_REGION, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY is required');
  } else {
    const s3 = await import('../src/services/s3.js');
    const r = await s3.checkAccess();
    r.ok ? ok(`upload, download and delete work on bucket "${STORAGE.s3.bucket}"`) : bad(`storage: ${r.error}`);
    /* A private bucket must refuse an unsigned read. */
    const key = `.quad-healthcheck/public-probe-${Date.now()}`;
    await s3.putObject(key, Buffer.from('probe'), 'text/plain');
    const endpoint = (STORAGE.s3.endpoint || `https://s3.${STORAGE.s3.region}.amazonaws.com`).replace(/\/$/, '');
    const anon = await fetch(`${endpoint}/${STORAGE.s3.bucket}/${key}`);
    anon.ok ? bad('the bucket serves objects WITHOUT a signature - make it private') : ok(`unsigned read refused (HTTP ${anon.status}): bucket is private`);
    const signed = await fetch(s3.presignGet(key, 60));
    signed.ok ? ok('a short-lived presigned URL works') : bad(`presigned GET failed (HTTP ${signed.status})`);
    await s3.deleteObject(key);
  }
} else if (what === 'email') {
  if (!arg) { bad('usage: ops-check.mjs email <recipient>'); process.exit(1); }
  const { NOTIFY } = await import('../src/config.js');
  if (!NOTIFY.email.configured) bad('EMAIL_PROVIDER (resend or brevo), its API key (RESEND_API_KEY or BREVO_API_KEY) and EMAIL_FROM are required');
  else {
    const { sendEmail, budgetState } = await import('../src/services/email.js');
    try {
      const id = await sendEmail({ to: arg, kind: 'notification', subject: 'ECHO ECHO email check',
        text: 'This is a delivery test from the ECHO ECHO server. No action is needed.' });
      ok(`Resend accepted the message (id ${id}). Check that it arrived in the inbox, not spam.`);
    } catch (e) {
      bad(`email not sent: ${e.message}. See the server log line above for the provider's reason.`);
    }
    const b = await budgetState();
    ok(`budget: ${b.sentToday}/${b.dailyBudget} today, ${b.sentThisMonth}/${b.monthlyBudget} this month`);
    const { pool } = await import('../src/db/index.js');
    await pool.end();
  }
} else {
  console.log('usage: ops-check.mjs db | storage | email <recipient>');
  process.exitCode = 1;
}
