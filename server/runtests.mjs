/* ==========================================================================
   Runs the whole suite against ONE shared PostgreSQL cluster.

   The parent starts the cluster and passes its port down, so the child test
   processes only ever attach. That removes the start race entirely: before,
   every file tried to start its own cluster and a leftover socket from a
   killed run could take the whole suite down.

     node test/helpers/db.mjs init    # once
     node runtests.mjs                # everything
     node runtests.mjs api            # one group
   ========================================================================== */
import { spawnSync } from 'node:child_process';
import { startDb, shutdownCluster } from './test/helpers/db.mjs';

const FILES = [
  ['unit', 'test/rbac.test.mjs'],
  ['unit', 'test/money-and-config.test.mjs'],
  ['unit', 'test/pipeline.test.mjs'],
  ['unit', 'test/ai-contract.test.mjs'],
  ['integration', 'test/integration.test.mjs'],
  ['api', 'test/api.test.mjs'],
  ['e2e', 'test/e2e.test.mjs'],
  ['e2e', 'test/ordering-rules.test.mjs'],
  ['security', 'test/security.test.mjs'],
  ['enrolment', 'test/enrolment.test.mjs'],
  ['auth', 'test/admin-login.test.mjs'],
  ['auth', 'test/student-email.test.mjs'],
  ['payments', 'test/payments.test.mjs'],
  ['payments', 'test/payments-cashfree.test.mjs'],
  ['handover', 'test/handover.test.mjs'],
  ['trust', 'test/trust.test.mjs'],
  ['auth', 'test/passkeys.test.mjs'],
  ['auth', 'test/admin-access.test.mjs'],
  ['finance', 'test/finance.test.mjs'],
  ['settlement', 'test/settlement.test.mjs'],
  ['settlement', 'test/reconciliation.test.mjs'],
  ['storage', 'test/storage.test.mjs'],
  ['campus', 'test/campus-config.test.mjs'],
  ['campus', 'test/campus-option.test.mjs'],
  ['campus', 'test/geodata.test.mjs'],
  ['config', 'test/config-safety.test.mjs'],
  ['schema', 'test/schema-contract.test.mjs'],
  ['persistence', 'test/persistence.test.mjs'],
];

const only = process.argv[2];
const selected = FILES.filter(([kind, f]) => !only || f.includes(only) || kind === only);
if (!selected.length) {
  console.error(`No test files match "${only}".`);
  process.exit(1);
}

/* Only bring the database up when something actually needs it. */
const needsDb = selected.some(([kind]) => kind !== 'unit');
if (needsDb) {
  try {
    await startDb();
    console.log(`postgres ready on port ${process.env.QUAD_TEST_PG_PORT}\n`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

const totals = {};
let failed = 0;

for (const [kind, file] of selected) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file],
                      { encoding: 'utf8', env: process.env });
  const out = (r.stdout || '') + (r.stderr || '');
  const num = (k) => {
    const m = out.match(new RegExp('^# ' + k + ' (\\d+)', 'm'));
    return m ? Number(m[1]) : 0;
  };
  const pass = num('pass'), fail = num('fail'), skipped = num('skipped'), todo = num('todo');
  totals[kind] = totals[kind] || { pass: 0, fail: 0, skipped: 0, todo: 0 };
  totals[kind].pass += pass;
  totals[kind].fail += fail;
  totals[kind].skipped += skipped;
  totals[kind].todo += todo;
  failed += fail;

  const flag = fail ? 'FAIL' : (pass ? ' ok ' : 'WARN');
  console.log(`${flag}  ${file.padEnd(34)} pass=${pass} fail=${fail}` +
              (skipped ? ` skipped=${skipped}` : '') + (todo ? ` todo=${todo}` : ''));

  if (fail || (!pass && r.status !== 0)) {
    console.log(out.split('\n')
      .filter((l) => /^not ok |^\s+(error|expected|actual|code|operator):/.test(l))
      .slice(0, 40).map((l) => '        ' + l.trim()).join('\n'));
  }
}

if (needsDb) await shutdownCluster();

console.log('\n─────────────────────────────');
let p = 0, s = 0, t = 0;
for (const [k, v] of Object.entries(totals)) {
  p += v.pass; s += v.skipped; t += v.todo;
  console.log(`${k.padEnd(12)} pass=${v.pass}  fail=${v.fail}` +
              (v.skipped ? `  skipped=${v.skipped}` : '') + (v.todo ? `  todo=${v.todo}` : ''));
}
console.log(`${'TOTAL'.padEnd(12)} pass=${p}  fail=${failed}` +
            (s ? `  skipped=${s}` : '') + (t ? `  todo=${t}` : ''));
process.exit(failed ? 1 : 0);
