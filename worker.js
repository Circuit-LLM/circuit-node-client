'use strict';

const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const http      = require('http');
const https     = require('https');
const crypto    = require('crypto');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');

// Native runner binaries — CUDA version preferred for GPU workers
function _findBin(paths) {
  return paths.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) ?? null;
}

const CUDA_RUNNER_BIN = _findBin([
  process.env.CIRCUIT_RUNNER_CUDA_BIN,
  path.join(__dirname, 'native', 'circuit-runner-cuda'),
].filter(Boolean));

const CPU_RUNNER_BIN = _findBin([
  process.env.CIRCUIT_RUNNER_BIN,
  path.join(__dirname, 'native', 'circuit-runner'),
].filter(Boolean));

// "Is any native runner available" — used to gate _tryInitNative(). The actual
// binary (CPU vs CUDA) is chosen inside NativeRunner based on gpuLayers.
const NATIVE_RUNNER_BIN = CUDA_RUNNER_BIN || CPU_RUNNER_BIN;

// Detect GPU VRAM once at startup (used in HELLO message to coordinator)
const _gpuVramMb = (() => {
  try {
    const out = execFileSync('nvidia-smi',
      ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
      { timeout: 2000, encoding: 'utf8' });
    return parseInt(out.trim(), 10) || 0;
  } catch { return 0; }
})();

function log(level, msg, data) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  process.stdout.write(line + '\n');
}

const argv = process.argv.slice(2);
const CMD  = argv[0];

// ── Status command ─────────────────────────────────────────────────────────────
if (CMD === 'status') {
  const stateFile = path.join(__dirname, 'data', 'worker_state.json');
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    console.log(JSON.stringify(state, null, 2));
  } catch {
    console.log('No worker state found — worker may not be running');
  }
  process.exit(0);
}

// ── Load config ────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config', 'worker.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}

const coordIdx  = argv.indexOf('--coordinator');
const keyIdx    = argv.indexOf('--key');
const walletIdx = argv.indexOf('--wallet');

function _toWsUrl(raw) {
  const s = (raw || '').replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');
  const u = s.startsWith('ws') ? s : 'ws://' + s;
  try { const p = new URL(u); if (p.pathname === '/') p.pathname = '/workers'; return p.toString(); }
  catch { return u.endsWith('/workers') ? u : u + '/workers'; }
}

const coordinatorUrl = _toWsUrl(
  coordIdx >= 0 ? argv[coordIdx + 1] : (cfg.coordinatorUrl ?? cfg.coordinator ?? 'localhost:19200')
);
const clusterKey    = keyIdx   >= 0 ? argv[keyIdx   + 1] : (cfg.clusterKey    ?? '');
const walletAddress = walletIdx >= 0 ? argv[walletIdx+ 1] : (cfg.walletAddress ?? null);

// Qwen2 forward pass (loaded lazily after shard is available)
let Qwen2Worker = null;
try { ({ Qwen2Worker } = require('./lib/inference/qwen2-worker')); } catch {}

// ── Wire protocol (matches lib/pipeline/wire.js) ───────────────────────────────
const MAGIC      = 0xC1CC0001;
const HEADER_LEN = 24;

const MSG = {
  HELLO:        0x00,
  PING:         0x01,
  PONG:         0x02,
  LAYER_ASSIGN: 0x10,
  LAYER_ACK:    0x11,
  TENSOR_FWD:   0x20,
  TENSOR_RET:   0x21,
  WEIGHT_SHARD: 0x30,
  ERROR:        0xFF,
};

function djb2(buf) {
  let h = 5381;
  for (let i = 0; i < buf.length; i++) h = ((h << 5) + h + buf[i]) >>> 0;
  return h;
}

function encode(msgType, payload, seqId = 0, sessionId = 0) {
  const h = Buffer.allocUnsafe(HEADER_LEN);
  h.writeUInt32LE(MAGIC,           0);
  h.writeUInt32LE(msgType,         4);
  h.writeUInt32LE(seqId,           8);
  h.writeUInt32LE(sessionId,      12);
  h.writeUInt32LE(payload.length, 16);
  h.writeUInt32LE(djb2(payload),  20);
  return Buffer.concat([h, payload]);
}

