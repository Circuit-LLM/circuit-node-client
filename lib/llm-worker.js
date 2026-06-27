// lib/llm-worker.js — engine-worker supervisor for circuit-node-client.
//
// The node-client is the operator's LOCAL agent. On a GPU box it launches and
// supervises the Python inference engine's stage worker (engine.stage_worker) as a
// child process — the worker holds a slice of the model's layers and serves the
// coordinator. The node-client never does the GPU math itself; it just manages the
// worker's lifecycle (start, crash-restart, status, stop) and reports up.
//
// We launch the engine's own bringup script (deploy/run-stage1.sh) rather than
// re-implementing model provisioning in Node: that script stages the model to RAM
// (stage-model.sh, self-provisioning from HF onto this node's own volume), sets the
// offline/HF env, and `exec`s into `python3 -m engine.stage_worker`. Because of the
// exec, the child we supervise *becomes* the Python worker (same PID).
//
// Config (config/client.json → llmWorker):
//   enabled       — false by default; true to run a GPU compute node
//   engineDir     — where the baked engine lives (default $CIRCUIT_ENGINE_DIR or /opt/circuit-engine)
//   runScript     — role bringup script under engineDir (default deploy/run-stage1.sh)
//   clusterKey    — ChaCha20 wire key, passed to the worker as CIRCUIT_KEY
//   payoutWallet  — Solana wallet earnings settle to (Phase 3+; passed through env)
//   requireGpu    — if true (default), a box with no GPU does NOT start the worker
//
// Static vs mesh: Phase 1 launches the static stage worker (run-stage1.sh wires its
// own --layers). Phase 2 swaps in a mesh bringup that registers with the coordinator
// for a dynamic slot — same supervisor, different runScript + env.
'use strict';

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const RESTART_DELAY  = 10_000; // wait before restart after a crash
const MAX_RESTARTS   = 10;     // consecutive-crash backstop
const STATUS_REFRESH = 5_000;  // worker state-file poll interval

let _proc        = null;
let _config      = null;
let _restarts    = 0;
let _stopping    = false;
let _statusTimer = null;
let _state       = { running: false };

