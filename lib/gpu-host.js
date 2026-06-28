// lib/gpu-host.js — supervise the GPU node DOCKER container (circuit-gpu-node) from the dashboard.
//
// The GPU node isn't a child process like the CPU agent-host; it's a self-contained Docker container
// the `curl join | bash` installer started (usually inside WSL on a Windows box). So we don't spawn it
// — we drive `docker start/stop/logs` against it. The dashboard then shows status + Start/Stop without
// the operator touching a terminal.
//
// Reaching docker: the node-client may run on Windows (docker lives in WSL → `wsl docker …`) or on
// Linux/WSL directly (`docker …`). We auto-detect which works. If neither does (e.g. the dashboard
// runs somewhere that can't reach the daemon), the routes report dockerReachable:false and the UI
// shows the equivalent commands instead of buttons.
'use strict';

const { execFile, execFileSync } = require('child_process');

const CONTAINER = process.env.CIRCUIT_GPU_CONTAINER || 'circuit-gpu-node';
let _docker; // cached detection: string[] base argv (e.g. ['docker'] or ['wsl','docker']) or null

// Find a working way to reach the docker daemon. `info` (not `version`) so we require a live daemon.
function _detect() {
  if (_docker !== undefined) return _docker;
  for (const base of [['docker'], ['wsl', 'docker']]) {
    try { execFileSync(base[0], [...base.slice(1), 'info'], { stdio: 'ignore', timeout: 6000 }); _docker = base; return base; }
    catch { /* try next */ }
  }
  _docker = null;
  return null;
}
// Re-probe (e.g. after the operator starts Docker Desktop). Cheap; called by /gpu/status.
function _redetect() { _docker = undefined; return _detect(); }

function _runSync(args, { timeout = 15000 } = {}) {
  const d = _detect();
  if (!d) { const e = new Error('docker-unreachable'); e.code = 'docker-unreachable'; throw e; }
  return execFileSync(d[0], [...d.slice(1), ...args], { encoding: 'utf8', timeout });
}

// The literal command an operator would type, for the UI's copy/fallback (matches our detection).
function cmd(action) {
  const base = (_detect() || ['wsl', 'docker']).join(' '); // default to the Windows form in the hint
  switch (action) {
    case 'logs':  return `${base} logs -f ${CONTAINER}`;
    case 'stop':  return `${base} stop ${CONTAINER}`;
    case 'start': return `${base} start ${CONTAINER}`;
    case 'status':return `${base} ps -a --filter name=${CONTAINER}`;
    case 'remove':return `${base} rm -f ${CONTAINER}`;
    default:      return `${base} ${action} ${CONTAINER}`;
  }
}

function status() {
  _redetect();
  const d = _detect();
  if (!d) return { dockerReachable: false, container: CONTAINER, how: _docker, cmds: _cmdSet() };
  try {
    // present? running? — one ps call, stable machine-readable format.
    const out = _runSync(['ps', '-a', '--filter', `name=^/${CONTAINER}$`, '--format', '{{.State}}|{{.Status}}']).trim();
    if (!out) return { dockerReachable: true, present: false, container: CONTAINER, via: d.join(' ') };
    const [state, statusLine] = out.split('|');
    return { dockerReachable: true, present: true, running: state === 'running', state, statusLine, container: CONTAINER, via: d.join(' ') };
  } catch (e) {
    return { dockerReachable: true, error: e.message, container: CONTAINER, via: d.join(' ') };
  }
}

function start() { _runSync(['start', CONTAINER]); return status(); }
function stop()  { _runSync(['stop', CONTAINER], { timeout: 30000 }); return status(); }

// Recent logs (best-effort, capped). docker writes container stdout+stderr; capture both.
function logs(tail = 80) {
  return new Promise((resolve) => {
    const d = _detect();
    if (!d) return resolve({ ok: false, error: 'docker-unreachable', cmd: cmd('logs') });
    execFile(d[0], [...d.slice(1), 'logs', '--tail', String(Math.min(500, Math.max(1, tail))), CONTAINER],
      { timeout: 8000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, text: ((stdout || '') + (stderr || '')).slice(-20000), cmd: cmd('logs') }));
  });
}

function _cmdSet() {
  return { logs: cmd('logs'), start: cmd('start'), stop: cmd('stop'), status: cmd('status'), remove: cmd('remove') };
}

module.exports = { status, start, stop, logs, cmd, cmds: _cmdSet, CONTAINER };
