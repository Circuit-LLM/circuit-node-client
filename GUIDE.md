# CIRCUIT Node Client — Setup & User Guide

Run a node on the CIRCUIT distributed Solana data and inference network. This guide covers installation, configuration, the dashboard, decentralized LLM inference, and CIRC token staking.

---

## What Is a CIRCUIT Node?

CIRCUIT is a Solana-native network combining two layers:

**Data mesh** — the canonical node at [circuitllm.xyz](https://circuitllm.xyz) aggregates on-chain data (token prices, wallet analytics, DEX pool data, validator stats) and serves it through an API gated by x402 CIRC micropayments. Running a node participates in the distributed mesh that will eventually serve this data without relying on the canonical hub.

**Decentralized LLM inference** — a pipeline of worker nodes, each holding a shard of a transformer model (Qwen2.5-0.5B), cooperating to run inference requests across the network. Node operators earn CIRC for compute contributed. Any node operator can chat with the inference network for free from their dashboard.

---

## Prerequisites

- **Node.js v18 or later** — check with `node --version`
- **Git**
- **Internet access** to reach `node.circuitllm.xyz`
- A terminal on macOS, Linux, or WSL on Windows
- ~80MB RAM if enabling the LLM inference worker (optional)

---

## Installation

```bash
git clone https://github.com/Circuit-LLM/circuit-node-client.git
cd circuit-node-client
npm install
```

No build step required.

---

## Configuration

Before first run, copy the example config and edit it:

```bash
cp config/client.example.json config/client.json
```

Open `config/client.json` in any text editor. The most important fields:

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

**Region codes:**

| Code | Location |
|------|----------|
| `us-east` | US East Coast |
| `us-west` | US West Coast |
| `eu-west` | Western Europe |
| `eu-central` | Central Europe |
| `ap-southeast` | Southeast Asia |
| `ap-northeast` | Northeast Asia |

**Port** — `19000` is the default. Change it in `node.apiPort` if something else is already using that port.

If you don't create `config/client.json` before starting, the node automatically copies the example on first launch.

---

## Starting the Node

```bash
node node-client.js start
```

On first run the node:

1. Generates a permanent ed25519 keypair and saves it to `data/identity.json`
2. Announces itself to the CIRCUIT network registry
3. Starts the dashboard and local API server on the configured port
4. Begins sending heartbeats every 60 seconds to stay registered

You'll see output like:

```
[node-client] Node identity loaded: abc123...
[node-client] Registered on network. NodeId: abc123...
[node-client] Dashboard: http://localhost:19000
```

Open `http://localhost:19000` in your browser.

> **Critical:** `data/identity.json` is your node's permanent identity. Back it up. Deleting it means losing your node ID and having to re-register as a new node.

---

## CLI Commands

```bash
node node-client.js start              # Start the node (default)
node node-client.js setup              # Show identity and current config
node node-client.js status             # Check node + network status
node node-client.js update             # Check for and apply updates
node node-client.js rollback           # List available rollback versions
node node-client.js rollback <version> # Roll back to a specific version
node node-client.js deregister         # Remove from network and exit cleanly
```

---

## The Dashboard

The dashboard runs at `http://localhost:19000`. It has seven tabs.

### Overview Tab

The home screen. Shows at a glance:

- **Node status** — online/offline, your Node ID (first 16 characters), software version, region
- **Network sync** — whether your local cache is in sync with the canonical hub
- **Hub connection** — reachability of `node.circuitllm.xyz`
- **Activity log** — rolling log of node events (registration, heartbeats, update checks)
- **Uptime** — how long the current process has been running

If the hub shows as unreachable, check your internet connection. The node continues serving locally even when the hub is temporarily offline.

---

### Keys Tab

Shows your **Node ID** — the base64 ed25519 public key that identifies your node on the network. This is safe to share publicly. All registry communications are signed with the corresponding private key in `data/identity.json`.

Also contains the **CIRC Staking** panel — connect your Phantom or Solflare wallet to verify your on-chain stake position. See the [CIRC Staking](#circ-staking) section below.

---

### Network Tab

Shows the state of the broader CIRCUIT mesh:

- **Live node map** — all nodes currently registered, their regions, and online status
- **Shard coverage** — which data shards are covered by how many nodes
- **Version distribution** — what software versions the network is running
- **Peer list** — nodes visible to the registry

In Phase 1 all nodes run the full `all` shard set and proxy data from the canonical hub. In Phase 2, each node will be assigned 3 of 8 specialized shards based on a consistent hash of its Node ID. The shard assignment for your node is deterministic — you can see it now in the shard section.

---

### Updates Tab

Shows:

- **Current version** vs. **latest available** on GitHub
- **Update history** — timestamp and version of each previous update applied
- **Rollback controls** — revert to any previous version if needed

Updates are verified before being applied:

1. SHA-256 checksum of the downloaded archive must match
2. ed25519 signature from the Circuit LLM operator key must verify (if `signingPublicKey` is set)

If either check fails, the update is rejected and the current version stays. The node backs up your installation before applying any update.

Auto-update is on by default. To disable:

```json
"updates": { "autoUpdate": false }
```

---

### Inference Tab

A **free** streaming LLM chat interface connected directly to the CIRCUIT decentralized inference network.

**How it works:**

The chat is proxied through your node's local API at `POST /inference/chat`. The node tries to reach the inference coordinator at `localhost:19200` first. If the coordinator is running on the same machine as your node client, it bypasses the x402 payment gate and inference is **completely free**. Remote nodes not co-located with a coordinator will see a payment-required message.

**Features:**

- Streams responses token-by-token as the distributed pipeline processes them
- Maintains conversation context across turns (up to 12 messages)
- **CLEAR** button to reset the session
- Status bar shows coordinator availability and model name

The model is Qwen2.5-0.5B-Instruct, running distributed across the worker mesh.

---

### Agent Tab

If you've connected a `circuit-agent` by setting `agentDataPath` in your config, this tab shows:

- Open trading positions
- Recent trade history
- Agent P&L
- Wallet and session info

To connect an agent:

```json
"node": {
  "agentEnabled": true,
  "agentDataPath": "../circuit-agent/data"
}
```

If no agent is connected, this tab shows "agent not configured."

---

### Cloud Tab

Your contribution to the **Circuit agent cloud** — the decentralized CPU layer that hosts other users' autonomous agents. (Inference runs on GPUs; agents run on the CPUs that hang off the same nodes.) The tab is **read-only** and shows:

- **Hosting status** — whether this node is currently running cloud agents, and its budget (`MAX_AGENTS`, per-agent memory)
- **Hosted agents** — each agent's name, workload, state, P&L, scans, and uptime
- **Cloud-wide** — nodes online and agents running across the whole cloud (when a control plane is configured)

Custody is **off-box**: this node runs the agents' compute but never holds their signing keys — those stay in the [signer](https://github.com/Circuit-LLM/circuit-agent-cloud). So nothing here can move funds; it's purely visibility.

Configure it with an `agentCloud` block (both fields optional):

```json
"agentCloud": {
  "hostDir": null,
  "controlPlane": "https://agents.circuitllm.xyz"
}
```

`hostDir` is the co-located node-host's data dir (the tab reads `<hostDir>/status.json`); leave it `null` to use `~/.circuit-host`. `controlPlane` adds the cloud-wide view (or set `CIRCUIT_CONTROL_PLANE`). Start contributing with `circuit agent host`; if you're not hosting yet, the tab explains how.

---

### Chat Tab

When an agent is connected, this tab gives you an LLM chat interface that speaks as your trading agent — with full context of open positions, trade history, and active strategy.

The chat uses your agent's configured OpenRouter key. No separate key is needed in the node config.

The WebSocket connection is at `ws://localhost:19000/chat` and only accepts localhost connections — it is not exposed externally.

---

## LLM Inference Worker

Your node can join the CIRCUIT decentralized inference network and earn CIRC for compute. When enabled, the coordinator at `inference.circuitllm.xyz` assigns your node a shard of transformer layers. During inference requests, all nodes process their assigned layers in sequence as a pipeline.

**CIRC earnings** — each inference payment is split proportionally across all active nodes based on the share of transformer layers they handle.

### Enabling the Worker

In `config/client.json`:

```json
"llmWorker": {
  "enabled":        true,
  "port":           19110,
  "coordinatorUrl": "https://inference.circuitllm.xyz",
  "walletAddress":  "YourSolanaWalletAddress"
}
```

| Field | Description |
|-------|-------------|
| `enabled` | Set `true` to join the network |
| `port` | TCP port the coordinator connects to for tensor pipeline traffic |
| `coordinatorUrl` | The inference coordinator — do not change |
| `walletAddress` | Your Solana wallet for CIRC earnings attribution |

> The weight-delivery HTTP port is always `port + 1000` (e.g. 19110 → weight delivery on 20110). Both ports must be reachable inbound from the coordinator.

### What Happens at Startup

1. The LLM worker process starts on the configured port
2. It registers with the coordinator and receives its layer assignment (e.g. layers 4–7 of 24)
3. The coordinator streams the model weight shard for those layers (~40MB)
4. Your node is now active in the inference pipeline

Check worker status at `GET /llm/status` on your node API, or see it in the `/health` response.

### Resource Usage

- **RAM** — ~80MB per node for a 4-layer shard of Qwen2.5-0.5B
- **CPU** — bursts during inference steps (~1–2 seconds per request)
- **Network** — initial weight download (~40MB), then lightweight tensor traffic during inference

### Firewall Note

The coordinator initiates TCP connections **to your worker**. If you're behind a firewall or NAT, open inbound TCP on:

- Your worker port (default `19110`)
- Your weight-delivery port (default `20110`)

---

## CIRC Staking

### What Staking Does

In the current Phase 1 build, staking CIRC into the CIRCUIT StakePoint pool verifies your token ownership on-chain. The staking panel in the Keys tab shows your stake status but does not yet gate access — staking is pre-staged for Phase 3, where CIRC stake will determine RPC tier.

In Phase 3:
- Stake CIRC → maintain RPC credentials for yourself and your agents
- Higher stake = higher RPC tier (rate limits, priority routing)
- Data API calls (the `/api` endpoints) remain x402-gated regardless of stake

### Connecting Your Wallet

In the **Keys tab**, find the **CIRC Staking Access** card. Click **Connect Wallet**.

This opens your Phantom or Solflare wallet extension. Approve the connection — no transaction is signed, this is a read-only check to see your stake balance.

Your wallet address is saved in browser local storage, so the next dashboard load reconnects automatically.

### What the Staking Panel Shows

Once your wallet is connected:

- **Status badge** — `● UNLOCKED` (yellow, glowing) if your stake meets the minimum, `○ STAKE REQUIRED` if not
- **Staked amount** — total CIRC across all your positions in the pool
- **Required minimum** — the threshold configured by the pool
- **Progress bar** — visual fill showing staked / required ratio
- **Lock status** — if your stake has an active time-lock and when it expires
- **Pool link** — direct link to the StakePoint pool page

### Staking CIRC

1. Go to the StakePoint pool URL shown in the panel (or [stakepoint.app](https://stakepoint.app) → find the CIRCUIT pool)
2. Connect your Solana wallet on StakePoint
3. Stake your CIRC — choose an amount and optional lock period (longer locks earn higher APR)
4. Once the transaction confirms, click **Refresh** in the dashboard staking panel

The dashboard queries stake positions on-chain directly — no intermediary API, no trust required. Reflects true on-chain state within a 5-minute cache window.

### Multiple Positions

If you've staked in multiple transactions you may have multiple positions. The dashboard sums all of them — only the total matters for the access gate.

### When You Unstake

Unstaking on StakePoint reduces your `staked_amount` on-chain. The dashboard reflects this at the next check (within 5 minutes). If your total falls below the minimum, the badge changes to `○ STAKE REQUIRED`. Tokens with an active time-lock cannot be unstaked until the lock period expires — enforced by the StakePoint program.

---

## Running as a Persistent Service (systemd)

For a server or always-on machine, run the node as a systemd user service so it starts at boot and restarts automatically on crash.

```bash
# Copy the service template
cp deploy/circuit-node-client.service ~/.config/systemd/user/

# Edit WorkingDirectory and ExecStart paths
nano ~/.config/systemd/user/circuit-node-client.service

# Reload systemd and enable
systemctl --user daemon-reload
systemctl --user enable circuit-node-client
systemctl --user start circuit-node-client

# Enable linger so it starts at boot without you logging in
loginctl enable-linger $USER
```

Check status and tail logs:

```bash
systemctl --user status circuit-node-client
journalctl --user -u circuit-node-client -f
```

---

## Directory Structure

```
circuit-node-client/
├── node-client.js          Entry point + CLI
├── worker.js               LLM inference worker (spawned when llmWorker.enabled)
├── config/
│   ├── client.example.json Template — copy to client.json before editing
│   └── client.json         Your config (gitignored)
├── lib/
│   ├── identity.js         ed25519 keypair management
│   ├── registry.js         Network announce + heartbeat
│   ├── server.js           API server + inference chat SSE proxy
│   ├── llm-worker.js       LLM inference worker child-process manager
│   ├── inference/          GGML dequantization + Qwen2 transformer forward pass
│   ├── access.js           CIRC stake verification + Phase 3 encryption stub
│   ├── stakepoint.js       On-chain StakePoint position query module
│   ├── shard.js            Shard assignment + routing
│   ├── sync.js             Data sync (Phase 1: HTTP poll, Phase 2: gRPC)
│   ├── agent.js            circuit-agent monitoring loop
│   ├── circuit-agent.js    Paired circuit-agent data file reader
│   ├── chat.js             WebSocket agent chat bridge
│   └── updater.js          Signed update download, verify, and apply
├── ui/
│   └── dashboard.html      Single-page dashboard (7 tabs)
├── deploy/
│   ├── generate-signing-key.js   Operator: one-time signing key setup
│   ├── publish-update.js         Operator: sign and publish a release
│   └── circuit-node-client.service  systemd unit template
└── data/                   Runtime data (gitignored — back this up)
    ├── identity.json        ← YOUR NODE IDENTITY. BACK THIS UP.
    ├── cache/               Sync'd data slices
    └── backups/             Pre-update snapshots
```

---

## Security Notes

| Concern | How It's Handled |
|---------|-----------------|
| Private key exposure | `data/identity.json` gitignored, never logged |
| Malicious updates | SHA-256 checksum + ed25519 operator signature before install |
| Node impersonation | All registry mutations are signature-verified |
| Inference access | x402 CIRC payment gate on external endpoint; localhost bypass for co-located nodes |
| External chat access | WebSocket accepts localhost connections only |
| Phase 3 data access | AES-256-GCM, key derivation requires CIRC stake |

**Files to never commit:**

```
data/identity.json     ← your node private key
config/client.json     ← your local config (may contain wallet address)
```

Both are in `.gitignore` by default.

---

## Troubleshooting

**Port already in use**

```bash
lsof -ti:19000       # find what's using the port
# then in config/client.json:
"node": { "apiPort": 19001 }
```

**Node shows offline on the Network tab**

The registry marks nodes offline after 3 missed heartbeats (~3 minutes). If you just restarted, wait one cycle. If it stays offline, check that `node.circuitllm.xyz` is reachable from your machine.

**Inference tab says "coordinator not on localhost"**

The inference coordinator is not running on this machine. The free inference bypass only works when the coordinator is co-located (same host). To use inference from a remote node, you would need to pay the x402 CIRC gate, or run a coordinator locally.

**Staking panel shows "pool not configured"**

Add the pool address to `config/client.json`:

```json
"access": {
  "stakingPool":   "<pool_account_address>",
  "stakingPoolId": "<pool_id_for_url>",
  "minStakeCirc":  100000,
  "circDecimals":  6
}
```

**Wallet connect button does nothing**

Wallet connect requires a browser extension. Install [Phantom](https://phantom.app) or [Solflare](https://solflare.com) and reload the dashboard.

**Update failed — signature verification error**

The downloaded archive doesn't match what Circuit LLM signed. Usually a network interruption. The node keeps your current version. Run `node node-client.js update` to retry.

---

## Network Roadmap

| Phase | Status | What Changes |
|-------|--------|-------------|
| Phase 1 | **Now** | Node registers, proxies data from canonical hub, joins LLM inference pipeline |
| Phase 2 | Upcoming | Shard specialization — each node owns and serves a dedicated slice of indexed data |
| Phase 3 | Planned | CIRC staking gates RPC tiers — higher stake = higher rate limits and priority routing |