// ── GPU detection ───────────────────────────────────────────────────────────
// True if an NVIDIA GPU is present. Used to decide whether this box runs a
// compute worker at all (GPU) or stays a light presence node (CPU).
function hasGpu() {
  try {
    const out = execFileSync('nvidia-smi', ['-L'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    return /\bGPU\s+0\b/.test(out) || out.split('\n').some(l => l.startsWith('GPU '));
  } catch {
    return false; // nvidia-smi missing or no driver → treat as CPU box
  }
}

function _engineDir(cfg) {
  const c = cfg || _config || {};
  return c.engineDir || process.env.CIRCUIT_ENGINE_DIR || '/opt/circuit-engine';
}

// ── GPU info (for the connect UI) ─────────────────────────────────────────────
// Name + total VRAM (MB) of GPU 0, or null on a CPU box.
function gpuInfo() {
  try {
    const out = execFileSync('nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const [name, vramMb] = out.split('\n')[0].split(',').map(s => s.trim());
    return { name, vramMb: parseInt(vramMb, 10) || 0 };
  } catch { return null; }
}

// Is the engine (the run script) present, so a Connect can actually start a worker?
function enginePresent(cfg) {
  const runScript = path.join(_engineDir(cfg), (cfg && cfg.runScript) || 'deploy/run-mesh.sh');
  try { return fs.existsSync(runScript); } catch { return false; }
}

// Machine-scaled GPU presets → capacity-layers, from VRAM. The 72B-AWQ 4-bit slice is
// ≈0.5 GB/layer + ~2 GB overhead; Light/Balanced/Max take a growing share of what fits.
function presets(vramMb) {
  const vramGb = (vramMb || 0) / 1024;
  const cap = Math.min(80, Math.max(4, Math.floor((vramGb - 2) / 0.5))); // layers this VRAM holds (model = 80)
  const light    = Math.min(cap, Math.max(4, Math.round(cap * 0.33)));
  const balanced = Math.min(cap, Math.max(light, Math.round(cap * 0.66)));
  return { light, balanced, max: cap, fit: cap };
}

// ── Start ─────────────────────────────────────────────────────────────────────
function start(llmConfig) {
  if (_proc) return;
  _config   = llmConfig || {};
  _stopping = false;
  _restarts = 0;

  const requireGpu = _config.requireGpu !== false; // default true
  if (requireGpu && !hasGpu()) {
    console.log('[engine-worker] no GPU detected — staying a light presence node (no compute worker)');
    _state = { running: false, role: 'presence', reason: 'no-gpu' };
    return;
  }
  _spawn();
}

// ── Stop ──────────────────────────────────────────────────────────────────────
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

// ── Status ────────────────────────────────────────────────────────────────────
function status() {
  return { ..._state };
}

// ── Internal ──────────────────────────────────────────────────────────────────
function _spawn() {
  if (_stopping) return;

  const engineDir = _engineDir();
  const runScript = path.join(engineDir, _config.runScript || 'deploy/run-stage1.sh');
  if (!fs.existsSync(runScript)) {
    console.error('[engine-worker] run script not found at', runScript, '— is the engine baked / CIRCUIT_ENGINE_DIR set?');
    _state = { running: false, error: 'run-script-missing', runScript };
    return;
  }

  // The run script reads these from the env; supervisor owns them (no shared files).
  const env = {
    ...process.env,
    CIRCUIT_ENGINE_DIR: engineDir,
  };
  if (_config.clusterKey)   env.CIRCUIT_KEY      = _config.clusterKey;
  if (_config.payoutWallet) env.CIRCUIT_PAYOUT_WALLET = _config.payoutWallet;
  // GPU contribution size: how many model layers this GPU will hold. run-mesh.sh reads
  // CIRCUIT_CAPACITY_LAYERS and the coordinator assigns a slice up to it. More layers =
  // more VRAM + more of the model served + more earnings.
  if (_config.capacityLayers) env.CIRCUIT_CAPACITY_LAYERS = String(_config.capacityLayers);

  _proc = spawn('bash', [runScript], { cwd: engineDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  _state = { running: true, role: 'gpu-worker', pid: _proc.pid, restarts: _restarts, runScript };
  console.log(`[engine-worker] started (pid ${_proc.pid}) ${runScript}`);

  _proc.stdout.on('data', d => process.stdout.write('[engine-worker] ' + d));
  _proc.stderr.on('data', d => process.stderr.write('[engine-worker] ' + d));

  _proc.on('exit', (code, sig) => {
    _proc  = null;
    _state = { running: false, lastExitCode: code, lastSignal: sig, restarts: _restarts };
    if (_stopping) return;

    _restarts++;
    if (_restarts > MAX_RESTARTS) {
      console.error(`[engine-worker] crashed ${_restarts} times — giving up`);
      return;
    }
    console.warn(`[engine-worker] exited (code=${code} sig=${sig}) — restarting in ${RESTART_DELAY}ms (attempt ${_restarts}/${MAX_RESTARTS})`);
    setTimeout(_spawn, RESTART_DELAY).unref();
  });

  if (_statusTimer) clearInterval(_statusTimer);
  _statusTimer = setInterval(_readState, STATUS_REFRESH).unref();
}

function _readState() {
  if (!_proc) return;
  const stateFile = path.join(_engineDir(), 'data', 'worker_state.json');
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    _state = { running: true, role: 'gpu-worker', pid: _proc?.pid, restarts: _restarts, ...s };
  } catch { /* worker may not write a state file; keep last known */ }
}

module.exports = { start, stop, status, hasGpu, gpuInfo, enginePresent, presets };
