// node-client.js — CIRCUIT Node Client entry point.
//
// Usage:
//   node node-client.js           — start the node (default)
//   node node-client.js setup     — interactive setup wizard
//   node node-client.js status    — print current node status
//   node node-client.js deregister — remove from network and exit
//
// What this does:
//   1. Loads or generates node identity (ed25519 keypair)
//   2. Announces to the CIRCUIT network registry
//   3. Starts the lite API server (local proxy + WebSocket chat)
//   4. Starts data sync (HTTP polling now, gRPC in Phase 2)
//   5. Starts heartbeat loop (stays registered)
//   6. Starts local agent (optional — monitors cache, reports swarm signals)
//   7. Starts update checker (applies signed updates from Circuit LLM)
//
// Configuration: config/client.json
// Identity:      data/identity.json  (DO NOT delete — this is your nodeId)
// Cache:         data/cache/         (sync'd data slices)
//
// Run under systemd or PM2 for persistence.
// See deploy/circuit-node-client.service for a systemd unit template.
'use strict';

process.stdout.on('error', err => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', err => { if (err.code !== 'EPIPE') throw err; });

const fs      = require('fs');
const path    = require('path');

const identity   = require('./lib/identity');
const registry   = require('./lib/registry');
const sync       = require('./lib/sync');
const server     = require('./lib/server');
const updater    = require('./lib/updater');
const circuitAgent = require('./lib/circuit-agent');
const { computeAssignment } = require('./lib/shard');

const CONFIG_FILE  = path.join(__dirname, 'config', 'client.json');
const EXAMPLE_FILE = path.join(__dirname, 'config', 'client.example.json');

// ── Secret loader ─────────────────────────────────────────────────────────────
// Priority: Infisical (VPS deployments) → process.env → null
function loadSecret(name) {
  if (process.env[name]) return process.env[name];
  const script = path.join(process.env.HOME || '/root', '.openclaw', 'credentials', 'infisical-get.sh');
  if (fs.existsSync(script)) {
    try {
      const { execFileSync } = require('child_process');
      const val = execFileSync(script, [name], { encoding: 'utf8', timeout: 5000 }).trim();
      if (val && !val.startsWith('Error:')) return val;
    } catch {}
  }
  return null;
}

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  // Auto-copy example on first run — git pull never overwrites local settings
  if (!fs.existsSync(CONFIG_FILE)) {
    if (fs.existsSync(EXAMPLE_FILE)) {
      fs.copyFileSync(EXAMPLE_FILE, CONFIG_FILE);
      console.log('[node-client] Created config/client.json from client.example.json');
      console.log('[node-client] Edit config/client.json to set your region, port, and registry URL.');
    } else {
      console.error('[node-client] No config/client.json or client.example.json found.');
      process.exit(1);
    }
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    console.error('[node-client] Cannot read config/client.json:', err.message);
    process.exit(1);
  }

  // CIRCUIT_RPC_URL overrides solanaRpcUrl — Infisical for our nodes, env var for user nodes.
  const circuitRpc = loadSecret('CIRCUIT_RPC_URL');
  if (circuitRpc) {
    config.network = config.network || {};
    config.network.solanaRpcUrl = circuitRpc;
  }

  // Staking pool loaded from Infisical — never hardcode on-chain addresses in config files.
  // Empty value = staking gate not configured (returns informational response on /stake/check).
  const stakingPool   = loadSecret('CIRCUIT_STAKING_POOL');
  const stakingPoolId = loadSecret('CIRCUIT_STAKING_POOL_ID');
  if (stakingPool || stakingPoolId) {
    config.access = config.access || {};
    if (stakingPool)   config.access.stakingPool   = stakingPool;
    if (stakingPoolId) config.access.stakingPoolId = stakingPoolId;
  }

  return config;
}

// ── Commands ──────────────────────────────────────────────────────────────────

const command = process.argv[2] ?? 'start';

