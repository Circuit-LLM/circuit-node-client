# CIRCUIT Node Client — Setup & User Guide

Run a node on the CIRCUIT distributed Solana data and inference network. This guide walks you through installation, configuration, the dashboard, LLM worker setup, and CIRC token staking.

---

## What Is a CIRCUIT Node?

CIRCUIT is a Solana-native data network. The canonical node at [circuitllm.xyz](https://circuitllm.xyz) aggregates on-chain data — token prices, wallet analytics, DEX pool data, validator stats — and serves it through a paid API gated by x402 CIRC micropayments.

Running a node gives you:

- A local proxy to the CIRCUIT data API
- Participation in the distributed data mesh as it grows through Phase 2 and Phase 3
- **LLM inference earnings** — optionally run a transformer layer shard and earn CIRC for compute contributed to the decentralized inference network
- A path to staked RPC access in Phase 3

---

## Prerequisites

- **Node.js v18 or later** — check with `node --version`
- **Git**
- **Internet access** to reach `node.circuitllm.xyz`
- A terminal on macOS, Linux, or WSL on Windows

---

## Installation

```bash
git clone https://github.com/Circuit-LLM/circuit-node-client.git
cd circuit-node-client
npm install
```

That's it. No build step required.

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
    "region":   "us-east",
    "apiPort":  19000
  }
}
```

**Region codes** — pick the closest:

| Code | Location |
|------|----------|
| `us-east` | US East Coast |
| `us-west` | US West Coast |
| `eu-west` | Western Europe |
| `eu-central` | Central Europe |
| `ap-southeast` | Southeast Asia |
| `ap-northeast` | Northeast Asia |

**Port** — `19000` is the default dashboard and API port. Change it here if something else is already using that port.

If you don't create `config/client.json` before starting, the node automatically copies the example on first launch.

---

## Starting the Node

```bash
node node-client.js start
```

On first run the node:

1. Generates a permanent ed25519 keypair and saves it to `data/identity.json`
2. Announces itself to the CIRCUIT network registry
3. Starts the dashboard and local API server on port 19000
4. Begins sending heartbeats every 60 seconds to stay registered

You'll see output like:

```
[node-client] Node identity loaded: abc123...
[node-client] Registered on network. NodeId: abc123...
[node-client] Dashboard: http://localhost:19000
```

Open `http://localhost:19000` in your browser.

> **Critical:** `data/identity.json` is your node's permanent identity. Back it up. If you delete it you lose your node ID and your RPC key and will need to re-register as a new node.

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

- **Node status** — online/offline, your Node ID (first 16 characters shown), software version, region
- **Network sync** — whether your local cache is in sync with the canonical hub
- **Hub connection** — reachability of `node.circuitllm.xyz`
- **Activity log** — rolling log of node events (registration, heartbeats, update checks)
- **Uptime** — how long the current process has been running

If the hub shows as unreachable, check your internet connection. The node continues serving locally even when the hub is temporarily offline.

---

### Keys Tab

Shows your **Node ID** — the base64 ed25519 public key that identifies your node on the network. This is safe to share publicly. All registry communications are signed with the corresponding private key stored in `data/identity.json`.

Network RPC key issuance is coming in a future release.

---

### Network Tab

Shows the state of the broader CIRCUIT mesh:

- **Live node map** — all nodes currently registered on the network, their regions, and online status
- **Shard coverage** — which data shards are covered by how many nodes
- **Version distribution** — what software versions the network is running
- **Peer list** — direct peers visible to your node

In Phase 1 all nodes run the full `all` shard set and proxy data from the canonical hub. In Phase 2 each node will be assigned 3 of 8 specialized shards based on a consistent hash of its Node ID — token analytics, wallet data, DEX pool data, oracle prices, etc. The shard assignment you'll receive in Phase 2 is deterministic and you can see it here.

---

### Updates Tab

CIRCUIT ships signed updates automatically. This tab shows:

- **Current version** vs. **latest available**
- **Update history** — timestamp and version of each previous update
- **Rollback controls** — revert to any previous version if needed

Updates are cryptographically verified before being applied:

1. SHA-256 checksum of the downloaded archive must match
2. ed25519 signature from the Circuit LLM operator key must verify

If either check fails, the update is rejected and your current version stays in place. The node backs up your installation before applying any update, so rollback is always available.

Auto-update is on by default. To disable it:

```json
"updates": { "autoUpdate": false }
```

---

### Inference Tab

A free LLM chat interface that speaks directly to the CIRCUIT decentralized inference network (`inference.circuitllm.xyz`). The chat is proxied through the node's local API at `/inference/chat`.

