// lib/cpu-host.js — agent-cloud node-host supervisor for circuit-node-client.
//
// The CPU counterpart to lib/llm-worker.js. On a CPU box the node-client can lend
// spare capacity to the Circuit *agent cloud* — running OTHER users' autonomous
// agents under a strict, operator-declared budget. This module launches and
// supervises the circuit-agent-cloud node-host (node-host/host.js) as a child
// process and reports its lifecycle (start, crash-restart, status, stop).
//
// Safety: the node-host NEVER holds an agent's signing key — those stay off-box in
// the signer; this machine only runs the agents' compute under a CPU/RAM budget.
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

let _proc        = null;
let _config      = null;
let _restarts    = 0;
let _stopping    = false;
let _statusTimer = null;
let _state       = { running: false };

// ── Locate the node-host code ─────────────────────────────────────────────────
// Order: explicit config → bundled copy next to the node-client → a sibling
// circuit-agent-cloud checkout → the operator's home. Returns the host.js path or null.
function hostScriptPath(config = {}) {
  const ac = config.agentCloud || config.node?.agentCloud || {};
  const candidates = [
    ac.hostScript,
    process.env.CIRCUIT_NODE_HOST_SCRIPT,
    path.join(__dirname, '..', 'vendor', 'node-host', 'host.js'),
    path.join(__dirname, '..', '..', 'circuit-agent-cloud', 'node-host', 'host.js'),
    path.join(os.homedir(), 'circuit-agent-cloud', 'node-host', 'host.js'),
  ].filter(Boolean);
  return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// Is the node-host code present on this box (so a Connect can actually start it)?
function hostPresent(config = {}) {
  return !!hostScriptPath(config);
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
  const script = hostScriptPath(config);
  if (!script) {
    _state = { running: false, role: 'cpu-host', error: 'node-host-missing' };
    return { ok: false, error: 'node-host-missing' };
  }
  _config   = { config, spec, script };
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
  };
  // Cloud wiring (best-effort — the node-host degrades/retries on its own).
  const cp = ac.controlPlane || process.env.CIRCUIT_CONTROL_PLANE;
  if (cp)                       env.CIRCUIT_CONTROL_PLANE = cp;
  if (ac.cloudKey)              env.CIRCUIT_CLOUD_KEY      = ac.cloudKey;
  if (spec.payoutWallet || ac.payoutWallet) env.CIRCUIT_PAYOUT_WALLET = spec.payoutWallet || ac.payoutWallet;

  _proc = spawn('node', [script], { cwd: path.dirname(script), env, stdio: ['ignore', 'pipe', 'pipe'] });
  _state = { running: true, role: 'cpu-host', pid: _proc.pid, restarts: _restarts, budget, script };
  console.log(`[cpu-host] started (pid ${_proc.pid}) ${script} — budget ${budget.maxAgents} agents / ${budget.maxCpu} cores / ${budget.maxMemoryMb}MB-per-agent`);

  _proc.stdout.on('data', d => process.stdout.write('[cpu-host] ' + d));
  _proc.stderr.on('data', d => process.stderr.write('[cpu-host] ' + d));

  _proc.on('exit', (code, sig) => {
    _proc  = null;
    _state = { running: false, role: 'cpu-host', lastExitCode: code, lastSignal: sig, restarts: _restarts };
    if (_stopping) return;
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
