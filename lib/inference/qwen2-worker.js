'use strict';
// lib/inference/qwen2-worker.js — Qwen2 transformer forward pass for workers.
//
// Runs a contiguous range of transformer layers using dequantized weight tensors
// loaded from the worker's GGUF shard. Called on each TENSOR_FWD message.
//
// Architecture (Qwen2.5-0.5B):
//   hiddenDim   = 896
//   numHeads    = 14  (query heads)
//   numKvHeads  = 2   (GQA key/value heads; each serves 7 query heads)
//   headDim     = 64
//   ffnDim      = 4864
//   ropeFreqBase = 1000000
//   rmsEps      = 1e-6

const { dequantize } = require('./dequant');

// ── RMSNorm ───────────────────────────────────────────────────────────────────
function rmsNorm(x, weight, eps, n) {
  let ss = 0;
  for (let i = 0; i < n; i++) ss += x[i] * x[i];
  const scale = 1 / Math.sqrt(ss / n + eps);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = x[i] * scale * weight[i];
  return out;
}

// ── Matrix-vector multiply: y = W x ──────────────────────────────────────────
// W is [outRows, inCols] in row-major; x is [inCols]; y is [outRows]
function matvec(W, x, outRows, inCols) {
  const y = new Float32Array(outRows);
  for (let i = 0; i < outRows; i++) {
    let sum = 0;
    const base = i * inCols;
    for (let j = 0; j < inCols; j++) sum += W[base + j] * x[j];
    y[i] = sum;
  }
  return y;
}

// ── SiLU activation ───────────────────────────────────────────────────────────
function silu(x) { return x / (1 + Math.exp(-x)); }

// ── RoPE precomputation ───────────────────────────────────────────────────────
function buildRopeCache(maxSeqLen, headDim, freqBase) {
  const cos = new Float32Array(maxSeqLen * headDim / 2);
  const sin = new Float32Array(maxSeqLen * headDim / 2);
  for (let pos = 0; pos < maxSeqLen; pos++) {
    for (let i = 0; i < headDim / 2; i++) {
      const theta = pos / Math.pow(freqBase, (2 * i) / headDim);
      cos[pos * (headDim / 2) + i] = Math.cos(theta);
      sin[pos * (headDim / 2) + i] = Math.sin(theta);
    }
  }
  return { cos, sin };
}

// Apply RoPE to q or k tensor [numHeads, headDim]
function applyRope(qk, pos, numHeads, headDim, ropeCache) {
  const halfDim = headDim / 2;
  const out = new Float32Array(qk.length);
  const cosRow = pos * halfDim;
  const sinRow = pos * halfDim;
  for (let h = 0; h < numHeads; h++) {
    const base = h * headDim;
    for (let i = 0; i < halfDim; i++) {
      const x0 = qk[base + i];
      const x1 = qk[base + i + halfDim];
      const c  = ropeCache.cos[cosRow + i];
      const s  = ropeCache.sin[sinRow + i];
      out[base + i]          = x0 * c - x1 * s;
      out[base + i + halfDim] = x0 * s + x1 * c;
    }
  }
  return out;
}

// ── Qwen2Worker class ─────────────────────────────────────────────────────────
class Qwen2Worker {
  /**
   * @param {Array<{name, ggmlType, dimensions, data}>} rawTensors — from shard
   * @param {object} config — { hiddenDim, numHeads, numKvHeads, ffnDim, rmsEps, ropeFreqBase, layerStart, layerEnd }
   */
  constructor(rawTensors, config) {
    this.cfg     = config;
    this.layers  = null;  // loaded lazily
    this._rawMap = new Map(rawTensors.map(t => [t.name, t]));

    const { headDim } = this._dims();
    const maxSeq = config.maxSeqLen ?? 4096;
    this._rope   = buildRopeCache(maxSeq, headDim, config.ropeFreqBase ?? 1000000);

    // KV cache per layer: [n_kv_heads, maxSeq, headDim]
    this._kvK = {};
    this._kvV = {};
    for (let l = config.layerStart; l <= config.layerEnd; l++) {
      const size = config.numKvHeads * maxSeq * headDim;
      this._kvK[l] = new Float32Array(size);
      this._kvV[l] = new Float32Array(size);
    }
    this._curPos = 0;
  }

  _dims() {
    const { hiddenDim, numHeads, numKvHeads, ffnDim } = this.cfg;
    return { headDim: Math.floor(hiddenDim / numHeads), hiddenDim, numHeads, numKvHeads, ffnDim };
  }

  // Dequantize and cache all layer tensors (once, on first forward call)
  _ensureLoaded() {
    if (this.layers) return;
    const { layerStart, layerEnd } = this.cfg;
    const { headDim, hiddenDim, numHeads, numKvHeads, ffnDim } = this._dims();
    const layers = {};
    for (let l = layerStart; l <= layerEnd; l++) {
      const get = (suffix) => {
        const t = this._rawMap.get(`blk.${l}.${suffix}`);
        if (!t) throw new Error(`Missing tensor blk.${l}.${suffix}`);
        const n = t.dimensions.reduce((a, b) => a * b, 1);
        return dequantize(t.data, t.ggmlType, n);
      };
      layers[l] = {
        attn_norm:    get('attn_norm.weight'),
        ffn_norm:     get('ffn_norm.weight'),
        attn_q_w:     get('attn_q.weight'),
        attn_q_b:     get('attn_q.bias'),
        attn_k_w:     get('attn_k.weight'),
        attn_k_b:     get('attn_k.bias'),
        attn_v_w:     get('attn_v.weight'),
        attn_v_b:     get('attn_v.bias'),
        attn_out_w:   get('attn_output.weight'),
        ffn_gate_w:   get('ffn_gate.weight'),
        ffn_up_w:     get('ffn_up.weight'),
        ffn_down_w:   get('ffn_down.weight'),
      };
    }
    this.layers  = layers;   // only assigned after loop succeeds
    this._rawMap = null;     // free raw data
  }

