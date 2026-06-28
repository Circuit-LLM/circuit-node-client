#!/usr/bin/env bash
# Circuit GPU node — one-line installer.
#
#   curl -fsSL https://circuitllm.xyz/join | bash
#
# Turns any Linux box (or Windows via WSL2) with an NVIDIA GPU into a Circuit mesh node.
# It installs Docker + the NVIDIA Container Toolkit if they're missing, pulls the GPU image,
# and runs it as an auto-restarting service. The operator never touches a docker command.
#
# Non-interactive / scripted use (skip prompts):
#   CIRCUIT_PAYOUT_WALLET=<sol-wallet> CIRCUIT_CONTROL_URL=<url> bash join.sh
set -euo pipefail

IMAGE="${CIRCUIT_IMAGE:-ghcr.io/circuit-llm/gpu-node:latest}"
CONTAINER="${CIRCUIT_CONTAINER:-circuit-gpu-node}"
VOLUME="${CIRCUIT_VOLUME:-circuit-gpu}"
CONTROL_URL_DEFAULT="https://node.circuitllm.xyz"

c()   { printf '\033[%sm%s\033[0m' "$1" "$2"; }
say()  { echo "$(c '1;36' '▸') $*"; }
ok()   { echo "$(c '1;32' '✓') $*"; }
warn() { echo "$(c '1;33' '!') $*"; }
die()  { echo "$(c '1;31' '✗') $*" >&2; exit 1; }

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
run() { $SUDO "$@"; }

echo
echo "$(c '1;35' '  ⚡ Circuit GPU node installer')"
echo "  Run a shard of the decentralized 72B, power the mesh, earn CIRC."
echo

# ── 1. platform + GPU ─────────────────────────────────────────────────────────────────────
[ "$(uname -s)" = "Linux" ] || die "this installer targets Linux (incl. Windows WSL2). macOS has no CUDA — it can't run a GPU node."
grep -qiE "microsoft|wsl" /proc/version 2>/dev/null && say "detected Windows WSL2"

if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi -L >/dev/null 2>&1; then
  die "no working NVIDIA driver found (nvidia-smi failed).
     Install your GPU driver first:
       • Ubuntu/Debian:  sudo ubuntu-drivers autoinstall   (then reboot)
       • Windows (WSL2): install the NVIDIA Windows driver with WSL support — the driver lives on the Windows side
     Then re-run this installer."
fi
ok "GPU: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)"

# ── 2. Docker ─────────────────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  say "installing Docker (get.docker.com)…"
  curl -fsSL https://get.docker.com | run sh >/dev/null
  ok "Docker installed"
else
  ok "Docker present"
fi
run docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start it: sudo systemctl start docker"

# ── 3. NVIDIA Container Toolkit (lets Docker see the GPU) ──────────────────────────────────
# Probe with a tiny CUDA base image, not the multi-GB engine image. If `--gpus all` can't
# select a device driver, the toolkit is missing.
if ! run docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi -L >/dev/null 2>&1; then
  say "installing NVIDIA Container Toolkit (so Docker can use the GPU)…"
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | run gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL "https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list" \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    | run tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
  run apt-get update -qq && run apt-get install -y -qq nvidia-container-toolkit
  run nvidia-ctk runtime configure --runtime=docker
  run systemctl restart docker 2>/dev/null || true
  ok "NVIDIA Container Toolkit installed"
else
  ok "Docker can already see the GPU"
fi

# WSL2's virtual NIC mis-sizes packets, corrupting large TLS responses from registries — the classic
# "tls: error decoding message" on `docker pull`. Cap the docker MTU so pulls succeed. Merge (don't
# clobber) so the NVIDIA runtime config above survives. Harmless on a normal NIC.
if grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; then
  say "WSL2 — capping docker MTU (1400) so the image pull doesn't fail on TLS…"
  run python3 -c "import json,os; p='/etc/docker/daemon.json'; d=json.load(open(p)) if os.path.exists(p) else {}; d['mtu']=1400; json.dump(d, open(p,'w'))" 2>/dev/null \
    && { run systemctl restart docker 2>/dev/null || true; run docker info >/dev/null 2>&1 || true; } \
    || warn "couldn't set docker MTU automatically — if the pull fails with a TLS error, set {\"mtu\":1400} in /etc/docker/daemon.json"
fi

# ── 4. config (wallet + control URL) ──────────────────────────────────────────────────────
CONTROL_URL="${CIRCUIT_CONTROL_URL:-$CONTROL_URL_DEFAULT}"
WALLET="${CIRCUIT_PAYOUT_WALLET:-}"
if [ -z "$WALLET" ] && [ -t 0 ]; then
  echo
  read -rp "$(c '1;36' '?') Solana wallet for CIRC earnings (blank to run unpaid for now): " WALLET || true
fi

# Public-IP boxes (cloud) advertise their address so the coordinator can dial them. Home boxes
# behind NAT need the relay (CIRCUIT_RELAY_URL) — pass it through when set.
ADV_HOST="${CIRCUIT_ADVERTISE_HOST:-}"
if [ -z "$ADV_HOST" ] && [ -z "${CIRCUIT_RELAY_URL:-}" ]; then
  PUBIP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
  [ -n "$PUBIP" ] && ADV_HOST="$PUBIP"
  warn "advertising public IP ${ADV_HOST:-<unknown>}. If this box is behind a home router (NAT),"
  warn "behind NAT? re-run with  CIRCUIT_RELAY_URL=relay.circuitllm.xyz:18942  to route through the relay."
fi

# ── 5. pull + run ─────────────────────────────────────────────────────────────────────────
say "pulling $IMAGE …"
run docker pull "$IMAGE" >/dev/null
run docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

say "starting node…"
ARGS=(-d --name "$CONTAINER" --gpus all --restart unless-stopped
      -v "$VOLUME:/var/lib/circuit"
      -p 19210:19210
      -e CIRCUIT_CONTROL_URL="$CONTROL_URL"
      -e CIRCUIT_PAYOUT_WALLET="$WALLET")
[ -n "$ADV_HOST" ]                      && ARGS+=(-e CIRCUIT_ADVERTISE_HOST="$ADV_HOST")
[ -n "${CIRCUIT_ADVERTISE_PORT:-}" ]    && ARGS+=(-e CIRCUIT_ADVERTISE_PORT="$CIRCUIT_ADVERTISE_PORT")
[ -n "${CIRCUIT_RELAY_URL:-}" ]         && ARGS+=(-e CIRCUIT_RELAY_URL="$CIRCUIT_RELAY_URL")
[ -n "${CIRCUIT_RELAY_TOKEN:-}" ]       && ARGS+=(-e CIRCUIT_RELAY_TOKEN="$CIRCUIT_RELAY_TOKEN")
[ -n "${CIRCUIT_REGION:-}" ]            && ARGS+=(-e CIRCUIT_REGION="$CIRCUIT_REGION")
run docker run "${ARGS[@]}" "$IMAGE" >/dev/null

echo
ok "Circuit GPU node is running."
echo "  joined:   $CONTROL_URL"
echo "  earnings: ${WALLET:-<none set — re-run with a wallet to earn>}"
echo
echo "  $(c '1;36' 'logs:')     docker logs -f $CONTAINER"
echo "  $(c '1;36' 'stop:')     docker stop $CONTAINER"
echo "  $(c '1;36' 'update:')   docker pull $IMAGE && bash join.sh"
echo
say "first start downloads the model shard for your assigned layers — give it a few minutes."