function encodePong(seqId) {
  return encode(MSG.PONG, Buffer.alloc(0), seqId);
}

function encodeLayerAck(seqId, sessionId) {
  return encode(MSG.LAYER_ACK, Buffer.alloc(0), seqId, sessionId);
}

function encodeError(code, message, seqId, sessionId) {
  const payload = Buffer.from(JSON.stringify({ code, message }), 'utf8');
  return encode(MSG.ERROR, payload, seqId, sessionId);
}

function encodeTensorRet(data, shape, dtype, seqId, sessionId) {
  const ndim = shape.length;
  const payload = Buffer.allocUnsafe(4 + 4 + 4 * ndim + data.length);
  let off = 0;
  payload.writeUInt32LE(dtype, off); off += 4;
  payload.writeUInt32LE(ndim,  off); off += 4;
  for (const d of shape) { payload.writeUInt32LE(d, off); off += 4; }
  data.copy(payload, off);
  return encode(MSG.TENSOR_RET, payload, seqId, sessionId);
}

function decodeTensor(payload) {
  let off = 0;
  const dtype = payload.readUInt32LE(off); off += 4;
  const ndim  = payload.readUInt32LE(off); off += 4;
  const shape = [];
  for (let i = 0; i < ndim; i++) { shape.push(payload.readUInt32LE(off)); off += 4; }
  return { dtype, shape, data: payload.slice(off) };
}

// ── State ─────────────────────────────────────────────────────────────────────
let _identity       = null;
let _assignment     = null;
let _ws             = null;
let _seqId          = 0;
let _qwen2          = null;
let _nativeRunner   = null;
let _reconnectDelay = 2_000;
let _reconnectTimer = null;
const stateFile     = path.join(__dirname, 'data', 'worker_state.json');
const PEER_RANGE    = 15_000;

// JS fallback single-session guard (see TENSOR_FWD handler). null = idle.
let _jsActiveSession = null;
let _jsActiveAt      = 0;
const JS_SESSION_IDLE_MS = 120_000;

// Native runner watchdog: kill+recover a subprocess whose head request stalls
// past this (well above the coordinator's 30s tensor timeout).
const NATIVE_WATCHDOG_MS = 120_000;

function _tryInitQwen2() {
  if (_qwen2 || !Qwen2Worker || !_shardTensors) return;
  const a = (_assignment && _assignment.arch) ? _assignment.arch : {};

  const blkLayers = _shardTensors
    .map(t => { const m = (t.name ?? '').match(/^blk\.(\d+)\./); return m ? parseInt(m[1]) : -1; })
    .filter(n => n >= 0);
  if (blkLayers.length === 0) return;

  const shardStart = Math.min(...blkLayers);
  const shardEnd   = Math.max(...blkLayers);

  try {
    _qwen2 = new Qwen2Worker(_shardTensors, {
      hiddenDim:    a.hiddenSize   ?? 896,
      numHeads:     a.numHeads     ?? 14,
      numKvHeads:   a.numKvHeads   ?? 2,
      ffnDim:       a.ffnDim       ?? 4864,
      rmsEps:       a.rmsEps       ?? 1e-6,
      ropeFreqBase: a.ropeFreqBase ?? 1000000,
      layerStart:   shardStart,
      layerEnd:     shardEnd,
      maxSeqLen:    4096,
    });
    log('INFO', 'worker: Qwen2Worker ready', { layers: `${shardStart}-${shardEnd}` });
  } catch (err) {
    log('WARN', 'worker: Qwen2Worker init failed', { error: err.message });
  }
}

