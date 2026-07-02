// node-client.js — CIRCUIT Node Client entry point.
//
// Usage:
//   node node-client.js           — start the node (default)
//   node node-client.js stop      — stop the running node (graceful; add --force for SIGKILL)
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
const llmWorker  = require('./lib/llm-worker');
const { computeAssignment } = require('./lib/shard');

const CONFIG_FILE  = path.join(__dirname, 'config', 'client.json');
const EXAMPLE_FILE = path.join(__dirname, 'config', 'client.example.json');
// PID file — lets `node node-client.js stop` find and signal a running node without
// hunting for the process id. Written on start (runNode), removed on clean exit.
const PID_FILE     = path.join(__dirname, 'data', 'node.pid');

// True if a process with this pid is currently alive (signal 0 = liveness probe, no-op).
function pidAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }   // EPERM → exists but not ours; still "alive"
}
// Read the pid recorded in PID_FILE (null if missing/garbage).
function readPidFile() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch { return null; }
}
function writePidFile() {
  try { fs.mkdirSync(path.dirname(PID_FILE), { recursive: true }); fs.writeFileSync(PID_FILE, String(process.pid)); }
  catch (err) { console.warn('[node-client] could not write PID file:', err.message); }
}
// Remove PID_FILE only if it still points at *us* — never clobber another instance's file.
function clearOwnPidFile() {
  try { if (readPidFile() === process.pid) fs.unlinkSync(PID_FILE); } catch {}
}

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

// ── Crash safety ────────────────────────────────────────────────────────────
// Without these, an unhandled rejection / uncaught exception kills the process with
// no operator-facing context AND leaves the LLM-worker / CPU-host children orphaned
// (holding the GPU + ports → "address in use" on the next start). Shared with the
// SIGINT/SIGTERM shutdown() below via the _shuttingDown guard.
let _shuttingDown = false;

function _stopChildren() {
  for (const [name, fn] of [
    ['sync',      () => sync.stop()],
    ['server',    () => server.stop()],
    ['updater',   () => updater.stop()],
    ['llmWorker', () => llmWorker.stop()],
    ['cpu-host',  () => require('./lib/cpu-host').stop()],
  ]) {
    try { fn(); } catch (err) { console.error(`[node-client] error stopping ${name}:`, err.message); }
  }
}

process.on('unhandledRejection', (reason) => {
  // Log and keep running — a stray rejected promise shouldn't take the whole node down.
  console.error('[node-client] UNHANDLED REJECTION:', reason instanceof Error ? reason.stack : reason);
});

process.on('uncaughtException', (err) => {
  console.error('[node-client] UNCAUGHT EXCEPTION:', err?.stack || err);
  if (_shuttingDown) return;
  _shuttingDown = true;
  _stopChildren();   // don't orphan the GPU/worker children when we die
  setTimeout(() => process.exit(1), 500).unref();
});

// ── Commands ──────────────────────────────────────────────────────────────────

const command = process.argv[2] ?? 'start';

