'use strict';

const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const http      = require('http');
const https     = require('https');
const crypto    = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// Native runner binary — local `native/` dir first, then central install
const NATIVE_RUNNER_PATHS = [
  path.join(__dirname, 'native', 'circuit-runner'),
  '/home/watchtower/circuit-node-client/native/circuit-runner',
];
const NATIVE_RUNNER_BIN = NATIVE_RUNNER_PATHS.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) ?? null;

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
    const headDim = Math.floor((a.hiddenSize ?? 896) / (a.numHeads ?? 14));
    const hasBias = !['llama3', 'llama-3'].includes(modelType ?? '');
    const threads  = Math.max(1, Math.min(os.cpus().length, 4));
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

    this._hiddenDim = a.hiddenSize ?? 896;
    this._pending   = null;
    this._buf       = Buffer.alloc(0);

    this._proc = spawn(NATIVE_RUNNER_BIN, args);
    this._proc.stderr.on('data', d => log('DEBUG', 'native-runner', { msg: d.toString().trim() }));
    this._proc.stdout.on('data', chunk => {
      this._buf = Buffer.concat([this._buf, chunk]);
      this._tryComplete();
    });
    this._proc.on('exit', code => {
      log('WARN', 'worker: native runner exited', { code });
      if (this._pending) {
        const { reject } = this._pending;
        this._pending = null;
        reject(new Error(`native runner exited with code ${code}`));
      }
    });
    log('INFO', 'worker: native runner spawned', { layers: `${layerStart}-${layerEnd}`, bin: NATIVE_RUNNER_BIN });
  }

  _tryComplete() {
    if (!this._pending) return;
    const needed = 4 + this._hiddenDim * 4;
    if (this._buf.length < needed) return;
    const outLen = this._buf.readUInt32LE(0);
    const { resolve, reject } = this._pending;
    this._pending = null;
    if (outLen !== this._hiddenDim) {
      this._buf = this._buf.slice(needed);
      reject(new Error(`native runner output size mismatch: ${outLen} != ${this._hiddenDim}`));
      return;
    }
    // Copy output before advancing buffer (avoid stale ref)
    const result = new Float32Array(this._hiddenDim);
    this._buf.copy(Buffer.from(result.buffer), 0, 4, needed);
    this._buf = this._buf.slice(needed);
    resolve(result);
  }

  forward(hidden, pos) {
    return new Promise((resolve, reject) => {
      if (this._pending) return reject(new Error('native runner busy'));
      this._pending = { resolve, reject };
      const header = Buffer.allocUnsafe(8);
      header.writeUInt32LE(pos,          0);
      header.writeUInt32LE(hidden.length, 4);
      const hidBuf = Buffer.from(hidden.buffer, hidden.byteOffset, hidden.byteLength);
      this._proc.stdin.write(header);
      this._proc.stdin.write(hidBuf);
    });
  }

  destroy() {
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
    _tryInitQwen2();
    _tryInitNative();
    if (_nativeRunner && _qwen2) { _qwen2 = null; }
    log('INFO', 'worker: shard loaded from cache', {
      tensors: _shardTensors.length,
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
    gpuVramMb:    0,
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
      const metaStr  = payload.slice(4, 4 + metaLen).toString('utf8');
      const meta     = JSON.parse(metaStr);
      const shardBuf = payload.slice(4 + metaLen);

      // Reject shard if its layer range doesn't match the assignment we received.
      if (_assignment && meta.layerStart !== undefined) {
        if (meta.layerStart !== _assignment.layerStart || meta.layerEnd !== _assignment.layerEnd) {
          const msg = `assigned ${_assignment.layerStart}-${_assignment.layerEnd}, got shard ${meta.layerStart}-${meta.layerEnd}`;
          log('WARN', 'worker: shard layer range mismatch, rejecting', { detail: msg });
          ws.send(encodeError('SHARD_MISMATCH', msg, ++_seqId, sessionId));
          return;
        }
      }

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
        fs.writeFileSync(tmp, shardBuf);
        fs.renameSync(tmp, _shardCachePath());
      } catch (err) { log('WARN', 'worker: shard cache write failed', { error: err.message }); }

      // Try native runner after writing shard to disk (it reads from disk).
      // If native succeeds, release the JS worker — it's unused and holds raw tensor refs.
      _tryInitNative();
      if (_nativeRunner && _qwen2) { _qwen2 = null; }

      log('INFO', 'worker: shard received', {
        tensors: _shardTensors.length,
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
      _nativeRunner.forward(hidden, pos).then(result => {
        const retBuf = Buffer.from(result.buffer, result.byteOffset, result.byteLength);
        ws.send(encodeTensorRet(retBuf, shape, 0 /* f32 */, seqIdIn, sessionId));
      }).catch(err => {
        log('WARN', 'worker: native runner forward error', { error: err.message });
        ws.send(encodeError('FORWARD_ERROR', err.message, seqIdIn, sessionId));
      });
      return;
    }

    // JS fallback path (synchronous)
    try {
      if (pos === 0) _qwen2.resetKv();
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
  const ws = new WebSocket(coordinatorUrl);
  _ws = ws;

  ws.on('open', () => {
    _reconnectDelay = 2_000;
    log('INFO', 'worker: connected to coordinator', { url: coordinatorUrl });
    _sendHello(ws);
  });

  ws.on('message', (data, isBinary) => { if (isBinary) _handleFrame(ws, data); });

  ws.on('close', (code) => {
    _ws = null; _assignment = null;
    if (_nativeRunner) { _nativeRunner.destroy(); _nativeRunner = null; }
    _saveState();
    log('INFO', 'worker: disconnected', { code, reconnectMs: Math.round(_reconnectDelay) });
    _reconnectDelay = Math.min(_reconnectDelay * 1.5, 60_000);
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
