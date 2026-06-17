// lib/llm-worker.js — LLM worker sidecar for circuit-node-client.
//
// When config.llmWorker.enabled = true, the node-client spawns worker.js
// as a child process. The worker self-registers with the coordinator, receives
// a transformer layer shard, and participates in distributed LLM inference.
//
// Config (config/client.json → llmWorker):
//   enabled        — false by default; set true to join the inference network
//   port           — TCP port for the tensor pipeline (coordinator connects here)
//   coordinatorUrl — HTTP URL of the circuit-decentralized-llm coordinator
//   clusterKey     — shared secret for coordinator auth (leave blank for open clusters)
//   walletAddress  — Solana wallet for CIRC payment attribution (optional)
//
// The worker process is self-contained (worker.js). This module only manages
// its lifecycle: start, stop, crash-restart, and status reporting.
'use strict';

const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');

const WORKER_SCRIPT  = path.join(__dirname, '..', 'worker.js');
const RESTART_DELAY  = 5_000;  // 5s before restart after crash
const MAX_RESTARTS   = 10;     // give up after 10 consecutive crashes
const STATUS_REFRESH = 5_000;  // how often to re-read worker state file

let _proc        = null;
let _config      = null;
let _restarts    = 0;
let _stopping    = false;
let _statusTimer = null;
let _state       = { running: false };

// ── Start ─────────────────────────────────────────────────────────────────────
function start(llmConfig) {
  if (_proc) return;
  _config   = llmConfig;
  _stopping = false;
  _restarts = 0;
  _spawn();
}

// ── Stop ──────────────────────────────────────────────────────────────────────
function stop() {
  _stopping = true;
  if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; }
  if (_proc) {
    _proc.kill('SIGTERM');
    // Force kill after 8s if it doesn't exit cleanly
    setTimeout(() => { if (_proc) _proc.kill('SIGKILL'); }, 8_000).unref();
    _proc  = null;
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
  if (!fs.existsSync(WORKER_SCRIPT)) {
    console.error('[llm-worker] worker.js not found at', WORKER_SCRIPT, '— skipping LLM worker start');
    return;
  }

  const port   = _config.port           ?? 19110;
  const coord  = _config.coordinatorUrl ?? 'http://localhost:19200';
  const key    = _config.clusterKey     ?? '';
  const wallet = _config.walletAddress  ?? null;

  const args = ['--port', String(port), '--coordinator', _urlHost(coord)];
  if (key)    args.push('--key',    key);
  if (wallet) args.push('--wallet', wallet);

  const env = {
    ...process.env,
    WORKER_PORT:      String(port),
    COORDINATOR_HOST: _urlHost(coord),
    LLM_PORT:         String(_urlPort(coord)),
    COORDINATOR_URL:  coord,
    CLUSTER_KEY:      key,
    NODE_API_PORT:    String(_config.nodeApiPort ?? 19000),
  };

  _proc = spawn(process.execPath, [WORKER_SCRIPT, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  _state = { running: true, port, pid: _proc.pid, restarts: _restarts, assignment: null };
  console.log(`[llm-worker] started (pid ${_proc.pid}) port=${port} coordinator=${coord}`);

  // Pipe worker stdout/stderr with prefix
  _proc.stdout.on('data', d => process.stdout.write('[llm-worker] ' + d));
  _proc.stderr.on('data', d => process.stderr.write('[llm-worker] ' + d));

  _proc.on('exit', (code, sig) => {
    _proc  = null;
    _state = { running: false, port, lastExitCode: code, lastSignal: sig, restarts: _restarts };
    if (_stopping) return;

    _restarts++;
    if (_restarts > MAX_RESTARTS) {
      console.error(`[llm-worker] crashed ${_restarts} times — giving up`);
      return;
    }

    console.warn(`[llm-worker] exited (code=${code} sig=${sig}) — restarting in ${RESTART_DELAY}ms (attempt ${_restarts}/${MAX_RESTARTS})`);
    setTimeout(_spawn, RESTART_DELAY).unref();
  });

  // Poll the worker's state file for assignment info
  if (_statusTimer) clearInterval(_statusTimer);
  _statusTimer = setInterval(_readState, STATUS_REFRESH).unref();
}

function _readState() {
  if (!_proc) return;
  const stateFile = path.join(__dirname, '..', 'data', 'worker_state.json');
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const s   = JSON.parse(raw);
    _state = { running: true, pid: _proc?.pid, restarts: _restarts, ...s };
  } catch {}
}

// Extract host from a URL string (e.g. "http://localhost:19200" → "localhost")
function _urlHost(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

// Extract port from a URL string (e.g. "http://localhost:19200" → "19200")
function _urlPort(url) {
  try { return new URL(url).port || '19200'; } catch { return '19200'; }
}

module.exports = { start, stop, status };
