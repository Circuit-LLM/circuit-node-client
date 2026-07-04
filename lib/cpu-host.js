// lib/cpu-host.js — agent-cloud node-host supervisor for circuit-node-client.
//
// The CPU counterpart to lib/llm-worker.js. On a CPU box the node-client can lend
// spare capacity to the Circuit *agent cloud* — running OTHER users' autonomous
// agents under a strict, operator-declared budget. This module launches and
// supervises the circuit-agent-cloud node-host (node-host/host.js) as a child
// process and reports its lifecycle (start, crash-restart, status, stop).
//
// Safety: the node-host NEVER holds an agent's signing key — those stay off-box in
// the signer; this machine only runs the agents' program (their automation logic, not
// AI inference) under a CPU/RAM budget.
//
// Resource budget (passed to the node-host as env):
//   MAX_AGENTS     how many agents this box will host at once
//   MAX_CPU        total CPU cores to lend (fractional ok)
//   MAX_MEMORY_MB  per-agent RAM cap (cgroup-enforced where available)
'use strict';

const { spawn } = require('child_process');
const os   = require('os');
const path = require('path');
const fs   = require('fs');

const RESTART_DELAY  = 10_000;
const MAX_RESTARTS   = 10;
const STATUS_REFRESH = 5_000;

// Where an outside box joins by default. The node-host authenticates with its OWN ed25519
// identity (auto-created at ~/.circuit-host/node.key) — no shared admin secret is needed to
// join, so a one-click Connect works with zero configuration.
const DEFAULT_CONTROL_PLANE = 'https://agents.circuitllm.xyz';

// The id the node-host registers under (mirrors node-host/host.js: node-<hostname>), surfaced
// in status so the dashboard can show "hosting as node-X".
function defaultNodeId() { return process.env.NODE_ID || `node-${os.hostname()}`; }

let _proc        = null;
let _config      = null;
let _restarts    = 0;
let _stopping    = false;
let _statusTimer = null;
let _state       = { running: false };
let _hostDir     = null; // resolved node-host data dir (status.json + node.key live here)

// The node-host's data dir — must agree across the spawn (HOST_DATA_DIR), the status.json
// cleanup on stop, and the dashboard's status reader (lib/agent-cloud.js). All default to
// ~/.circuit-host; an explicit config/env override is honoured by all three.
function hostDir(config = {}) {
  const ac = config.agentCloud || config.node?.agentCloud || {};
  return ac.hostDir || process.env.HOST_DATA_DIR || path.join(os.homedir(), '.circuit-host');
}

// ── Locate the node-host code ─────────────────────────────────────────────────
// Order: explicit config → bundled copy next to the node-client → a sibling
// circuit-agent-cloud checkout → the operator's home. Returns the host.js path or null.
// True when running as the bun-COMPILED sidecar: process.execPath is the circuit-node binary
// (not node/bun), so the node-host is folded IN and launched via `<self> host`, no script on disk.
function _compiled() {
  return !/^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath));
}

function hostScriptPath(config = {}) {
  const ac = config.agentCloud || config.node?.agentCloud || {};
  const candidates = [
    ac.hostScript,
    process.env.CIRCUIT_NODE_HOST_SCRIPT,
    path.join(__dirname, '..', 'vendor', 'agent-cloud', 'node-host', 'host.js'), // folded-in (dev, under node)
    path.join(__dirname, '..', 'vendor', 'node-host', 'host.js'),                // legacy vendor location
    path.join(__dirname, '..', '..', 'circuit-agent-cloud', 'node-host', 'host.js'),
    path.join(os.homedir(), 'circuit-agent-cloud', 'node-host', 'host.js'),
  ].filter(Boolean);
  return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// Present if the compiled binary has it folded in, OR a host.js is on disk (dev/prod under node).
function hostPresent(config = {}) {
  return _compiled() || !!hostScriptPath(config);
}

// ── Machine-scaled resource presets ───────────────────────────────────────────
// Light / Balanced / Max as fractions of THIS machine, so a click does the right
// thing on a 4-core laptop or a 64-core server. Advanced mode overrides any field.
function presets() {
  const cores = Math.max(1, os.cpus().length);
  const ramMb = Math.floor(os.totalmem() / (1024 * 1024));
  const clampCpu = f => Math.max(1, Math.floor(cores * f));
  // per-agent RAM cap stays modest; total exposure ≈ maxAgents × maxMemoryMb.
  return {
    light:    { maxCpu: clampCpu(0.25), maxAgents: 2,  maxMemoryMb: 512 },
    balanced: { maxCpu: clampCpu(0.50), maxAgents: 5,  maxMemoryMb: 512 },
    max:      { maxCpu: clampCpu(0.75), maxAgents: Math.min(20, Math.max(8, clampCpu(0.75) * 3)), maxMemoryMb: 768 },
    machine:  { cores, ramMb },
  };
}

function resolveBudget(spec = {}) {
  const p = presets();
  const base = p[spec.preset] || p.balanced;
  return {
    maxAgents:    Math.max(1, Number(spec.maxAgents    ?? base.maxAgents)),
    maxCpu:       Math.max(0.5, Number(spec.maxCpu     ?? base.maxCpu)),
    maxMemoryMb:  Math.max(256, Number(spec.maxMemoryMb ?? base.maxMemoryMb)),
  };
}

// ── Start ─────────────────────────────────────────────────────────────────────
function start(config, spec = {}) {
  if (_proc) return { ok: true, already: true, status: status() };
  const script = hostScriptPath(config);        // may be null when running as the compiled binary
  if (!script && !_compiled()) {
    _state = { running: false, role: 'cpu-host', error: 'node-host-missing' };
    return { ok: false, error: 'node-host-missing' };
  }
  _config   = { config, spec, script };
  _hostDir  = hostDir(config);
  _stopping = false;
  _restarts = 0;
  _spawn();
  return { ok: true, status: status() };
}

function stop() {
  _stopping = true;
  if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; }
  if (_proc) {
    _proc.kill('SIGTERM');
    setTimeout(() => { if (_proc) _proc.kill('SIGKILL'); }, 8_000).unref();
    _proc = null;
  }
  // Drop the node-host's last snapshot so the dashboard flips to "not hosting" immediately
  // instead of waiting ~30s for it to age out (best-effort; uses the dir we spawned with).
  try { fs.unlinkSync(path.join(_hostDir || hostDir(), 'status.json')); } catch {}
  _state = { running: false };
}

