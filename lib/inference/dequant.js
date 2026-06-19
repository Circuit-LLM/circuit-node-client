'use strict';
// lib/inference/dequant.js — GGML tensor dequantization to Float32.
//
// Supports the types used in qwen2.5-0.5b-instruct-q4_k_m.gguf:
//   0  = F32  (passthrough)
//   1  = F16  (half-precision float)
//   6  = Q5_0 (most weights)
//   8  = Q8_0 (attn_v)
//   12 = Q4_K (ffn_down.weight in some layers)
//   14 = Q6_K (other ffn_down weights)

// ── F16 → F32 lookup table ────────────────────────────────────────────────────
const FP16_TABLE = new Float32Array(65536);
(function buildFp16Table() {
  for (let i = 0; i < 65536; i++) {
    const s =  (i & 0x8000) ? -1 : 1;
    const e = (i >> 10) & 0x1F;
    const f =  i & 0x3FF;
    if (e === 0) {
      FP16_TABLE[i] = s * f * 5.960464477539063e-8; // 2^-24
    } else if (e === 31) {
      FP16_TABLE[i] = f ? NaN : s * Infinity;
    } else {
      FP16_TABLE[i] = s * Math.pow(2, e - 15) * (1 + f * 9.765625e-4); // 1/1024
    }
  }
})();

function fp16(buf, offset) {
  return FP16_TABLE[buf.readUInt16LE(offset)];
}

// ── Q5_0 dequantization ───────────────────────────────────────────────────────
// Block layout (22 bytes per 32 elements):
//   [2B] d   — f16 scale
//   [4B] qh  — high bits (bit i of qh → 5th bit of element i)
//   [16B] qs — nibbles (low 4 bits per element, two per byte)
const Q5_0_BLOCK = 22;
const Q5_0_K     = 32;

function dequantQ5_0(buf, numElements) {
  const out = new Float32Array(numElements);
  const nb  = Math.ceil(numElements / Q5_0_K);
  if (buf.length < nb * Q5_0_BLOCK) throw new Error(`Q5_0: buffer too short: ${buf.length} < ${nb * Q5_0_BLOCK}`);
  let outOff = 0;
  let bufOff = 0;
  for (let bi = 0; bi < nb; bi++) {
    const d  = fp16(buf, bufOff);
    const qh = buf.readUInt32LE(bufOff + 2);
    const qsBase = bufOff + 6;
    for (let j = 0; j < Q5_0_K / 2; j++) {
      const byte = buf[qsBase + j];
      const x0 = (byte & 0x0F) | (((qh >> j)       & 1) << 4);
      const x1 = (byte >>    4) | (((qh >> (j + 16)) & 1) << 4);
      out[outOff + j]              = (x0 - 16) * d;
      out[outOff + j + Q5_0_K / 2] = (x1 - 16) * d;
    }
    outOff += Q5_0_K;
    bufOff += Q5_0_BLOCK;
  }
  return out;
}

// ── Q6_K dequantization ───────────────────────────────────────────────────────
// Block layout (210 bytes per 256 elements):
//   [128B] ql   — lower 4 bits of quants (two 4-bit quants per byte: lo=elem j, hi=elem j+64)
//   [64B]  qh   — upper 2 bits per quant (4 × 2-bit fields per byte)
//   [16B]  scales — int8 scale per 16-element sub-block (16 sub-blocks)
//   [2B]   d    — f16 super-block scale (at byte 208)
//
// Two outer iterations of 128 elements each (n=0 and n=128).
// Inner loop l=0..31 produces 4 elements per iteration via ql nibble pairs.
const Q6_K_BLOCK = 210;
const Q6_K_SIZE  = 256;

function dequantQ6_K(buf, numElements) {
  const out = new Float32Array(numElements);
  const nb  = Math.ceil(numElements / Q6_K_SIZE);
  if (buf.length < nb * Q6_K_BLOCK) throw new Error(`Q6_K: buffer too short: ${buf.length} < ${nb * Q6_K_BLOCK}`);
  let outOff = 0;
  let bufOff = 0;
  for (let bi = 0; bi < nb; bi++) {
    const qlBase = bufOff;
    const qhBase = bufOff + 128;
    const scBase = bufOff + 192;
    const d      = fp16(buf, bufOff + 208);

    // Two outer iterations: first processes elements 0..127, second 128..255.
    // Each iteration: ql advances 64 bytes, qh advances 32 bytes, sc advances 8.
    let qlOff = 0, qhOff = 0, scOff = 0;
    for (let n = 0; n < Q6_K_SIZE; n += 128) {
      for (let l = 0; l < 32; l++) {
        const is = (l >> 4);  // 0 for l=0..15, 1 for l=16..31
        const ql0 = buf[qlBase + qlOff + l];        // nibbles for elem l and elem l+64
        const ql1 = buf[qlBase + qlOff + l + 32];   // nibbles for elem l+32 and elem l+96
        const qhv = buf[qhBase + qhOff + l];         // 4 × 2-bit high-bit fields

        const q1 = ((ql0 & 0xF) | (((qhv >> 0) & 3) << 4)) - 32;  // elem n+l
        const q2 = ((ql1 & 0xF) | (((qhv >> 2) & 3) << 4)) - 32;  // elem n+l+32
        const q3 = ((ql0  >> 4) | (((qhv >> 4) & 3) << 4)) - 32;  // elem n+l+64
        const q4 = ((ql1  >> 4) | (((qhv >> 6) & 3) << 4)) - 32;  // elem n+l+96

        out[outOff + n + l]      = d * buf.readInt8(scBase + scOff + is + 0) * q1;
        out[outOff + n + l + 32] = d * buf.readInt8(scBase + scOff + is + 2) * q2;
        out[outOff + n + l + 64] = d * buf.readInt8(scBase + scOff + is + 4) * q3;
        out[outOff + n + l + 96] = d * buf.readInt8(scBase + scOff + is + 6) * q4;
      }
      qlOff += 64;
      qhOff += 32;
      scOff += 8;
    }

    outOff += Q6_K_SIZE;
    bufOff += Q6_K_BLOCK;
  }
  return out;
}

