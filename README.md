<div align="center">

# circuit-node-client

**Run a node on the CIRCUIT distributed network. Serve data, power decentralized LLM inference, and earn CIRC — with a one-command setup and a built-in dashboard.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/Circuit-LLM/circuit-node-client/releases)
[![Network](https://img.shields.io/badge/network-CIRCUIT-gold)](https://circuitllm.xyz)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

[Website](https://circuitllm.xyz) · [Data API](https://api.circuitllm.xyz) · [Telegram](https://t.me/circuitllm) · [X / Twitter](https://x.com/CircuitLLM)

</div>

---

**[What it does](#what-it-does)** · **[Quick Start](#quick-start)** · **[Desktop app](#desktop-app)** · **[Dashboard](#dashboard)** · **[Inference](#decentralized-llm-inference)** · **[CLI](#cli-commands)** · **[Config](#configuration)** · **[CIRC Staking](#circ-staking)** · **[Security](#security)**

---

## What it does

- **Joins the CIRCUIT data mesh** — syncs on-chain data from the canonical hub and serves it locally. In Phase 2, each node owns a dedicated shard of indexed Solana data.
- **Optionally runs a GPU inference node** — one command turns a GPU box into a stage of the **decentralized Qwen2.5-72B**, serving real traffic and earning a proportional share of CIRC inference fees. See [Run a GPU node](#run-a-gpu-node-earn-circ).
- **Free inference chat** — the dashboard's Inference tab gives you a streaming LLM chat interface, connected to the CIRCUIT decentralized network. Free for node operators running a co-located coordinator.
- **Stays current automatically** — checks GitHub releases every hour, verifies checksum + ed25519 operator signature before applying, and keeps a rollback archive so you can revert to any previous version.
- **Tracks CIRC staking** — connects your Phantom or Solflare wallet to verify your on-chain stake. Phase 3 will use stake to gate RPC access tiers.

---

## Quick Start

```bash
git clone https://github.com/Circuit-LLM/circuit-node-client.git
cd circuit-node-client
npm install
node node-client.js
```

Open the dashboard at **`http://localhost:19000`**

On first run the node generates a permanent ed25519 keypair, announces itself to the CIRCUIT registry, and starts sending heartbeats every 60 seconds.

> **Back up `data/identity.json`** — it's your node's permanent identity on the network. Deleting it means re-registering as a new node.

---

## Desktop app

Prefer a click to a terminal? The **Circuit Node desktop app** (in [`desktop/`](desktop/)) wraps this exact client in a native window — a system-tray background service with a setup wizard, live dashboards, OS notifications, launch-on-login, and one-button updates, for both ways to contribute (CPU agent hosting and GPU inference).

It is **additive, not a replacement.** The app runs the same `node-client` and registers the same way, so a node is identical to the network however it was installed — and **every command below keeps working exactly as it does today.** You can install with the app and still drive it from the CLI, or vice-versa.

- **Download:** grab the installer for your OS from the [**latest release**](https://github.com/Circuit-LLM/circuit-node-client/releases/latest) — Windows `.exe`/`.msi`, macOS (Apple Silicon) `.dmg`, Linux `.deb`.
  > The installers are currently **unsigned**, so Windows SmartScreen and macOS Gatekeeper warn about an unknown developer. On Windows: *More info → Run anyway*. On macOS: right-click the app → *Open*. Code-signing (which removes the warning) comes later.
- **Build from source** (Rust + Node + bun): see [`desktop/README.md`](desktop/README.md).

Under the hood the app runs the client as a self-contained sidecar, keeping its config and data in a per-user directory via `CIRCUIT_NODE_HOME` (unset on a normal CLI install, so nothing changes for terminal users).

---

## Requirements

- **Node.js ≥ 18** — check with `node --version`
- Internet access to reach `node.circuitllm.xyz`
- An **NVIDIA GPU** only if you also run a GPU inference node — that's a **separate one-line Docker install** ([Run a GPU node](#run-a-gpu-node-earn-circ)), not this Node.js client

---

## Dashboard

Open **`http://localhost:19000`** while the node is running for full visibility from your browser.

| Tab | What you get |
|-----|-------------|
| **Overview** | Node identity, version, region, sync status, hub reachability, live activity log, uptime |
| **RPC Key** | Your RPC API key and node public key, the local API base URL + auth header, access tiers |
| **Network** | Live node map, shard coverage, version distribution, peer list |
| **Updates** | Current vs latest version, update history, one-click rollback controls |
| **Staking** | Connect a wallet and view your CIRC stake position — staked amount, requirement, shortfall, lock |
| **DLLM** | The decentralized-LLM mesh (model, endpoint, coverage) and your GPU worker contribution, if you run one |
| **Inference** | Free streaming LLM chat via the CIRCUIT decentralized inference network |
| **Agent** | Trading stats and positions (if a `circuit-agent` is paired) |
| **Cloud** | Your contribution to the **agent cloud** — whether this node is hosting agents, which ones (state, P&L, uptime), and cloud-wide node/agent counts |
| **Chat** | Conversation interface with a paired `circuit-agent` |

The **Cloud** tab is read-only. If you've lent spare CPU to the agent cloud (`circuit agent host`), it shows the agents this node runs for other users. Custody is **off-box** — your machine runs the agents' compute but never holds their signing keys (those live in the [signer](https://github.com/Circuit-LLM/circuit-agent-cloud)). Not contributing yet? The tab tells you how to start.

---

## Run a GPU node (earn CIRC)

GPU inference runs the real engine ([Circuit-LLM/circuit-dllm](https://github.com/Circuit-LLM/circuit-dllm)),
not this Node.js client. Your GPU holds a contiguous slice of **Qwen2.5-72B-Instruct-AWQ**, the
coordinator pipelines activations through it, and you earn CIRC ∝ the layers × tokens you serve.

**One command** (needs an NVIDIA GPU):

```bash
# Linux / WSL2 (run inside a bash shell):
curl -fsSL https://circuitllm.xyz/join | bash
```

**On Windows**, run this in an **Administrator PowerShell** instead — it sets up WSL2 + the GPU
passthrough, then runs the installer above inside it:

```powershell
irm https://circuitllm.xyz/join.ps1 | iex
```

> Don't paste the `curl … | bash` line into PowerShell — PowerShell's `curl` is an alias for
> `Invoke-WebRequest`, so it prints the HTTP response instead of running the script. Use the
> `irm … | iex` line above (or run the bash line from inside a WSL/Ubuntu shell).

It auto-installs Docker + the NVIDIA Container Toolkit if missing, pulls the GPU image, asks for a
payout wallet, and runs an auto-restarting container. **You never touch a docker command.** The node
detects your GPU, sizes how many layers it can hold from VRAM, registers (ed25519-signed) at
`https://node.circuitllm.xyz`, downloads only its assigned slice, and serves.

- **Cloud / public-IP GPUs** (RunPod, Vast, a rented box) work out of the box.
- **Home desktops behind NAT** — no port-forwarding: set `CIRCUIT_RELAY_URL=<relay-host:port>` and the
  node dials out to the relay, which bridges the coordinator to it ([RELAY.md](https://github.com/Circuit-LLM/circuit-dllm/blob/main/docs/RELAY.md)).
- **Verification, not gating** — the mesh is open; a new GPU starts on probation (never the primary
  for a token) and is promoted only after it passes correctness challenges against a trusted replica
  ([VERIFICATION.md](https://github.com/Circuit-LLM/circuit-dllm/blob/main/docs/VERIFICATION.md)).

Manage it with plain Docker: `docker logs -f circuit-gpu-node`, `docker stop circuit-gpu-node`.

### Windows (WSL2)

A Windows desktop with an NVIDIA GPU joins through WSL2 — the GPU passes through, no dual-boot:

1. **Install WSL2** (PowerShell as admin): `wsl --install` → reboot.
2. **Install the NVIDIA *Windows* driver** (the Game-Ready/Studio driver — it provides CUDA to WSL).
   Do **not** install a GPU driver *inside* WSL; the Windows driver is the one WSL uses.
3. Open the **Ubuntu (WSL)** terminal and run the same one-liner:
   ```bash
   curl -fsSL https://circuitllm.xyz/join | bash
   ```
The installer detects WSL2 and sets up Docker + the NVIDIA Container Toolkit inside it. Most home
Windows boxes are behind NAT — set `CIRCUIT_RELAY_URL` so the node joins via the relay.

## Free chat for node operators

The dashboard's **Inference tab** streams from the live decentralized **Qwen2.5-72B** — token by
token, with multi-turn context and a CLEAR button. For an operator co-located with the coordinator it
hits `localhost:19200` and bypasses the x402 gate, so it's **free**.

**Resource usage (this Node.js client):** ~80MB RAM — it runs data sync + the dashboard and is light. GPU inference is a **separate** Docker container with its own (GPU) footprint.

→ [Full setup and firewall guide](GUIDE.md#llm-inference-worker)

---

## Configuration

Copy the example config before first run:

```bash
cp config/client.example.json config/client.json
```

Minimum setup to get started:

```json
{
  "network": {
    "registryUrl": "https://node.circuitllm.xyz"
  },
  "node": {
    "region":  "us-east",
    "apiPort": 19000
  }
}
```

**Region codes:** `us-east` · `us-west` · `eu-west` · `eu-central` · `ap-southeast` · `ap-northeast`

**Agent cloud (Cloud tab):** to surface your CPU-hosting contribution, add an `agentCloud` block. Both fields are optional — leave `hostDir` null to read the default `~/.circuit-host`, and set `controlPlane` to also show cloud-wide stats (or use the `CIRCUIT_CONTROL_PLANE` env var):

```json
{
  "agentCloud": {
    "hostDir": null,
    "controlPlane": "https://agents.circuitllm.xyz"
  }
}
```

If you skip this step, the node auto-creates `client.json` from the example on first launch.

→ [Full configuration reference](GUIDE.md#configuration)

---

## CLI Commands

```bash
node node-client.js                    # Start the node (default)
node node-client.js stop               # Stop the running node (graceful; add --force for SIGKILL)
node node-client.js setup              # Interactive setup wizard (region, port, agent pairing)
node node-client.js status             # Check node + network status
node node-client.js update             # Check GitHub for updates and apply
node node-client.js rollback           # List available rollback targets
node node-client.js rollback <version> # Roll back to a specific version
node node-client.js deregister         # Remove from network and exit cleanly
```

---

## CIRC Staking

In the **Staking tab**, click **Connect Wallet** to link your Phantom or Solflare wallet. The panel queries your on-chain stake position in the CIRCUIT StakePoint pool and shows:

- Status badge — `● UNLOCKED` (stake met) or `○ STAKE REQUIRED`
- Total staked CIRC across all positions
- Progress bar toward the minimum threshold
- Lock status and expiry (if any)

Phase 3 will use CIRC stake to gate RPC tiers — higher stake = higher rate limits and routing priority. Staking is pre-staged and ready; the gate isn't active yet.

> **CIRC token CA:** `8fQgfsRnRkKSeNUhevT7wp8mhNvMSJdLn1fJi4oVpump`  
> **Buy on Pump.fun:** [pump.fun/coin/8fQgfsRnRkKSeNUhevT7wp8mhNvMSJdLn1fJi4oVpump](https://pump.fun/coin/8fQgfsRnRkKSeNUhevT7wp8mhNvMSJdLn1fJi4oVpump)

→ [Full staking guide](GUIDE.md#circ-staking)

---

## Network Phases

| Phase | Status | What Changes |
|-------|--------|--------------|
| **Phase 1** | **Now** | Node registers, proxies data from canonical hub, joins LLM inference pipeline |
| **Phase 2** | Upcoming | Shard specialization — each node owns a slice of indexed Solana data, served directly |
| **Phase 3** | Planned | CIRC staking gates RPC tiers — higher stake = higher rate limits and routing priority |

---

## Run as a Service (systemd)

For a server or always-on machine, run the node as a systemd user service:

```bash
cp deploy/circuit-node-client.service ~/.config/systemd/user/
# Edit WorkingDirectory and ExecStart to match your install path
systemctl --user daemon-reload
systemctl --user enable circuit-node-client
systemctl --user start circuit-node-client
loginctl enable-linger $USER   # start at boot without login
```

```bash
systemctl --user status circuit-node-client
journalctl --user -u circuit-node-client -f
```

---

## Updates

The node checks [GitHub releases](https://github.com/Circuit-LLM/circuit-node-client/releases) every hour and applies updates automatically. Before applying, it verifies SHA-256 checksum and ed25519 operator signature, backs up your installation, then restarts. Rollbacks are always available via the Updates tab or:

```bash
node node-client.js rollback
```

To disable auto-update:

```json
"updates": { "autoUpdate": false }
```

---

## Security

| Concern | Protection |
|---------|------------|
| Private key exposure | `data/identity.json` gitignored, never logged |
| Malicious updates | HTTPS + SHA-256 checksum + ed25519 operator signature before install |
| Node impersonation | All registry mutations are signature-verified server-side |
| Inference access | x402 CIRC payment gate on external endpoint; localhost bypass for co-located nodes |
| External chat access | WebSocket chat accepts localhost connections only |
| GPU node auth | Each GPU node has a permanent ed25519 identity (node_id = public key); it signs its registration and the relay nonce, and receives a **per-node** ChaCha20 data-wire key — revoking one node never re-keys the rest. No shared cluster key |
| Verified compute | New GPU nodes serve on probation and are promoted only after passing correctness challenges against a trusted replica — a bad node never becomes the primary for a token |
| KV cache isolation | KV state resets at position 0 of each new sequence — no bleed between sessions |
| Corrupt shards | Dequantization bounds-checked on load — truncated shards throw before inference |
| Duplicate connections | Worker skips reconnect if already connected or connecting |
| Phase 3 data access | AES-256-GCM, key derivation requires CIRC token ownership |

**Files that must never be committed:**

```
data/identity.json   ← your node private key
config/client.json   ← your local config
```

Both are in `.gitignore` by default.

---

## Docs

- [**Setup & User Guide**](GUIDE.md) — full dashboard walkthrough, LLM inference worker setup, staking, systemd, troubleshooting
- [OPS Terminal](https://circuitllm.xyz/data) — live source health, endpoint status, network stats

---

## Community

- **X / Twitter:** [@CircuitLLM](https://x.com/CircuitLLM)
- **Telegram:** [t.me/circuitllm](https://t.me/circuitllm)
- **Website:** [circuitllm.xyz](https://circuitllm.xyz)