**Free for co-located nodes** — if the inference coordinator is running on the same machine as your node client (the default VPS setup), requests hit `localhost:19200` and bypass the x402 payment gate. Remote node clients not co-located with a coordinator will see a payment-required message.

The chat maintains conversation context across turns (up to 12 messages), supports streaming responses, and includes a **Clear** button to reset the session.

---

### Agent Tab

If you've connected a `circuit-agent` by setting `agentDataPath` in your config, this tab shows:

- Open trading positions
- Recent trade history
- Agent P&L
- Active session strategy

To connect an agent:

```json
"node": {
  "agentEnabled": true,
  "agentDataPath": "../circuit-agent/data"
}
```

If no agent is connected, this tab shows "agent not configured."

---

### Chat Tab

When an agent is connected, this tab gives you an LLM chat interface that speaks as your trading agent — it has full context of open positions, trade history, and active strategy.

The chat uses your agent's configured OpenRouter key. No separate key needed in the node config.

The WebSocket connection is at `ws://localhost:19000/chat` and only accepts localhost connections — it is not exposed externally.

---

## LLM Inference Worker

Your node can join the CIRCUIT decentralized inference network. When enabled, the coordinator at `inference.circuitllm.xyz` streams a transformer layer shard to your node. During inference requests, your node processes its assigned layers in a pipeline alongside other nodes.

**CIRC earnings** — each inference payment is split proportionally across all nodes based on the share of transformer layers they handle.

### Enabling the Worker

In `config/client.json`:

```json
"llmWorker": {
  "enabled": true,
  "port": 19110,
  "coordinatorUrl": "https://inference.circuitllm.xyz",
  "walletAddress": "YourSolanaWalletAddress"
}
```

| Field | Description |
|-------|-------------|
| `enabled` | Set `true` to join the network |
| `port` | TCP port the coordinator connects to for tensor pipeline traffic |
| `coordinatorUrl` | The inference coordinator (do not change) |
| `walletAddress` | Your Solana wallet — where CIRC earnings are attributed |

> The weight-delivery HTTP port is always `port + 1000` (e.g. port 19110 → weight delivery on 20110). Both ports must be reachable from the coordinator.

### What Happens at Startup

1. The LLM worker process starts on the configured port
2. It registers with the coordinator and receives its layer assignment (e.g. layers 4–7 of 24)
3. The coordinator streams the model weight shard for those layers (~40MB per node)
4. Your node is now part of the inference pipeline

You can check worker status at `GET /llm/status` on your node API, or see it in the dashboard health endpoint.

### Resource Usage

- **RAM**: ~80MB per node for a 4-layer shard of Qwen2.5-0.5B
- **CPU**: Bursts during inference steps (~1–2 seconds per request)
- **Network**: Initial weight download (~40MB), then lightweight tensor traffic during inference

### Firewall Note

The coordinator initiates the TCP connection to your worker. If you're behind a firewall or NAT:
- Open inbound TCP on your worker port (default 19110)
- Open inbound TCP on your weight-delivery port (default 20110)

---

## CIRC Staking

### What Staking Does

In the current Phase 1 build, staking CIRC into the CIRCUIT StakePoint pool verifies your token ownership on-chain. The staking panel in the Keys tab shows your stake status, but does not yet gate access — staking is pre-staged for the Phase 3 activation where CIRC stake will determine your RPC tier.

In Phase 3:
- Stake CIRC → maintain RPC credentials for yourself and your agents
- Higher stake = higher RPC tier (rate limits, priority routing)
- Data API calls (the `/api` endpoints) remain x402-gated regardless of stake

### Connecting Your Wallet

In the **Keys tab**, find the **CIRC Staking** card. Click **Connect Wallet**.

This opens your Phantom or Solflare wallet extension (whichever you have installed). Approve the connection — no transaction is signed, this is a read-only check.

Your wallet address is saved in the browser's local storage so the next time you load the dashboard you're already connected without re-approving.

### What the Staking Panel Shows

Once your wallet is connected:

- **Status badge** — `● UNLOCKED` (yellow, glowing) if your stake meets the minimum, `● LOCKED` if not
- **Staked amount** — total CIRC across all your positions in the pool, summed precisely
- **Required minimum** — the minimum stake required for access (set by the pool config)
- **Progress bar** — visual fill showing staked / required ratio
- **Lock status** — if your stake has an active time-lock and when it expires
- **Pool link** — direct link to the StakePoint pool page to stake or add to your position

### Staking CIRC