// ── Q8_0 dequantization ───────────────────────────────────────────────────────
// Block layout (34 bytes per 32 elements):
//   [2B] d  — f16 scale
//   [32B] qs — int8 quants
const Q8_0_BLOCK = 34;
const Q8_0_K     = 32;

function dequantQ8_0(buf, numElements) {
  const out = new Float32Array(numElements);
  const nb  = Math.ceil(numElements / Q8_0_K);
  if (buf.length < nb * Q8_0_BLOCK) throw new Error(`Q8_0: buffer too short: ${buf.length} < ${nb * Q8_0_BLOCK}`);
  let outOff = 0;
  let bufOff = 0;
  for (let bi = 0; bi < nb; bi++) {
    const d = fp16(buf, bufOff);
    for (let j = 0; j < Q8_0_K; j++) {
      out[outOff + j] = buf.readInt8(bufOff + 2 + j) * d;
    }
    outOff += Q8_0_K;
    bufOff += Q8_0_BLOCK;
  }
  return out;
}

// ── F16 dequantization ────────────────────────────────────────────────────────
function dequantF16(buf, numElements) {
  if (buf.length < numElements * 2) throw new Error(`F16: buffer too short: ${buf.length} < ${numElements * 2}`);
  const out = new Float32Array(numElements);
  for (let i = 0; i < numElements; i++) {
    out[i] = FP16_TABLE[buf.readUInt16LE(i * 2)];
  }
  return out;
}

// ── F32 passthrough ───────────────────────────────────────────────────────────
function dequantF32(buf, numElements) {
  // Buffer slices share the parent ArrayBuffer with non-zero byteOffset,
  // which may not be 4-byte aligned. Copy to a fresh aligned ArrayBuffer.
  const ab = new ArrayBuffer(numElements * 4);
  Buffer.from(ab).set(buf.subarray(0, numElements * 4));
  return new Float32Array(ab);
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
/**
 * @param {Buffer}  buf         — raw quantized bytes
 * @param {number}  ggmlType    — GGML type enum
 * @param {number}  numElements — total number of float values to produce
 * @returns {Float32Array}
 */
// ── Q4_K dequantization ───────────────────────────────────────────────────────
// Block layout (144 bytes per 256 elements, QK_K=256):
//   [2B] d     — f16 super-block scale
//   [2B] dmin  — f16 super-block min
//   [12B] scales — packed 6-bit scale+min for 8 sub-groups of 32 elements
//   [128B] qs  — 4-bit nibbles (two per byte, 256 elements)
const Q4_K_BLOCK = 144;
const Q4_K_ELEMS = 256;

function _getScaleMinK4(j, scales) {
  if (j < 4) {
    return { sc: scales[j] & 63, m: scales[j + 4] & 63 };
  }
  return {
    sc: (scales[j + 4] & 0xF)  | ((scales[j - 4] >> 6) << 4),
    m:  (scales[j + 4] >> 4)   | ((scales[j]     >> 6) << 4),
  };
}

function dequantQ4_K(buf, numElements) {
  const out = new Float32Array(numElements);
  const nb  = Math.ceil(numElements / Q4_K_ELEMS);
  if (buf.length < nb * Q4_K_BLOCK) throw new Error(`Q4_K: buffer too short: ${buf.length} < ${nb * Q4_K_BLOCK}`);
  let outOff = 0;
  let bufOff = 0;
  for (let bi = 0; bi < nb; bi++) {
    const d    = fp16(buf, bufOff);      // super-block scale
    const dmin = fp16(buf, bufOff + 2);  // super-block min
    const scaleBase = bufOff + 4;        // 12-byte scales array
    const qsBase    = bufOff + 16;       // 128-byte nibble array
    let qOff = qsBase;
    let is   = 0;
    for (let j = 0; j < Q4_K_ELEMS; j += 64) {
      const { sc: sc0, m: m0 } = _getScaleMinK4(is,     buf.subarray(scaleBase, scaleBase + 12));
      const { sc: sc1, m: m1 } = _getScaleMinK4(is + 1, buf.subarray(scaleBase, scaleBase + 12));
      const dl0 = d * sc0, ml0 = dmin * m0;
      const dl1 = d * sc1, ml1 = dmin * m1;
      for (let l = 0; l < 32; l++) {
        out[outOff + j + l]      = dl0 * (buf[qOff + l] & 0xF) - ml0;
        out[outOff + j + 32 + l] = dl1 * (buf[qOff + l] >> 4)  - ml1;
      }
      qOff += 32;
      is   += 2;
    }
    bufOff += Q4_K_BLOCK;
    outOff += Q4_K_ELEMS;
  }
  return out;
}

function dequantize(buf, ggmlType, numElements) {
  switch (ggmlType) {
    case  0: return dequantF32(buf, numElements);
    case  1: return dequantF16(buf, numElements);
    case  6: return dequantQ5_0(buf, numElements);
    case  8: return dequantQ8_0(buf, numElements);
    case 12: return dequantQ4_K(buf, numElements);
    case 14: return dequantQ6_K(buf, numElements);
    default:
      throw new Error(`Unsupported GGML type ${ggmlType} for dequantization`);
  }
}

module.exports = { dequantize, fp16, FP16_TABLE };