if (command === 'setup') {
  runSetup();
} else if (command === 'status') {
  runStatus();
} else if (command === 'stop') {
  runStop();
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
  console.error('Usage: node node-client.js [start|stop|setup|status|update|rollback <version>|deregister]');
  console.error('  start                 run the node (default)');
  console.error('  stop [--force]        stop the running node (graceful; --force = SIGKILL)');
  console.error('  status                print node status');
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

  // Refuse to start a second copy in the same directory — a stray duplicate double-registers
  // on the network and fights over the API port. A stale PID file (process already gone) is fine.
  const existing = readPidFile();
  if (existing && existing !== process.pid && pidAlive(existing)) {
    console.error(`[node-client] A node already appears to be running here (pid ${existing}).`);
    console.error(`[node-client] Stop it first:  node node-client.js stop   (or force: kill ${existing})`);
    process.exit(1);
  }
  writePidFile();
  process.on('exit', clearOwnPidFile);   // covers every exit path (shutdown, watchdog, uncaught)

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

  // 7. Start LLM worker sidecar if enabled
  if (config.llmWorker?.enabled) {
    llmWorker.start({ ...config.llmWorker, nodeApiPort: config.node?.apiPort ?? 19000 });
    console.log(`[node-client] ✓ LLM worker starting on port ${config.llmWorker.port ?? 19110}`);
  }

  // 7b. Start CPU agent-cloud host if the operator connected it (persisted from the dashboard).
  if (config.agentCloud?.enabled) {
    const cpuHost = require('./lib/cpu-host');
    const r = cpuHost.start(config, config.agentCloud);
    if (r.ok) console.log(`[node-client] ✓ CPU host starting (budget: ${config.agentCloud.maxAgents ?? '?'} agents)`);
    else      console.log(`[node-client] ! CPU host not started: ${r.error} (run setup from the dashboard cloud tab)`);
  }

  console.log('');
  const port = config.node.apiPort;
  console.log(`[node-client] ✓ Node running`);
  console.log(`[node-client] ✓ Dashboard: http://localhost:${port}/`);
  console.log(`[node-client] ✓ Local API: http://localhost:${port}/api/...`);
  console.log(`[node-client] ✓ Health:    http://localhost:${port}/health`);
  console.log(`[node-client] ✓ Admin token: ${server.adminToken()}`);
  console.log(`[node-client]   (only needed to MANAGE the node from a non-localhost browser — localhost & SSH tunnels are trusted)`);
  if (config.node?.agentDataPath) {
    console.log(`[node-client] ✓ Chat:      ws://localhost:${port}/chat  (agent connected)`);
  } else {
    console.log(`[node-client] ✓ Chat:      ws://localhost:${port}/chat  (set agentDataPath to enable)`);
  }
  if (config.llmWorker?.enabled) {
    console.log(`[node-client] ✓ LLM worker: TCP port ${config.llmWorker.port ?? 19110}  →  ${config.llmWorker.coordinatorUrl ?? 'coordinator'}`);
  }
  console.log('');

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  async function shutdown(signal) {
    if (_shuttingDown) return;   // ignore a second SIGINT/SIGTERM (or SIGINT-then-SIGTERM under systemd)
    _shuttingDown = true;
    console.log(`\n[node-client] ${signal} received — shutting down gracefully`);
    // Hard watchdog: always exit even if deregister hangs on a slow/dead registry,
    // so systemd doesn't have to SIGKILL us mid-write.
    const watchdog = setTimeout(() => {
      console.warn('[node-client] shutdown watchdog fired — forcing exit');
      process.exit(0);
    }, 6_000);
    watchdog.unref();
    _stopChildren();
    try { await registry.deregister(config); }
    catch (err) { console.warn('[node-client] deregister failed:', err.message); }
    clearTimeout(watchdog);
    console.log('[node-client] Goodbye.');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

// ── Stop a running node ─────────────────────────────────────────────────────
// Reads data/node.pid and sends SIGTERM (the same graceful-shutdown path as Ctrl+C:
// deregister from the network, then exit). Falls back to clear guidance if there is
// no PID file — e.g. the node is managed by PM2 or systemd, which own the process.
async function runStop() {
  const force = process.argv.includes('--force') || process.argv.includes('-9');
  const pid = readPidFile();

  if (!pid) {
    console.error('[node-client] No PID file (data/node.pid) — no node started from this directory, or it exited uncleanly.');
    console.error('[node-client] If it is managed elsewhere:');
    console.error('[node-client]   PM2:      pm2 stop <name>');
    console.error('[node-client]   systemd:  sudo systemctl stop circuit-node-client');
    console.error('[node-client]   manual:   pkill -f node-client.js   (Windows: taskkill /IM node.exe /F)');
    process.exit(1);
  }
  if (!pidAlive(pid)) {
    console.log(`[node-client] No process ${pid} running — clearing stale PID file.`);
    clearOwnPidFileFor(pid);
    process.exit(0);
  }

  const sig = force ? 'SIGKILL' : 'SIGTERM';
  console.log(`[node-client] Stopping node (pid ${pid}) with ${sig}…`);
  try { process.kill(pid, sig); }
  catch (err) {
    console.error(`[node-client] Could not signal ${pid}: ${err.message}`);
    console.error(`[node-client] Try:  kill ${force ? '-9 ' : ''}${pid}`);
    process.exit(1);
  }
  if (force) { console.log('[node-client] SIGKILL sent.'); clearOwnPidFileFor(pid); process.exit(0); }

  // Poll up to ~10s for a clean exit; the node's own shutdown watchdog exits within ~6s.
  const deadline = Date.now() + 10_000;
  const poll = () => {
    if (!pidAlive(pid)) { console.log('[node-client] Stopped.'); clearOwnPidFileFor(pid); process.exit(0); }
    if (Date.now() > deadline) {
      console.warn(`[node-client] Still running after 10s. Force-kill with:  node node-client.js stop --force  (or kill -9 ${pid})`);
      process.exit(1);
    }
    setTimeout(poll, 250);
  };
  poll();
}
// Clear PID_FILE only if it names `pid` (avoid racing a freshly-started instance).
function clearOwnPidFileFor(pid) {
  try { if (readPidFile() === pid) fs.unlinkSync(PID_FILE); } catch {}
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
  // Quick "is this port bindable right now?" probe so the operator doesn't pick a port
  // the node will fail to bind at start (with a much more cryptic EADDRINUSE).
  const net = require('net');
  const portFree = (p) => new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(p, '0.0.0.0');
  });

  console.log(`  ${B('API Port')}  ${D('(dashboard + local API, default 19000)')}`);
  console.log(`  ${D('current:')}  ${Y(config.node?.apiPort ?? 19000)}`);
  const curPort = config.node?.apiPort ?? 19000;
  let apiPort = curPort;
  while (true) {
    const portAns = (await ask('  Port (Enter to keep): ')).trim();
    if (!portAns) { apiPort = curPort; break; }
    const n = parseInt(portAns, 10);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      console.log(`  ${Y('⚠')} Enter a port between 1024 and 65535.`);
      continue;
    }
    if (n !== curPort && !(await portFree(n))) {
      console.log(`  ${Y('⚠')} Port ${n} is already in use — pick another.`);
      continue;
    }
    apiPort = n;
    break;
  }
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
  console.log(`Admin token: ${server.adminToken()}  (for non-localhost dashboard management)`);

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