1. Go to the StakePoint pool URL shown in the panel (or navigate to [stakepoint.app](https://stakepoint.app) and find the CIRCUIT pool)
2. Connect your Solana wallet on StakePoint
3. Stake your CIRC — choose an amount and an optional lock period (longer locks earn higher APR)
4. Once the transaction confirms, click **Refresh** in the dashboard staking panel

The dashboard queries the stake on-chain directly via `getProgramAccounts` — no intermediary API, no trust required. Verification reflects the true on-chain state within a 5-minute cache window.

### Multiple Positions

If you've staked in multiple transactions, you may have multiple positions in the pool. The dashboard sums all of them — only the total matters for the access gate. You don't need to consolidate.

### When You Unstake

Unstaking on StakePoint reduces or zeroes your `staked_amount` on-chain. The dashboard will reflect this at the next check (within 5 minutes). If your total falls below the minimum, your access badge changes to `● LOCKED`.

Tokens with an active time-lock cannot be unstaked until the lock period expires — this is enforced by the StakePoint program on-chain.

---

## Running as a Persistent Service (systemd)

For a server or always-on machine, run the node as a systemd user service so it starts at boot and restarts automatically on crash.

```bash
# Copy the service template
cp deploy/circuit-node-client.service ~/.config/systemd/user/

# Open the file and verify the paths are correct
# WorkingDirectory should point to your circuit-node-client directory
# ExecStart should point to your node binary
nano ~/.config/systemd/user/circuit-node-client.service

# Reload systemd and enable
systemctl --user daemon-reload
systemctl --user enable circuit-node-client
systemctl --user start circuit-node-client

# Enable linger so it starts at boot without you logging in
loginctl enable-linger $USER
```

Check status and logs:

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
│   ├── client.example.json Template (do not edit — copy to client.json)
│   └── client.json         Your config (gitignored)
├── lib/
│   ├── identity.js         ed25519 keypair management
│   ├── registry.js         Network announce + heartbeat
│   ├── server.js           Dashboard API + proxy
│   ├── llm-worker.js       LLM inference worker process manager
│   ├── inference/          GGML dequantization + Qwen2 transformer forward pass
│   ├── access.js           CIRC stake verification
│   ├── stakepoint.js       On-chain StakePoint query module
│   ├── shard.js            Shard assignment + routing
│   ├── sync.js             Data sync
│   ├── agent.js            Agent monitoring loop
│   ├── circuit-agent.js    Paired agent data reader
│   ├── chat.js             WebSocket chat bridge
│   └── updater.js          Signed update manager
├── ui/
│   └── dashboard.html      Single-page dashboard
├── deploy/
│   └── circuit-node-client.service  systemd template
└── data/                   Runtime data (gitignored — back this up)
    ├── identity.json        ← YOUR NODE IDENTITY. BACK THIS UP.
    ├── cache/               Sync'd data slices
    └── backups/             Pre-update snapshots
```

---

## Security Notes

| Concern | How It's Handled |
|---------|-----------------|
| Private key exposure | `data/identity.json` chmod 600, gitignored |
| Malicious updates | ed25519 signature + SHA-256 checksum before install |
| Node impersonation | All registry mutations are signature-verified |
| External chat access | WebSocket accepts localhost only |
| Phase 3 data access | AES-256-GCM, key derivation requires CIRC stake |

**Files to never commit:**

```
data/identity.json      ← your node private key
```

Both are in `.gitignore` by default. Double-check before pushing a fork.

---

## Troubleshooting

**Port already in use on 19000**

```bash
# Find what's using the port
lsof -ti:19000

# Change your port in config/client.json:
"node": { "apiPort": 19001 }
```

**Node shows offline on the network tab**

The registry marks nodes offline after 3 missed heartbeats (~3 minutes). If you just restarted, wait one cycle. If it stays offline, check that `node.circuitllm.xyz` is reachable from your machine.

**Staking panel shows "pool not configured"**

The CIRC staking pool must be added to `config/client.json`:

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

This means the downloaded archive doesn't match what Circuit LLM signed. This usually indicates a network interruption during download. The node keeps your current version. Run `node node-client.js update` again to retry.

---

## Network Roadmap

| Phase | Status | What Changes |
|-------|--------|-------------|
| Phase 1 | **Now** | Node registers, gets `pnk_` RPC key, proxies data from canonical hub |
| Phase 2 | Upcoming | Shard specialization — each node owns and serves a slice of indexed data |
| Phase 3 | Planned | CIRC staking gates RPC tiers — stake more CIRC, get higher rate limits and priority routing |

Your node ID and RPC key carry forward through all phases unchanged.