// ── Native runner subprocess wrapper ──────────────────────────────────────────
class NativeRunner {
  constructor(shardPath, a, layerStart, layerEnd, modelType) {
    const headDim   = Math.floor((a.hiddenSize ?? 896) / (a.numHeads ?? 14));
    const hasBias   = !['llama3', 'llama-3'].includes(modelType ?? '');
    const gpuLayers = cfg.gpuLayers ?? 0;
    const cudaDev   = cfg.cudaDevice ?? 0;

    // Thread budget for the native runner.
    //  - GPU worker: matmuls run on the GPU, so 2 CPU threads is plenty.
    //  - CPU node clients: they hold only a SMALL shard (1-2 layers) and are
    //    co-located with other services on a shared box; the pipeline is
    //    sequential (one worker computes at a time per request), so default to
    //    1 thread to avoid oversubscribing the host. Override via cfg.threads.
    const threads = gpuLayers > 0 ? 2 : (cfg.threads ?? 2);

    // Pick binary: CUDA runner when gpuLayers > 0 and available, else CPU
    const bin = (gpuLayers > 0 && CUDA_RUNNER_BIN) ? CUDA_RUNNER_BIN : CPU_RUNNER_BIN;
    if (!bin) throw new Error('No native runner binary found (circuit-runner not built)');

    const args = [
      '--shard',       shardPath,
      '--hidden-dim',  String(a.hiddenSize   ?? 896),
      '--n-heads',     String(a.numHeads     ?? 14),
      '--n-kv-heads',  String(a.numKvHeads   ?? 2),
      '--head-dim',    String(headDim),
      '--ffn-dim',     String(a.ffnDim       ?? 4864),
      '--layers',      `${layerStart}:${layerEnd}`,
      '--rope-base',   String(a.ropeFreqBase ?? 10000),
      '--threads',     String(threads),
    ];
    if (hasBias) args.push('--has-bias');
    if (gpuLayers > 0) {
      args.push('--gpu-layers', String(gpuLayers));
      args.push('--cuda-device', String(cudaDev));
    }

    this._hiddenDim = a.hiddenSize ?? 896;
    // FIFO of in-flight forward() promises. The subprocess reads tokens from stdin
    // in order and emits responses in the same order, so responses map to queue
    // entries head-first. A queue (vs a single _pending) keeps the stdout stream
    // aligned if the coordinator ever has more than one tensor outstanding for this
    // worker — e.g. after a tensor timeout + redispatch while the old token is still
    // being computed. The stale (timed-out) response is still consumed in order and
    // returned; the coordinator ignores it via seqId mismatch.
    this._queue = [];
    this._buf   = Buffer.alloc(0);
    this._headStartedAt = 0;  // when the current head request began (0 = idle)

    this._proc = spawn(bin, args);
    this._proc.stderr.on('data', d => log('DEBUG', 'native-runner', { msg: d.toString().trim() }));
    this._proc.stdout.on('data', chunk => {
      this._buf = Buffer.concat([this._buf, chunk]);
      this._tryComplete();
    });
    this._proc.on('exit', code => {
      log('WARN', 'worker: native runner exited', { code });
      if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
      const q = this._queue;
      this._queue = [];
      this._headStartedAt = 0;
      for (const { reject } of q) reject(new Error(`native runner exited with code ${code}`));
    });

    // Watchdog: if the head request hasn't completed within WATCHDOG_MS (well above
    // the coordinator's 30s tensor timeout), the subprocess is wedged. Kill it — the
    // exit handler rejects all queued forwards and PM2 / shard re-push recovers.
    this._watchdog = setInterval(() => {
      if (this._queue.length > 0 && this._headStartedAt > 0
          && Date.now() - this._headStartedAt > NATIVE_WATCHDOG_MS) {
        log('WARN', 'worker: native runner wedged, killing subprocess', {
          queued: this._queue.length, stuckMs: Date.now() - this._headStartedAt,
        });
        try { this._proc.kill('SIGKILL'); } catch {}
      }
    }, 30_000);
    this._watchdog.unref();
    log('INFO', 'worker: native runner spawned', { layers: `${layerStart}-${layerEnd}`, bin, gpuLayers });
  }