if (command === 'setup') {
  runSetup();
} else if (command === 'status') {
  runStatus();
} else if (command === 'deregister') {
  runDeregister();
} else if (command === 'update') {
  runUpdate();
} else if (command === 'rollback') {
  runRollback(process.argv[3]);
} else if (command === 'start' || !command) {
  runNode();
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Usage: node node-client.js [start|setup|status|update|rollback <version>|deregister]');
  process.exit(1);
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function runNode() {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log('║       CIRCUIT NODE CLIENT v0.1.0        ║');
  console.log('║   Distributed RPC & Data Network      ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log('');

  const config = loadConfig();

  // Load or generate identity
  const id = identity.loadIdentity();
  console.log(`[node-client] Node ID: ${id.nodeId.slice(0, 24)}…`);
  console.log(`[node-client] Version: ${config.node.version}`);
  console.log(`[node-client] Region:  ${config.node.region}`);
  console.log('');

  // Compute shard assignment (Phase 1: 'all', Phase 2: deterministic)
  const shards = computeAssignment(id.nodeId, config.node?.phase ?? 1);
  config.node.shards = shards;
  console.log(`[node-client] Shards: ${shards.join(', ')}`);

  // 1. Announce to network registry
  const node = await registry.announce(config);
  if (!node) {
    console.warn('[node-client] Could not reach registry — starting in offline mode');
    console.warn('[node-client] Will retry registration via heartbeat loop');
  }

  // 2. Start data sync
  await sync.start(config);

  // 3. Start lite API server
  server.start(config, () => registry.getPeers(config));

  // 4. Start heartbeat
  const aDataPath = config.node?.agentDataPath ? path.resolve(config.node.agentDataPath) : null;
  registry.startHeartbeat(config, async () => ({
    agentRunning: aDataPath ? circuitAgent.isAlive(aDataPath) : false,
    syncStatus:   sync.getSyncStatus(),
  }));

  // 5. Start update checker
  updater.start(config);

  // 6. Start local agent if enabled
  if (config.node?.agentEnabled) {
    const agent = require('./lib/agent');
    agent.start(config);
  }

  console.log('');
  const port = config.node.apiPort;
  console.log(`[node-client] ✓ Node running`);
  console.log(`[node-client] ✓ Dashboard: http://localhost:${port}/`);
  console.log(`[node-client] ✓ Local API: http://localhost:${port}/api/...`);
  console.log(`[node-client] ✓ Health:    http://localhost:${port}/health`);
  if (config.node?.agentDataPath) {
    console.log(`[node-client] ✓ Chat:      ws://localhost:${port}/chat  (agent connected)`);
  } else {
    console.log(`[node-client] ✓ Chat:      ws://localhost:${port}/chat  (set agentDataPath to enable)`);
  }
  console.log('');

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  async function shutdown(signal) {
    console.log(`\n[node-client] ${signal} received — shutting down gracefully`);
    sync.stop();
    server.stop();
    updater.stop();
    await registry.deregister(config);
    console.log('[node-client] Goodbye.');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

// ── Setup wizard ──────────────────────────────────────────────────────────────

async function runSetup() {
  const readline = require('readline');
  const hasColour = process.stdout.isTTY && process.env.NO_COLOR == null;
  const G = s => hasColour ? `\x1b[0;32m${s}\x1b[0m` : s;
  const Y = s => hasColour ? `\x1b[1;33m${s}\x1b[0m` : s;
  const D = s => hasColour ? `\x1b[2m${s}\x1b[0m`    : s;
  const B = s => hasColour ? `\x1b[1m${s}\x1b[0m`    : s;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(res => rl.question(q, res));

  console.log('');
  console.log(B('  CIRCUIT Node Client — Setup'));
  console.log(D('  ─────────────────────────────────────────────'));
  console.log('');

  // Ensure identity exists
  const id = identity.loadIdentity();
  console.log(`  ${D('Node ID:')}  ${G(id.nodeId.slice(0, 28))}…`);
  console.log(`  ${D('Created:')}  ${id.createdAt}`);
  console.log(`  ${D('File:   ')}  data/identity.json  ${D('← do not delete')}`);
  console.log('');

  const config = loadConfig();

  // ── Region ────────────────────────────────────────────────────────────────
  const REGIONS = ['us-east','us-west','us-south','us-north','eu-west','eu-central','ap-northeast','ap-southeast','sa-east'];
  console.log(`  ${B('Region')}`);
  REGIONS.forEach((r, i) => console.log(`    ${D((i+1)+'.')} ${r}${r === config.node?.region ? G('  ← current') : ''}`));
  const regionAns = await ask(`  Region (1-${REGIONS.length} or enter name, Enter to keep): `);
  let region = config.node?.region ?? 'us-east';
  if (regionAns.trim()) {
    const n = parseInt(regionAns.trim(), 10);
    region = (!isNaN(n) && n >= 1 && n <= REGIONS.length) ? REGIONS[n-1] : regionAns.trim();
  }
  console.log(`  ${G('✓')} Region: ${Y(region)}`);
  console.log('');

  // ── Port ──────────────────────────────────────────────────────────────────
  console.log(`  ${B('API Port')}  ${D('(dashboard + local API, default 19000)')}`);
  console.log(`  ${D('current:')}  ${Y(config.node?.apiPort ?? 19000)}`);
  const portAns = await ask('  Port (Enter to keep): ');
  const curPort = config.node?.apiPort ?? 19000;
  const apiPort = portAns.trim() ? (parseInt(portAns.trim(), 10) || curPort) : curPort;
  console.log(`  ${G('✓')} Port: ${Y(apiPort)}`);
  console.log('');

  // ── Agent pairing ─────────────────────────────────────────────────────────
  console.log(`  ${B('Agent Pairing')}  ${D('(connect a local circuit-agent to this node)')}`);
  console.log(`  ${D('Set the path to your circuit-agent/data directory.')}`);
  console.log(`  ${D('Example: ../circuit-agent/data   or   /home/user/circuit-agent/data')}`);
  const existingAgentPath = config.node?.agentDataPath ?? '';
  if (existingAgentPath) console.log(`  ${D('current:')}  ${Y(existingAgentPath)}`);
  else console.log(`  ${D('current:')}  ${D('not configured')}`);
  const agentAns = await ask('  Agent data path (Enter to skip/keep, "none" to clear): ');
  let agentDataPath = existingAgentPath || null;
  if (agentAns.trim() === 'none') {
    agentDataPath = null;
    console.log(`  ${G('✓')} Agent pairing cleared`);
  } else if (agentAns.trim()) {
    agentDataPath = agentAns.trim();
    // Quick sanity check
    const absP = path.resolve(agentDataPath);
    const exists = fs.existsSync(path.join(absP, 'agent-identity.json'));
    if (exists) console.log(`  ${G('✓')} Agent found at: ${Y(agentDataPath)}`);
    else console.log(`  ${Y('⚠')} Path set (agent-identity.json not found yet — start circuit-agent first)`);
  } else {
    console.log(`  ${G('✓')} Agent path: ${agentDataPath ? Y(agentDataPath) : D('not set')}`);
  }
  console.log('');

  // ── Chat ──────────────────────────────────────────────────────────────────
  console.log(`  ${B('Chat')}  ${D('(AI chat in dashboard — provided by your connected circuit-agent)')}`);
  if (agentDataPath) {
    console.log(`  ${G('✓')} Chat will be available once circuit-agent is running at the path above.`);
    console.log(`  ${D('The agent\'s own LLM key (llm.openrouterKey in agent config) is used automatically.')}`);
  } else {
    console.log(`  ${Y('ℹ')} Set agentDataPath above to enable chat.`);
  }
  console.log('');

  rl.close();

  // ── Write config ──────────────────────────────────────────────────────────
  config.node               = config.node ?? {};
  config.node.region        = region;
  config.node.apiPort       = apiPort;
  config.node.agentDataPath = agentDataPath;

  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_FILE);
  console.log(`  ${G('✓  config/client.json written')}`);
  console.log('');
  console.log(`  Run ${Y('node node-client.js start')} to start your node.`);
  console.log('');
}

// ── Status ────────────────────────────────────────────────────────────────────

async function runStatus() {
  const config = loadConfig();
  const id     = identity.loadIdentity();

  console.log('\nCIRCUIT Node Client — Status\n');
  console.log(`Node ID:  ${id.nodeId.slice(0, 24)}…`);
  console.log(`Version:  ${config.node.version}`);
  console.log(`Region:   ${config.node.region}`);
  console.log(`API Port: ${config.node.apiPort}`);
  console.log(`Shards:   ${config.node.shards?.join(', ') ?? 'all'}`);

  // Check if node is registered
  try {
    const url = `${config.network.registryUrl}/api/network/nodes/${encodeURIComponent(id.nodeId)}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const data = await res.json();
    console.log(`\nNetwork status: ${data.status ?? 'not found'}`);
    if (data.lastSeenAt) console.log(`Last seen:      ${data.lastSeenAt}`);
    if (data.syncStatus) console.log(`Sync:           ${JSON.stringify(data.syncStatus)}`);
  } catch (err) {
    console.log(`\nNetwork status: unreachable (${err.message})`);
  }

  // Check local API
  try {
    const res  = await fetch(`http://localhost:${config.node.apiPort}/health`, { signal: AbortSignal.timeout(2_000) });
    const data = await res.json();
    console.log(`\nLocal API:      running (uptime: ${Math.round(data.uptime)}s)`);
    console.log(`Sync status:    ${data.sync?.status ?? 'unknown'}`);
  } catch {
    console.log('\nLocal API:      not running');
  }
}

// ── Deregister ────────────────────────────────────────────────────────────────

async function runDeregister() {
  const config = loadConfig();
  await registry.deregister(config);
  process.exit(0);
}

// ── Manual update ─────────────────────────────────────────────────────────────

async function runUpdate() {
  const { checkForUpdate, getHistory } = require('./lib/updater');
  const config = loadConfig();

  console.log(`\nCIRCUIT Node Client — Manual Update Check`);
  console.log(`Current version: ${require('./package.json').version}\n`);

  // Show last 5 update history entries
  const history = getHistory().slice(-5);
  if (history.length) {
    console.log('Recent update history:');
    for (const h of history) {
      console.log(`  ${h.at}  v${h.version}  [${h.status}]${h.reason ? ' — ' + h.reason : ''}`);
    }
    console.log('');
  }

  // Force a check (ignores autoApply — always applies if newer version found)
  const url = `${config.network.registryUrl}/api/network/updates/latest`;
  let pkg;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    pkg = await res.json();
  } catch (err) {
    console.error('Could not reach update server:', err.message);
    process.exit(1);
  }

  if (!pkg?.version) {
    console.log('No update published yet.');
    process.exit(0);
  }

  const { semver, applyUpdate } = require('./lib/updater');
  const current = require('./package.json').version;

  if (!semver.gt(pkg.version, current)) {
    console.log(`Already up to date (v${current}).`);
    process.exit(0);
  }

  console.log(`New version available: v${current} → v${pkg.version}`);
  console.log('Applying update…\n');
  await applyUpdate(pkg, config);
}

// ── Rollback ──────────────────────────────────────────────────────────────────

async function runRollback(targetVersion) {
  const { rollback, getHistory } = require('./lib/updater');

  if (!targetVersion) {
    // Show available backups
    const fs   = require('fs');
    const path = require('path');
    const backupsDir = path.join(__dirname, 'data', 'backups');
    if (!fs.existsSync(backupsDir)) {
      console.error('No backups found.');
      process.exit(1);
    }
    const versions = fs.readdirSync(backupsDir).filter(d =>
      fs.existsSync(path.join(backupsDir, d, 'backup.tar.gz'))
    );
    if (!versions.length) {
      console.error('No backups found.');
      process.exit(1);
    }
    console.log('Available rollback targets:');
    for (const v of versions) console.log(`  v${v}`);
    console.log('\nUsage: node node-client.js rollback <version>');
    process.exit(0);
  }

  console.log(`\nRolling back to v${targetVersion}…`);
  const ok = rollback(targetVersion);
  if (!ok) process.exit(1);
}
