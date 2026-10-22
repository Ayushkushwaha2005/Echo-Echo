/* ==========================================================================
   ECHO ECHO — refuse to deploy code whose migrations production lacks.

     node tools/migration-gate.mjs https://www.echoecho.tech/api

   Migrations are applied by hand, with the owner's approval, BEFORE the code
   that needs them (docs/RUNBOOK.md). Nothing enforced that order: on 15 Oct
   2026 code carrying 031_saved_places.sql was deployed, the migration was
   not applied, and /ready (with every keep-warm and deploy run) was red for
   six days. This runs before the Render deploy and stops it, naming the
   files, so the order is enforced rather than remembered.

   It reads the RUNNING service's /ready: `latest` (the newest applied
   migration) and `pending` (what the running code needs and lacks). Every
   migration file in this checkout that sorts after `latest` is new.
   ========================================================================== */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'src', 'db');

export const shippedMigrations = (dir = MIGRATIONS_DIR) =>
  readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort();

/* What production must have applied before this checkout may be deployed. */
export function unapplied(shipped, migrations) {
  if (!migrations || typeof migrations.applied !== 'number') return { known: false, files: [] };
  const missing = new Set(migrations.pending || []);
  if (migrations.latest) {
    for (const f of shipped) if (f > migrations.latest) missing.add(f);
  } else {
    /* A service from before `latest` was reported: numbered files apply in
       order, so the first `applied` of them are the applied ones. */
    for (const f of shipped.slice(migrations.applied)) missing.add(f);
  }
  return { known: true, files: [...missing].sort() };
}

async function main() {
  const base = (process.argv[2] || '').replace(/\/$/, '');
  if (!base) { console.error('usage: node tools/migration-gate.mjs <api base url>'); return 2; }
  let json = null;
  for (let i = 0; i < 4 && !json?.checks?.migrations; i++) {
    if (i) await new Promise((r) => setTimeout(r, 15000));
    const res = await fetch(`${base}/ready/`, { redirect: 'manual', signal: AbortSignal.timeout(60000) }).catch(() => null);
    json = res ? await res.json().catch(() => null) : null;
  }
  const verdict = unapplied(shippedMigrations(), json?.checks?.migrations);
  if (!verdict.known) {
    console.log(`::error title=Migration state unknown::${base}/ready/ did not report migrations (database unreachable?). Not deploying blind.`);
    return 1;
  }
  if (verdict.files.length) {
    console.log(`::error title=Migrations not applied::Production lacks ${verdict.files.join(', ')}. `
      + 'Apply them first (owner approval, snapshot, npm run migrate; docs/RUNBOOK.md), then re-run this workflow.');
    return 1;
  }
  console.log(`production has every migration this commit ships (${json.checks.migrations.applied} applied)`);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