  _tryComplete() {
    const needed = 4 + this._hiddenDim * 4;
    // Drain every complete response frame currently buffered, mapping each to the
    // head of the FIFO queue (responses arrive in the same order tokens were sent).
    while (this._queue.length > 0 && this._buf.length >= needed) {
      const outLen = this._buf.readUInt32LE(0);
      const { resolve, reject } = this._queue.shift();
      if (outLen !== this._hiddenDim) {
        // out_len != hiddenDim is the subprocess's error sentinel (e.g. a
        // continuation token whose KV cache was evicted). Fail this forward cleanly.
        this._buf = this._buf.slice(needed);
        reject(new Error(`native runner output size mismatch: ${outLen} != ${this._hiddenDim}`));
        continue;
      }
      // Copy output before advancing buffer (avoid stale ref)
      const result = new Float32Array(this._hiddenDim);
      this._buf.copy(Buffer.from(result.buffer), 0, 4, needed);
      this._buf = this._buf.slice(needed);
      resolve(result);
    }
    // Restart the head clock for whatever is now at the front (or idle).
    this._headStartedAt = this._queue.length > 0 ? Date.now() : 0;
  }

  forward(hidden, pos, sessionId = 0) {
    return new Promise((resolve, reject) => {
      if (!this._proc || !this._proc.stdin.writable) {
        return reject(new Error('native runner not running'));
      }
      // Enqueue before writing so the response (consumed FIFO) maps to this call.
      this._queue.push({ resolve, reject });
      if (this._queue.length === 1) this._headStartedAt = Date.now();  // became head
      // 12-byte header: [4B session_id][4B pos][4B hidden_len].
      // header + hidBuf are written back-to-back synchronously, so concurrent
      // forward() calls never interleave a header with another call's payload.
      const header = Buffer.allocUnsafe(12);
      header.writeUInt32LE(sessionId >>> 0,  0);
      header.writeUInt32LE(pos,              4);
      header.writeUInt32LE(hidden.length,    8);
      const hidBuf = Buffer.from(hidden.buffer, hidden.byteOffset, hidden.byteLength);
      this._proc.stdin.write(header);
      this._proc.stdin.write(hidBuf);
    });
  }

  destroy() {
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
    try { if (this._proc) this._proc.kill('SIGTERM'); } catch {}
    this._proc = null;
  }
}

function _tryInitNative() {
  if (_nativeRunner || !NATIVE_RUNNER_BIN || !_assignment) return;
  const shardPath = _shardCachePath();
  if (!fs.existsSync(shardPath)) return;
  const a = _assignment.arch ?? {};
  try {
    _nativeRunner = new NativeRunner(
      shardPath, a, _assignment.layerStart, _assignment.layerEnd,
      _assignment.modelType ?? 'qwen2',
    );
  } catch (err) {
    log('WARN', 'worker: native runner spawn failed', { error: err.message });
  }
}

function _saveState() {
  const state = {
    running:    true,
    wsUrl:      coordinatorUrl,
    assignment: _assignment,
    ramMb:      Math.floor(os.freemem() / (1024 * 1024)),
    uptimeSec:  Math.floor(process.uptime()),
    updatedAt:  new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(stateFile + '.tmp', stateFile);
  } catch {}
}

setInterval(_saveState, PEER_RANGE).unref();

// ── Shard weight cache ────────────────────────────────────────────────────────
const SHARD_CACHE_DIR = path.join(__dirname, 'data', 'shard_cache');
fs.mkdirSync(SHARD_CACHE_DIR, { recursive: true });

let _shardLoaded  = false;
let _shardTensors = null;
let _shardRx      = null;   // in-progress chunked-shard reassembly { chunks: [Buffer] }

function _shardCachePath() {
  const id = _identity?.nodeId?.slice(0, 12) ?? 'unknown';
  return path.join(SHARD_CACHE_DIR, `shard-${id}.bin`);
}

function _parseShard(buf) {
  const numTensors = buf.readUInt32LE(0);
  let   off        = 4;
  const tensors    = [];
  for (let i = 0; i < numTensors; i++) {
    if (off + 2 > buf.length) throw new Error(`shard parse overrun at tensor ${i} (nameLen)`);
    const nameLen  = buf.readUInt16LE(off);                     off += 2;
    if (off + nameLen + 8 > buf.length) throw new Error(`shard parse overrun at tensor ${i} (name)`);
    const name     = buf.slice(off, off + nameLen).toString();  off += nameLen;
    const ggmlType = buf.readUInt32LE(off);                     off += 4;
    const ndim     = buf.readUInt32LE(off);                     off += 4;
    if (off + ndim * 4 > buf.length) throw new Error(`shard parse overrun at tensor ${i} (dims)`);
    const dims     = [];
    for (let d = 0; d < ndim; d++) { dims.push(buf.readUInt32LE(off)); off += 4; }
    if (off + 4 > buf.length) throw new Error(`shard parse overrun at tensor ${i} (dataLen)`);
    const dataLen  = buf.readUInt32LE(off);                     off += 4;
    if (off + dataLen > buf.length) throw new Error(`shard parse overrun at tensor ${i} (data)`);
    const data     = buf.slice(off, off + dataLen);             off += dataLen;
    tensors.push({ name, ggmlType, dimensions: dims, data });
  }
  return tensors;
}