  /**
   * Run one forward pass step.
   * @param {Float32Array} hidden — input hidden state [hiddenDim]
   * @param {number}       pos    — position index (for KV cache + RoPE)
   * @returns {Float32Array}       — output hidden state [hiddenDim]
   */
  forward(hidden, pos) {
    this._ensureLoaded();
    const { headDim, hiddenDim, numHeads, numKvHeads, ffnDim } = this._dims();
    const { rmsEps, layerStart, layerEnd } = this.cfg;
    const { rope } = this;

    let h = hidden;
    for (let l = layerStart; l <= layerEnd; l++) {
      const w = this.layers[l];

      // ── Attention ─────────────────────────────────────────────────────────
      const normed = rmsNorm(h, w.attn_norm, rmsEps ?? 1e-6, hiddenDim);

      // QKV projections
      let q = matvec(w.attn_q_w, normed, numHeads * headDim, hiddenDim);
      let k = matvec(w.attn_k_w, normed, numKvHeads * headDim, hiddenDim);
      let v = matvec(w.attn_v_w, normed, numKvHeads * headDim, hiddenDim);

      // Add biases
      for (let i = 0; i < numHeads * headDim; i++)     q[i] += w.attn_q_b[i];
      for (let i = 0; i < numKvHeads * headDim; i++) {
        k[i] += w.attn_k_b[i];
        v[i] += w.attn_v_b[i];
      }

      // RoPE
      q = applyRope(q, pos, numHeads,   headDim, this._rope);
      k = applyRope(k, pos, numKvHeads, headDim, this._rope);

      // Write K/V to cache
      const kvSlot = pos * numKvHeads * headDim;
      for (let kvi = 0; kvi < numKvHeads * headDim; kvi++) {
        this._kvK[l][kvSlot + kvi] = k[kvi];
        this._kvV[l][kvSlot + kvi] = v[kvi];
      }

      // Attention scores: [numHeads, seqLen] where seqLen = pos + 1
      const seqLen = pos + 1;
      const scale  = 1 / Math.sqrt(headDim);
      const kvPerQ = Math.floor(numHeads / numKvHeads); // GQA: heads per kv group

      const attnOut = new Float32Array(numHeads * headDim);
      for (let h_idx = 0; h_idx < numHeads; h_idx++) {
        const kvHead = Math.floor(h_idx / kvPerQ);
        const qHead  = q.subarray(h_idx * headDim, (h_idx + 1) * headDim);

        // Compute attention scores over all past+current positions
        const scores = new Float32Array(seqLen);
        for (let t = 0; t < seqLen; t++) {
          const kBase = t * numKvHeads * headDim + kvHead * headDim;
          let dot = 0;
          for (let d = 0; d < headDim; d++) dot += qHead[d] * this._kvK[l][kBase + d];
          scores[t] = dot * scale;
        }

        // Softmax
        let maxScore = -Infinity;
        for (let t = 0; t < seqLen; t++) if (scores[t] > maxScore) maxScore = scores[t];
        let sumExp = 0;
        for (let t = 0; t < seqLen; t++) { scores[t] = Math.exp(scores[t] - maxScore); sumExp += scores[t]; }
        for (let t = 0; t < seqLen; t++) scores[t] /= sumExp;

        // Weighted sum of V
        const headOut = attnOut.subarray(h_idx * headDim, (h_idx + 1) * headDim);
        for (let t = 0; t < seqLen; t++) {
          const vBase = t * numKvHeads * headDim + kvHead * headDim;
          for (let d = 0; d < headDim; d++) headOut[d] += scores[t] * this._kvV[l][vBase + d];
        }
      }

      // Output projection + residual
      const attnRes = matvec(w.attn_out_w, attnOut, hiddenDim, numHeads * headDim);
      const h2 = new Float32Array(hiddenDim);
      for (let i = 0; i < hiddenDim; i++) h2[i] = h[i] + attnRes[i];

      // ── FFN ───────────────────────────────────────────────────────────────
      const normed2 = rmsNorm(h2, w.ffn_norm, rmsEps ?? 1e-6, hiddenDim);

      const gate = matvec(w.ffn_gate_w, normed2, ffnDim, hiddenDim);
      const up   = matvec(w.ffn_up_w,   normed2, ffnDim, hiddenDim);

      // SwiGLU: silu(gate) * up
      const gated = new Float32Array(ffnDim);
      for (let i = 0; i < ffnDim; i++) {
        gated[i] = silu(gate[i]) * up[i];
      }

      const ffnOut = matvec(w.ffn_down_w, gated, hiddenDim, ffnDim);
      h = new Float32Array(hiddenDim);
      for (let i = 0; i < hiddenDim; i++) h[i] = h2[i] + ffnOut[i];
    }

    return h;
  }

  // Reset KV cache (new session)
  resetKv() {
    for (const l of Object.keys(this._kvK)) {
      this._kvK[l].fill(0);
      this._kvV[l].fill(0);
    }
  }
}

module.exports = { Qwen2Worker };
