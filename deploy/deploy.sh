#!/usr/bin/env bash
# ===========================================================================
# ECHO ECHO — deploy (and re-deploy) the API on the VM.
#
#   cd ~/echo-echo && bash deploy/deploy.sh
#
# Safe to re-run. It pulls, rebuilds, migrates and brings the stack up, then
# REFUSES TO REPORT SUCCESS until the API actually answers /ready. A deploy
# script that exits 0 because `docker compose up` returned is how a broken
# container sits there unnoticed.
#
# It touches no secret. server.env is read by Docker, never by this script,
# and nothing here prints an environment value.
# ===========================================================================
set -euo pipefail

cd "$(dirname "$0")"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m+\033[0m %s\n' "$*"; }
fail() { printf '\n   \033[31mx %s\033[0m\n\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
say "Preflight"

command -v docker >/dev/null 2>&1 || fail "docker is not installed. Run deploy/bootstrap-vm.sh first."
docker compose version >/dev/null 2>&1 || fail "the docker compose plugin is missing. Run deploy/bootstrap-vm.sh first."
docker info >/dev/null 2>&1 || fail "cannot talk to the Docker daemon. If you were just added to the docker group, log out and back in."
ok "docker is usable"

[ -f .env ] || fail "deploy/.env is missing. cp .env.example .env and set API_HOSTNAME and ACME_EMAIL."
# shellcheck disable=SC1091
set -a; . ./.env; set +a
[ -n "${API_HOSTNAME:-}" ] || fail "API_HOSTNAME is empty in deploy/.env. Caddy cannot request a certificate for a nameless site."
[ -n "${ACME_EMAIL:-}" ]   || fail "ACME_EMAIL is empty in deploy/.env. Let's Encrypt renewal notices would go nowhere."
ok "API_HOSTNAME=$API_HOSTNAME"

[ -f server.env ] || fail "deploy/server.env is missing. cp server.env.example server.env, then fill it in (chmod 600)."
perms=$(stat -c '%a' server.env)
[ "$perms" = "600" ] || fail "deploy/server.env is mode $perms. It holds DATABASE_URL, COOKIE_SECRET and the provider keys: chmod 600 server.env"
ok "server.env present and private"

# The name must already resolve here, or the ACME HTTP-01 challenge fails and
# Caddy backs off for hours. Checking it now costs a second and saves that.
if command -v getent >/dev/null 2>&1; then
  resolved=$(getent ahostsv4 "$API_HOSTNAME" 2>/dev/null | awk 'NR==1{print $1}' || true)
  [ -n "$resolved" ] || fail "$API_HOSTNAME does not resolve. Point it at this VM's static public IP before deploying."
  ok "$API_HOSTNAME resolves to $resolved"
fi

# Names only. A missing key must be obvious without printing any value.
missing=""
for key in DATABASE_URL COOKIE_SECRET WEB_ORIGIN NODE_ENV; do
  grep -qE "^${key}=.+" server.env || missing="$missing $key"
done
[ -z "$missing" ] || fail "server.env has no value for:$missing"
ok "required server.env keys are set"

# ---------------------------------------------------------------------------
say "Source"
if [ -d ../.git ]; then
  before=$(git -C .. rev-parse --short HEAD)
  git -C .. pull --ff-only
  after=$(git -C .. rev-parse --short HEAD)
  [ "$before" = "$after" ] && ok "already at $after" || ok "$before -> $after"
else
  ok "not a git checkout; deploying the tree as it is"
fi

# ---------------------------------------------------------------------------
say "Build and start"
docker compose up -d --build
ok "containers started"

# ---------------------------------------------------------------------------
say "Migrations"
# Idempotent. Run AFTER the container is up so it uses the same image, the
# same DATABASE_URL and the same TLS settings the API itself will use.
docker compose exec -T api node src/db/migrate.js
ok "schema is current"

# ---------------------------------------------------------------------------
say "Verify"
# Poll rather than sleep-and-hope. /ready checks PostgreSQL and the migration
# state, not merely that the process is alive.
deadline=$(( $(date +%s) + 120 ))
until docker compose exec -T api node -e "fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
  [ "$(date +%s)" -lt "$deadline" ] || {
    echo
    docker compose logs --tail=40 api >&2
    fail "the API did not become ready within 120s. The last 40 log lines are above."
  }
  printf '.'
  sleep 3
done
echo
ok "the API answers /ready"

# Through Caddy, over real TLS, exactly as a browser reaches it. A failure
# here after /ready passed is a certificate or DNS problem, not the app.
if curl -fsS --max-time 20 "https://$API_HOSTNAME/health" > /dev/null 2>&1; then
  ok "https://$API_HOSTNAME/health answers over TLS"
else
  printf '   \033[33m!\033[0m %s\n' "https://$API_HOSTNAME/health did not answer yet."
  printf '     The app is healthy, so this is TLS or DNS. Give Caddy a minute for the\n'
  printf '     first certificate, then:  docker compose logs --tail=40 caddy\n'
fi

# ---------------------------------------------------------------------------
say "State"
docker compose ps
printf '\n\033[1mDeployed.\033[0m  Readiness detail:  curl -s https://%s/ready\n\n' "$API_HOSTNAME"