function _loadCachedShard() {
  const cachePath = _shardCachePath();
  if (!fs.existsSync(cachePath)) return false;
  try {
    const buf = fs.readFileSync(cachePath);
    _shardTensors = _parseShard(buf);
    _shardLoaded  = true;
    const _nTensors = _shardTensors.length;
    _tryInitQwen2();
    _tryInitNative();
    // If the native runner is up it reads weights from the on-disk shard, so the
    // parsed shard in JS heap (which pins the whole multi-hundred-MB buffer) is
    // dead weight — release it. Only the JS fallback needs _shardTensors.
    if (_nativeRunner) { _qwen2 = null; _shardTensors = null; }
    log('INFO', 'worker: shard loaded from cache', {
      tensors: _nTensors,
      bytes:   buf.length,
      path:    cachePath,
    });
    return true;
  } catch (err) {
    log('WARN', 'worker: cached shard corrupt, ignoring', { error: err.message });
    return false;
  }
}

// ── Identity ──────────────────────────────────────────────────────────────────
const IDENTITY_FILE = path.join(__dirname, 'data', 'identity-worker.json');

try {
  _identity = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
} catch {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding:  { type: 'spki',  format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  _identity = {
    nodeId:        publicKey.toString('base64'),
    publicKeyB64:  publicKey.toString('base64'),
    privateKeyB64: privateKey.toString('base64'),
    createdAt:     new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(IDENTITY_FILE), { recursive: true });
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify(_identity, null, 2), { mode: 0o600 });
  } catch {}
}

// ── Bootstrap announce (secondary mesh discovery) ─────────────────────────────
const BOOTSTRAP = cfg.bootstrapUrl ?? process.env.BOOTSTRAP_URL ?? 'http://node.circuitllm.xyz:18500';

function _announceBootstrap() {
  const body = JSON.stringify({
    nodeId:       _identity.nodeId,
    version:      '0.2.0',
    region:       cfg.region ?? 'us-east',
    capabilities: ['llm-worker'],
    ramMb:        Math.floor(os.freemem() / (1024 * 1024)),
    timestamp:    Date.now(),
  });

  const parsed  = new URL(BOOTSTRAP);
  const lib     = parsed.protocol === 'https:' ? https : http;
  const options = {
    hostname: parsed.hostname,
    port:     parsed.port,
    path:     '/nodes/announce',
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };

  const req = lib.request(options, res => {
    log('DEBUG', 'worker: bootstrap announced', { status: res.statusCode });
  });
  req.on('error', () => {});
  req.setTimeout(5000, () => req.destroy());
  req.write(body);
  req.end();
}

// ── HELLO frame ───────────────────────────────────────────────────────────────
function _sendHello(ws) {
  const ts   = Date.now();
  const hmac = clusterKey
    ? crypto.createHmac('sha256', clusterKey).update(_identity.nodeId + ':' + ts).digest('hex')
    : '';
  const payload = Buffer.from(JSON.stringify({
    nodeId:       _identity.nodeId,
    ramMb:        Math.floor(os.freemem() / (1024 * 1024)),
    gpuVramMb:    _gpuVramMb,
    walletAddress,
    version:      '0.2.0',
    ts,
    hmac,
  }), 'utf8');
  ws.send(encode(MSG.HELLO, payload, ++_seqId));
}