function status() { return { ..._state }; }

// ── Internal ──────────────────────────────────────────────────────────────────
function _spawn() {
  if (_stopping) return;
  const { config, spec, script } = _config;
  const ac = config.agentCloud || config.node?.agentCloud || {};
  const budget = resolveBudget(spec);

  const env = {
    ...process.env,
    MAX_AGENTS:    String(budget.maxAgents),
    MAX_CPU:       String(budget.maxCpu),
    MAX_MEMORY_MB: String(budget.maxMemoryMb),
    HOST_DATA_DIR: _hostDir, // pin it so stop()'s cleanup + the dashboard reader use the same dir
  };
  // Cloud wiring. The node-host reads CONTROL_PLANE (NOT CIRCUIT_CONTROL_PLANE) — set both so the
  // host connects and the status reader agrees. Defaults to the public control plane so a click works
  // with no config. cloudKey is optional (node-auth is sufficient to join); only forwarded if set.
  const cp = ac.controlPlane || process.env.CIRCUIT_CONTROL_PLANE || DEFAULT_CONTROL_PLANE;
  env.CONTROL_PLANE         = cp;
  env.CIRCUIT_CONTROL_PLANE = cp;
  if (ac.cloudKey)              env.CIRCUIT_CLOUD_KEY      = ac.cloudKey;
  if (spec.payoutWallet || ac.payoutWallet) env.CIRCUIT_PAYOUT_WALLET = spec.payoutWallet || ac.payoutWallet;
  // First-party trusted workloads under the 'node' runtime — no Docker, the same model as the
  // production node-host (run-node-host.sh sets SANDBOX=node). Untrusted 3rd-party bundles (which
  // would need Docker/oci) aren't hosted here; the node advertises it can't sandbox those.
  if (!env.SANDBOX) env.SANDBOX = 'node';

  // Compiled sidecar: re-exec THIS binary as `host`; the folded-in host re-execs `<self> agentd`
  // per workload (CIRCUIT_SELF_EXEC). Under a real node (dev/prod): spawn `node <host.js>` as before.
  const compiled = _compiled();
  const command  = compiled ? process.execPath : 'node';
  const args     = compiled ? ['host'] : [script];
  const cwd      = script ? path.dirname(script) : os.homedir();
  if (compiled) env.CIRCUIT_SELF_EXEC = '1';

  _proc = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  _state = { running: true, role: 'cpu-host', pid: _proc.pid, restarts: _restarts, budget, script: script || `${path.basename(process.execPath)} host`, controlPlane: cp, nodeId: defaultNodeId() };
  console.log(`[cpu-host] started (pid ${_proc.pid}) ${compiled ? command + ' host' : script} — budget ${budget.maxAgents} agents / ${budget.maxCpu} cores / ${budget.maxMemoryMb}MB-per-agent`);

  _proc.stdout.on('data', d => process.stdout.write('[cpu-host] ' + d));
  _proc.stderr.on('data', d => process.stderr.write('[cpu-host] ' + d));

  _proc.on('exit', (code, sig) => {
    _proc  = null;
    _state = { running: false, role: 'cpu-host', lastExitCode: code, lastSignal: sig, restarts: _restarts };
    if (_stopping) {
      // The host re-writes a "drained" status.json in its SIGTERM handler, so remove it only now
      // (after it has fully exited) — otherwise the dashboard sees a fresh snapshot and stays "hosting".
      try { fs.unlinkSync(path.join(_hostDir || hostDir(), 'status.json')); } catch {}
      return;
    }
    _restarts++;
    if (_restarts > MAX_RESTARTS) { console.error(`[cpu-host] crashed ${_restarts} times — giving up`); return; }
    console.warn(`[cpu-host] exited (code=${code} sig=${sig}) — restarting in ${RESTART_DELAY}ms (${_restarts}/${MAX_RESTARTS})`);
    setTimeout(_spawn, RESTART_DELAY).unref();
  });

  if (_statusTimer) clearInterval(_statusTimer);
  _statusTimer = setInterval(_keepalive, STATUS_REFRESH).unref();
}

function _keepalive() {
  if (_proc) _state.running = true;
}

module.exports = { start, stop, status, hostPresent, hostScriptPath, presets, resolveBudget };
