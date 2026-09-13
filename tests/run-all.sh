#!/usr/bin/env bash
# Full regression. Run from the repo root: bash tests/run-all.sh
set -e
cd "$(dirname "$0")/.."
echo "── rebuilding bundles ─────────────────────────────────"
node build.mjs
echo
echo "── locked app regression ──────────────────────────────"
find prototype -type f -not -path "*/dist/*" -exec md5sum {} \; | sort > /tmp/frisco_now.txt
if diff -q tests/prototype.md5 /tmp/frisco_now.txt >/dev/null; then
  echo "  PASS  prototype/ is byte-identical to the approved app"
else
  echo "  FAIL  prototype/ changed:"; diff tests/prototype.md5 /tmp/frisco_now.txt; exit 1
fi
echo
echo "── acceptance (campus, pricing, vendor CRUD) ──────────"
node tests/acceptance.mjs | tail -1
echo "── locations ──────────────────────────────────────────"
node tests/locations.mjs | tail -3
echo "── authorization (AUTH_ENABLED=false) ─────────────────"
node tests/authorization.mjs | tail -1
echo "── enforced auth (AUTH_ENABLED=true, isolated) ────────"
AUTH_ENABLED=true PRIMARY_ADMIN_EMAIL=owner@campus.edu.in node tests/auth-enforced.mjs | tail -1
echo "── bundle smoke (every built surface executes) ────────"
node tests/bundle-smoke.mjs | tail -1
echo
echo "── server (real PostgreSQL, real Fastify) ─────────────"
# The backend is the authority for everything, so a "full regression" that
# skips it is not one. Needs the test cluster: `cd server && npm run test:init`
# once, after which every run is self-contained.
( cd server && node runtests.mjs | tail -3 )
echo
echo "── shipped flag state ─────────────────────────────────"
node -e "import('./packages/data/config.js').then(({CONFIG_FLAGS})=>console.log('  AUTH_ENABLED =', CONFIG_FLAGS.AUTH_ENABLED))"