// ── Handle inbound frames ─────────────────────────────────────────────────────
function _handleFrame(ws, data) {
  const buf       = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const magic     = buf.readUInt32LE(0);
  if (magic !== MAGIC) return;
  const msgType    = buf.readUInt32LE(4);
  const seqIdIn    = buf.readUInt32LE(8);
  const sessionId  = buf.readUInt32LE(12);
  const payLen     = buf.readUInt32LE(16);
  const storedCsum = buf.readUInt32LE(20);
  const payload    = buf.slice(HEADER_LEN, HEADER_LEN + payLen);
  if (djb2(payload) !== storedCsum) {
    log('WARN', 'worker: checksum mismatch, dropping frame', { msgType, payLen });
    return;
  }

  if (msgType === MSG.LAYER_ASSIGN) {
    try {
      const newAssign = JSON.parse(payload.toString('utf8'));
      log('INFO', 'worker: layers assigned', {
        start:     newAssign.layerStart,
        end:       newAssign.layerEnd,
        total:     newAssign.totalLayers,
        modelType: newAssign.modelType ?? 'qwen2',
      });

      // Clear stale shard/weights from a previous assignment — the coordinator
      // will push a fresh shard after this. We do NOT send LAYER_ACK here;
      // it's sent from the WEIGHT_SHARD handler once a compute backend is ready.
      _qwen2        = null;
      if (_nativeRunner) { _nativeRunner.destroy(); _nativeRunner = null; }
      _shardTensors = null;
      _shardRx      = null;   // drop any partial chunked shard from a prior assignment
      _shardLoaded  = false;
      _assignment   = newAssign;

      // If no layers assigned (passthrough node), ACK immediately — no shard coming.
      if (newAssign.layerEnd < newAssign.layerStart) {
        ws.send(encodeLayerAck(++_seqId, sessionId));
      }
      _saveState();
    } catch (err) {
      log('WARN', 'worker: assignment parse failed', { error: err.message });
    }
    return;
  }

  if (msgType === MSG.WEIGHT_SHARD) {
    try {
      const metaLen  = payload.readUInt32LE(0);
      const meta     = JSON.parse(payload.slice(4, 4 + metaLen).toString('utf8'));
      const chunkBuf = payload.slice(4 + metaLen);
      const nChunks  = meta.chunks ?? 1;   // backward-compat: no field = single frame
      const idx      = meta.chunk  ?? 0;

      // Reject shard if its layer range doesn't match our assignment (check on first chunk).
      if (idx === 0 && _assignment && meta.layerStart !== undefined &&
          (meta.layerStart !== _assignment.layerStart || meta.layerEnd !== _assignment.layerEnd)) {
        const msg = `assigned ${_assignment.layerStart}-${_assignment.layerEnd}, got shard ${meta.layerStart}-${meta.layerEnd}`;
        log('WARN', 'worker: shard layer range mismatch, rejecting', { detail: msg });
        ws.send(encodeError('SHARD_MISMATCH', msg, ++_seqId, sessionId));
        _shardRx = null;
        return;
      }

      // Reassemble the (possibly chunked) shard. WS rides on TCP so chunks arrive
      // in order 0..N-1; we buffer until the last one, then concat the full shard.
      if (idx === 0) _shardRx = { chunks: [] };
      if (!_shardRx) { log('WARN', 'worker: shard chunk arrived without a start frame, ignoring'); return; }
      _shardRx.chunks.push(chunkBuf);
      if (idx < nChunks - 1) return;   // more chunks coming — wait
      const shardBuf = _shardRx.chunks.length === 1 ? _shardRx.chunks[0] : Buffer.concat(_shardRx.chunks);
      _shardRx = null;
      if (nChunks > 1) log('INFO', 'worker: shard reassembled', { chunks: nChunks, mb: Math.round(shardBuf.length / 1e6) });

      const parsed = _parseShard(shardBuf);
      _shardTensors = parsed;
      _shardLoaded  = true;

      if (meta.layerStart !== undefined) {
        _assignment = {
          ..._assignment,
          layerStart:  meta.layerStart,
          layerEnd:    meta.layerEnd,
          totalLayers: meta.totalLayers ?? 24,
        };
      }

      // Tear down old native runner before re-initializing
      if (_nativeRunner) { _nativeRunner.destroy(); _nativeRunner = null; }

      _tryInitQwen2();

      try {
        const tmp = _shardCachePath() + '.tmp';
        // Node's single fs write is capped at 2^31-1 bytes (~2GB); the GPU worker's
        // shard can be >3GB, so write it in 1GB slices via a file descriptor.
        const fd = fs.openSync(tmp, 'w');
        try {
          const WRITE_CHUNK = 1 << 30; // 1GB
          for (let off = 0; off < shardBuf.length; off += WRITE_CHUNK) {
            fs.writeSync(fd, shardBuf, off, Math.min(WRITE_CHUNK, shardBuf.length - off));
          }
        } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, _shardCachePath());
      } catch (err) { log('WARN', 'worker: shard cache write failed', { error: err.message }); }

      // Try native runner after writing shard to disk (it reads from disk).
      // If native succeeds, release the JS worker — it's unused and holds raw tensor refs.
      // Guard so a native-init failure can never bypass the LAYER_ACK below when a
      // JS backend is available (the native path is preferred but not required).
      try { _tryInitNative(); } catch (err) { log('WARN', 'worker: native init threw', { error: err.message }); }
      const _nTensors = _shardTensors ? _shardTensors.length : 0;
      // Native runner reads weights from the on-disk shard, so the parsed shard in
      // JS heap (which pins the whole multi-hundred-MB buffer) is dead weight once
      // it's up — release it. Only the JS fallback path needs _shardTensors.
      if (_nativeRunner) { _qwen2 = null; _shardTensors = null; }

      log('INFO', 'worker: shard received', {
        tensors: _nTensors,
        bytes:   shardBuf.length,
        layers:  `${meta.layerStart}–${meta.layerEnd}`,
        backend: _nativeRunner ? 'native' : 'js',
      });

      // ACK if native runner OR JS worker initialized; otherwise report failure.
      if (_nativeRunner || _qwen2) {
        ws.send(encodeLayerAck(++_seqId, sessionId));
      } else {
        ws.send(encodeError('INIT_FAILED', 'No compute backend initialized after shard load', ++_seqId, sessionId));
      }
      _saveState();
    } catch (err) {
      log('WARN', 'worker: shard parse failed', { error: err.message });
    }
    return;
  }

  if (msgType === MSG.PING) {
    ws.send(encodePong(seqIdIn));
    return;
  }

  if (msgType === MSG.TENSOR_FWD) {
    const pos = payload.readUInt32LE(0);
    const { dtype, shape, data } = decodeTensor(payload.slice(4));
    log('DEBUG', 'worker: tensor received', { shape, pos, bytes: data.length, sessionId });

    const expectedLen = _assignment?.arch?.hiddenSize ?? 896;
    const actualLen   = data.byteLength / 4;
    if (actualLen !== expectedLen) {
      log('WARN', 'worker: tensor shape mismatch', { expected: expectedLen, got: actualLen });
      ws.send(encodeError('SHAPE_MISMATCH', `expected ${expectedLen} elements, got ${actualLen}`, seqIdIn, sessionId));
      return;
    }

    if (!_nativeRunner && !_qwen2) {
      log('WARN', 'worker: tensor received but no compute backend ready');
      ws.send(encodeError('NOT_READY', 'No compute backend loaded', seqIdIn, sessionId));
      return;
    }

    const hidden = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);

    // Native runner path (async subprocess IPC)
    if (_nativeRunner) {
      _nativeRunner.forward(hidden, pos, sessionId).then(result => {
        const retBuf = Buffer.from(result.buffer, result.byteOffset, result.byteLength);
        ws.send(encodeTensorRet(retBuf, shape, 0 /* f32 */, seqIdIn, sessionId));
      }).catch(err => {
        log('WARN', 'worker: native runner forward error', { error: err.message });
        ws.send(encodeError('FORWARD_ERROR', err.message, seqIdIn, sessionId));
      });
      return;
    }

    // JS fallback path (synchronous). The JS Qwen2Worker has a SINGLE shared KV
    // cache — it cannot multiplex sessions. To avoid silently corrupting one
    // session's attention state with another's, allow only ONE active session at
    // a time and reject foreign sessions with a loud error (fail, don't corrupt).
    // A stale claim is released after JS_SESSION_IDLE_MS so a crashed client can't
    // wedge the worker. This path should never run in production (the native
    // runner is preferred); it's a degraded fallback only.
    const nowMs = Date.now();
    if (_jsActiveSession !== null && _jsActiveSession !== sessionId
        && (nowMs - _jsActiveAt) < JS_SESSION_IDLE_MS) {
      log('WARN', 'worker: JS fallback busy with another session, rejecting', {
        active: _jsActiveSession, incoming: sessionId,
      });
      ws.send(encodeError('JS_SINGLE_SESSION',
        'JS fallback handles one session at a time (no native runner)', seqIdIn, sessionId));
      return;
    }
    try {
      if (pos === 0 || _jsActiveSession !== sessionId) _qwen2.resetKv();
      _jsActiveSession = sessionId;
      _jsActiveAt      = nowMs;
      const result = _qwen2.forward(hidden, pos);
      const retBuf = Buffer.from(result.buffer, result.byteOffset, result.byteLength);
      ws.send(encodeTensorRet(retBuf, shape, 0 /* f32 */, seqIdIn, sessionId));
    } catch (err) {
      log('WARN', 'worker: forward pass error', { error: err.message });
      ws.send(encodeError('FORWARD_ERROR', err.message, seqIdIn, sessionId));
    }
    return;
  }
}

