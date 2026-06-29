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

# WSL2's virtual NIC mis-sizes packets, corrupting large TLS records — the classic "tls: error
# decoding message" on `docker pull ghcr.io`. The daemon pulls over the HOST interface (eth0), so we
# cap ITS MTU. Some links need it lower than others (1400 isn't always enough), so the pull below
# retries DOWN an MTU ladder until it works, then persists whatever worked.
IS_WSL=""; IFACE="eth0"
if grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; then
  IS_WSL=1
  IFACE=$(ip route show default 2>/dev/null | awk '/default/{print $5; exit}'); IFACE="${IFACE:-eth0}"
fi

# ── 4. config (wallet + control URL) ──────────────────────────────────────────────────────
CONTROL_URL="${CIRCUIT_CONTROL_URL:-$CONTROL_URL_DEFAULT}"
WALLET="${CIRCUIT_PAYOUT_WALLET:-}"
WALLET_FROM_ENV=""; [ -n "$WALLET" ] && WALLET_FROM_ENV=1

valid_wallet() { printf '%s' "$1" | grep -qE '^[1-9A-HJ-NP-Za-km-z]{32,44}$'; }

# Preserve the wallet from an existing install so a routine re-run/update doesn't silently
# turn a *paid* node *unpaid* when the operator just hits Enter.
if [ -z "$WALLET" ]; then
  WALLET=$(run docker inspect "$CONTAINER" \
      --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | sed -n 's/^CIRCUIT_PAYOUT_WALLET=//p' | head -1) || true
fi

if [ -t 0 ]; then
  echo
  while :; do
    if [ -n "$WALLET" ]; then
      read -rp "$(c '1;36' '?') Solana wallet for CIRC earnings [$WALLET] (Enter to keep): " ANS || true
      [ -z "$ANS" ] && break
      WALLET="$ANS"
    else
      read -rp "$(c '1;36' '?') Solana wallet for CIRC earnings (blank to run unpaid for now): " WALLET || true
      [ -z "$WALLET" ] && break
    fi
    valid_wallet "$WALLET" && break
    warn "that doesn't look like a Solana address (32–44 base58 chars). Try again, or leave blank to skip."
    WALLET=""
  done
elif [ -n "$WALLET" ] && ! valid_wallet "$WALLET"; then
  # Non-interactive: a wallet the operator explicitly passed but that's malformed is a hard
  # error (don't silently earn to a typo). A bad value carried over from a prior install just
  # falls back to unpaid with a warning.
  if [ -n "$WALLET_FROM_ENV" ]; then
    die "CIRCUIT_PAYOUT_WALLET='$WALLET' is not a valid Solana address (32–44 base58 chars)."
  fi
  warn "stored wallet '$WALLET' looks invalid — running unpaid. Re-run with CIRCUIT_PAYOUT_WALLET=<addr> to fix."
  WALLET=""
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
# On WSL the ghcr.io pull TLS-errors when the MTU is too high. Try the pull, and on failure lower the
# eth0 MTU and retry — 1400 fails on some links, 1280 is the usual floor, 1200 for stubborn VPNs.
pull_image() {
  if [ -z "$IS_WSL" ]; then say "pulling $IMAGE …"; run docker pull "$IMAGE" >/dev/null; return; fi
  local mtu ok=""
  for mtu in ${CIRCUIT_MTU:-} 1400 1280 1200; do
    [ -n "$mtu" ] || continue
    run ip link set dev "$IFACE" mtu "$mtu" 2>/dev/null || true
    say "pulling $IMAGE  ($IFACE MTU $mtu) …"
    if run docker pull "$IMAGE" >/dev/null 2>&1; then ok="$mtu"; break; fi
    warn "pull failed at MTU $mtu — lowering and retrying…"
  done
  [ -n "$ok" ] || die "the image pull keeps TLS-failing even at MTU 1200.
     This is usually a VPN/proxy, or Docker Desktop (whose daemon ignores this distro's MTU):
       • Docker Desktop:  Settings → Docker Engine → add  \"mtu\": 1280  → Apply & Restart, then re-run.
       • On a VPN/corporate net:  disconnect it (or set  CIRCUIT_MTU=1200) and re-run.
     Re-run with:  curl -fsSL https://circuitllm.xyz/join | bash"
  ok "image pulled (MTU $mtu)"
  # persist the working MTU + size the container bridge to match
  grep -q "set dev $IFACE mtu" /etc/wsl.conf 2>/dev/null || printf '\n[boot]\ncommand = ip link set dev %s mtu %s\n' "$IFACE" "$ok" | run tee -a /etc/wsl.conf >/dev/null 2>&1 || true
  run python3 -c "import json,os; p='/etc/docker/daemon.json'; d=json.load(open(p)) if os.path.exists(p) else {}; d['mtu']=$ok; json.dump(d, open(p,'w'))" 2>/dev/null || true
}
pull_image
run docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# Make sure 19210 is free before binding it — a foreign holder would otherwise make `docker run`
# fail late with a cryptic bind error *after* the multi-GB pull. (Our own old container is already
# removed above, so anything still listening is something else.)
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ':19210 '; then
  die "port 19210 is already in use by another process.
     Stop whatever is listening, then re-run. To see what holds it:  sudo ss -ltnp | grep :19210"
fi

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

# Confirm it actually came up instead of crash-looping, so the operator gets a real
# "did it work?" signal rather than a hopeful banner over a dead container.
sleep 2
STATE=$(run docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo unknown)

echo
if [ "$STATE" = "running" ]; then
  ok "Circuit GPU node is running."
else
  warn "node started but its state is '$STATE' — it may have failed to launch. Check:  docker logs $CONTAINER"
fi
echo "  joined:    $CONTROL_URL"
if [ -n "$WALLET" ]; then
  echo "  earnings:  $WALLET"
else
  echo "  earnings:  $(c '1;33' '<none set — re-run with a wallet to earn>')"
fi
echo
echo "  $(c '1;36' 'verify:')   docker logs -f $CONTAINER"
echo "             $(c '2' 'watch for "registered" + your assigned layers — that confirms you are in the mesh and earning')"
echo "  $(c '1;36' 'stop:')     docker stop $CONTAINER"
echo "  $(c '1;36' 'update:')   docker pull $IMAGE && curl -fsSL https://circuitllm.xyz/join | bash"
echo
say "first start downloads the model shard for your assigned layers — give it a few minutes."
say "your node registers at $CONTROL_URL once it's pulled its shard and connected."
