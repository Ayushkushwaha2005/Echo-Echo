#!/usr/bin/env bash
# ===========================================================================
# ECHO ECHO — one-time VM preparation (Ubuntu 24.04 LTS)
#
#   curl -fsSL https://raw.githubusercontent.com/Ayushkushwaha2005/Echo-Echo/main/deploy/bootstrap-vm.sh | bash
#   # or, having cloned:  bash deploy/bootstrap-vm.sh
#
# Installs Docker, hardens SSH, and closes everything except 22/80/443.
# It does NOT deploy the application and it does NOT touch any secret — see
# deploy/AZURE.md for what comes after.
#
# Safe to re-run: every step checks its own state first.
# ===========================================================================
set -euo pipefail

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()  { printf '   ✓ %s\n' "$*"; }

if [[ $EUID -eq 0 ]]; then
  echo "Run this as the ordinary admin user (echoadmin), not root." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
say "System packages"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq
sudo apt-get install -y -qq ca-certificates curl git ufw fail2ban unattended-upgrades
ok "base packages installed"

# ---------------------------------------------------------------------------
say "Unattended security updates"
# A VM that is never patched is the likeliest way this box is lost. Security
# updates only, applied automatically.
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
ok "security updates will apply automatically"

# ---------------------------------------------------------------------------
say "Docker"
if ! command -v docker >/dev/null 2>&1; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
                             docker-buildx-plugin docker-compose-plugin
  ok "docker installed"
else
  ok "docker already present"
fi

# Docker must come back after a reboot, because the sweeper and the settlement
# scheduler are in-process timers: a container that stays down means abandoned
# orders are never released and settlement batches are never built.
sudo systemctl enable --now docker
ok "docker enabled at boot"

if ! groups "$USER" | grep -qw docker; then
  sudo usermod -aG docker "$USER"
  ok "added $USER to the docker group — log out and back in for it to apply"
fi

# ---------------------------------------------------------------------------
say "SSH hardening"
# Azure already provisioned the key. This removes every other way in, so a
# guessed or leaked password is not a route onto the box.
SSHD=/etc/ssh/sshd_config.d/99-echo-echo.conf
sudo tee "$SSHD" > /dev/null <<'EOF'
# ECHO ECHO — SSH policy. Keys only.
PasswordAuthentication no
PermitRootLogin no
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
# A session that is gone should not stay open.
ClientAliveInterval 300
ClientAliveCountMax 2
MaxAuthTries 3
# The API is reached over https, never over an SSH tunnel.
AllowTcpForwarding no
X11Forwarding no
EOF

# Validate BEFORE restarting: a bad config plus a restart is how a cloud VM
# becomes unreachable with no console.
if sudo sshd -t; then
  sudo systemctl restart ssh
  ok "password login disabled, root login disabled"
else
  echo "   ✗ sshd config invalid — NOT restarting ssh. Fix $SSHD first." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
say "Firewall"
# Azure's Network Security Group is the outer gate; this is the inner one.
# PostgreSQL is NOT opened: the database is a managed Azure service reached
# outbound, never something the internet connects to here.
sudo ufw --force reset > /dev/null
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp   comment 'SSH'
sudo ufw allow 80/tcp   comment 'HTTP - ACME challenge and redirect'
sudo ufw allow 443/tcp  comment 'HTTPS - the API'
sudo ufw --force enable
ok "only 22, 80 and 443 accept inbound"

# ---------------------------------------------------------------------------
say "fail2ban"
sudo systemctl enable --now fail2ban
ok "repeated SSH failures are banned"

# ---------------------------------------------------------------------------
say "Swap"
# B1s has 1 GB of RAM. A small swap file stops a transient spike from having
# the kernel kill the API container outright.
if ! sudo swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile > /dev/null
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null
  sudo sysctl -q vm.swappiness=10
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf > /dev/null
  ok "2 GB swap active"
else
  ok "swap already configured"
fi

# ---------------------------------------------------------------------------
printf '\n\033[1mVM ready.\033[0m\n'
echo "  docker:   $(docker --version 2>/dev/null || echo 'log out and back in first')"
echo "  firewall: $(sudo ufw status | head -1)"
echo
echo "Next: clone the repository and follow deploy/AZURE.md section 2."
echo "Nothing here created or touched a secret."