// ── WebSocket connect with backoff ────────────────────────────────────────────
function _connect() {
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
    log('WARN', 'worker: already connected, skipping reconnect');
    return;
  }
  // 3GB max frame — a heavy worker (e.g. RunPod taking ~12-18 layers of a 7B
  // model) receives its whole weight shard in one WEIGHT_SHARD frame; 12 layers
  // ≈ 1.8GB, so 1GB was too small and dropped the connection mid-delivery.
  const ws = new WebSocket(coordinatorUrl, { maxPayload: 3 * 1024 * 1024 * 1024 });
  _ws = ws;

  // Transport keepalive: ping the coordinator every 20s so NAT/proxies on the
  // VPS→RunPod internet path don't cull the idle WebSocket — the cause of the
  // intermittent code-1006 drops that fail in-flight inference. If two pings go
  // unanswered (~40s), treat the link as dead and force a fast reconnect.
  let _alive = true;
  let _ka = null;
  ws.on('pong', () => { _alive = true; });

  ws.on('open', () => {
    _reconnectDelay = 2_000;
    log('INFO', 'worker: connected to coordinator', { url: coordinatorUrl });
    _sendHello(ws);
    _alive = true;
    _ka = setInterval(() => {
      if (!_alive) { log('WARN', 'worker: keepalive timeout, terminating link'); try { ws.terminate(); } catch {} return; }
      _alive = false;
      try { ws.ping(); } catch {}
    }, 20_000);
    _ka.unref?.();
  });

  ws.on('message', (data, isBinary) => { if (isBinary) _handleFrame(ws, data); });

  ws.on('close', (code) => {
    if (_ka) { clearInterval(_ka); _ka = null; }
    _ws = null; _assignment = null;
    if (_nativeRunner) { _nativeRunner.destroy(); _nativeRunner = null; }
    _saveState();
    log('INFO', 'worker: disconnected', { code, reconnectMs: Math.round(_reconnectDelay) });
    // Cap backoff low (8s) — a dropped worker's layers are missing from the
    // pipeline until it rejoins, so every request fails meanwhile. Reconnect fast.
    _reconnectDelay = Math.min(_reconnectDelay * 1.5, 8_000);
    _reconnectTimer = setTimeout(_connect, _reconnectDelay);
  });

  ws.on('error', err => log('WARN', 'worker: error', { error: err.message }));
}

// ── Startup ───────────────────────────────────────────────────────────────────
_loadCachedShard();
_connect();
_announceBootstrap();
setInterval(_announceBootstrap, 60_000).unref();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown() {
  log('INFO', 'worker: shutting down');
  if (_reconnectTimer) clearTimeout(_reconnectTimer);
  if (_ws) { try { _ws.close(); } catch {} _ws = null; }
  try { fs.writeFileSync(stateFile, JSON.stringify({ running: false }), 'utf8'); } catch {}
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
