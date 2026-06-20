/*
 * circuit-runner.c — Native layer runner for Circuit Decentralized LLM workers
 *
 * Loads a shard of transformer layers from a custom binary format, then processes
 * one token at a time via stdin/stdout. Stays alive between tokens so the KV
 * cache is preserved across the generation loop.
 *
 * Protocol (binary, little-endian):
 *   stdin:  [4B session_id][4B pos][4B hidden_len][hidden_len × float32]
 *   stdout: [4B hidden_len][hidden_len × float32]
 *
 * session_id identifies the KV cache slot (allows concurrent sessions).
 * pos == 0 resets the KV cache for that session (new sequence).
 *
 * Usage:
 *   circuit-runner \
 *     --shard <path>          path to shard binary from coordinator
 *     --hidden-dim <N>        model hidden size (e.g. 896 for Qwen2.5-0.5B)
 *     --n-heads <N>           number of query attention heads
 *     --n-kv-heads <N>        number of key/value heads (GQA)
 *     --head-dim <N>          dimension per head (hidden-dim / n-heads)
 *     --ffn-dim <N>           intermediate FFN dimension
 *     --layers <S>:<E>        inclusive layer range this worker handles
 *     --rope-base <F>         RoPE frequency base (default 10000)
 *     --max-seq <N>           maximum sequence length (KV cache size)
 *     --threads <N>           CPU threads for ggml compute
 *     --max-sessions <N>      concurrent KV cache slots (default 16; LRU-evicted)
 *     [--has-bias]            set if model has Q/K/V projection biases (Qwen2 style)
 *
 * Shard wire format (same as gguf-extractor.js extractLayerShard output):
 *   [4B numTensors]
 *   For each tensor:
 *     [2B nameLen][name UTF-8][4B ggmlType][4B ndim][4B*ndim dims][4B dataLen][data]
 */

#define _POSIX_C_SOURCE 200809L
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <unistd.h>
#include <alloca.h>
#include <assert.h>

#include "ggml.h"
#include "ggml-cpu.h"

#ifdef GGML_USE_CUDA
#include "ggml-backend.h"
#include "ggml-alloc.h"
/* Forward-declare CUDA backend symbols exported by libggml-cuda.so.
 * We avoid including ggml-cuda.h because its location varies across builds. */
extern struct ggml_backend            *ggml_backend_cuda_init(int device);
extern struct ggml_backend_buffer_type *ggml_backend_cuda_buffer_type(int device);
extern struct ggml_backend            *ggml_backend_cpu_init(void);
#endif

/* ── Constants ─────────────────────────────────────────────────────────────── */
#define MAX_LAYERS     64
#define MAX_TENSORS   (MAX_LAYERS * 13 + 16)
#define MAX_NAME_LEN   128
#define MAX_SEQ_DEFAULT 4096
#define ROPE_TYPE_NEOX  2   /* NeoX-style RoPE, used by Qwen2 and GPT-NeoX     */

/* Scratch buffer for ggml computation contexts — reused every matmul call.
   Sized generously: ggml context overhead + largest output tensor (ffn_dim*4B)
   + largest input tensor + graph nodes + ggml work buffer for quantized ops. */
#define SCRATCH_SIZE (8 * 1024 * 1024)  /* 8 MB */

/* ── Shard tensor record ───────────────────────────────────────────────────── */
typedef struct {
    char          name[MAX_NAME_LEN];
    uint32_t      ggml_type;
    int           ndim;
    uint64_t      dims[4];
    size_t        data_offset;   /* byte offset into g_shard_buf */
    uint32_t      data_len;
    struct ggml_tensor *tensor;  /* created after shard load */
} TensorRecord;

/* ── CUDA backend state (only allocated when --gpu-layers > 0) ─────────────── */
#ifdef GGML_USE_CUDA
static ggml_backend_t        g_cuda_backend  = NULL;
static ggml_backend_buffer_t g_gpu_weight_buf = NULL;  /* VRAM buffer for weights */
static struct ggml_context  *g_cuda_io_ctx   = NULL;   /* context for I/O tensors */
static struct ggml_tensor   *g_cuda_xv       = NULL;   /* pre-alloc GPU input buf */
static ggml_backend_buffer_t g_cuda_io_buf   = NULL;   /* VRAM buffer for I/O     */
static ggml_gallocr_t        g_gallocr       = NULL;   /* allocator for results   */
#endif

/* Attention score buffer (one slot per sequence position, reused every layer) */
static float *g_scores = NULL;

/* Attention scratch buffers — pre-allocated at startup, reused every layer call.
 * Sized for the model's actual dims; avoids stack overflow on larger models. */
static float *g_x_norm   = NULL;  /* [hidden_dim] */
static float *g_q_buf    = NULL;  /* [n_heads * head_dim] */
static float *g_k_buf    = NULL;  /* [n_kv_heads * head_dim] */
static float *g_v_buf    = NULL;  /* [n_kv_heads * head_dim] */
static float *g_attn_buf = NULL;  /* [n_heads * head_dim] */
static float *g_ao_buf   = NULL;  /* [hidden_dim] */

/* FFN scratch buffers — pre-allocated at startup, reused every layer call.
 * Avoids 3 malloc/free per layer per token (4N heap ops for 4-layer workers). */
static float *g_gate_buf = NULL;  /* [ffn_dim] */
static float *g_up_buf   = NULL;  /* [ffn_dim] */
static float *g_ffn_buf  = NULL;  /* [hidden_dim] */

/* ── Global state ──────────────────────────────────────────────────────────── */
static uint8_t            *g_shard_buf  = NULL;
static size_t              g_shard_size = 0;
static TensorRecord        g_tensors[MAX_TENSORS];
static int                 g_n_tensors  = 0;
static struct ggml_context *g_wctx      = NULL;  /* weight context (persists) */
static void               *g_scratch    = NULL;  /* scratch buf for matmul ctx */

/* Per-layer tensor pointers (set during shard setup) */
typedef struct {
    struct ggml_tensor *attn_norm;
    struct ggml_tensor *wq, *wk, *wv, *wo;
    struct ggml_tensor *bq, *bk, *bv;          /* may be NULL when has_bias=0 */
    struct ggml_tensor *ffn_norm;
    struct ggml_tensor *ffn_gate, *ffn_up, *ffn_down;
} LayerTensors;

static LayerTensors g_layers[MAX_LAYERS];

/* Per-session KV cache table.
 * Each slot holds independent KV state for one concurrent request.
 * LRU-evicted when all slots are full. Slots are allocated lazily on first use,
 * so the table size is a ceiling, not an up-front cost. */
#define DEFAULT_MAX_SESSIONS 16

typedef struct {
    uint32_t  id;       /* session ID from wire protocol; 0 = empty slot */
    float   **kv_k;    /* [n_local_layers][max_seq * n_kv_heads * head_dim] */
    float   **kv_v;
    uint32_t  clock;   /* monotonic tick — lowest = least recently used */
    int       last_pos; /* last pos written; -1 = fresh/evicted (no history) */
} KVSession;

static KVSession *g_sessions = NULL;  /* dynamically sized to cfg.max_sessions */
static uint32_t  g_kv_clock = 0;

/* ── Configuration ─────────────────────────────────────────────────────────── */
static struct {
    char     shard_path[512];
    int      hidden_dim;
    int      n_heads;
    int      n_kv_heads;
    int      head_dim;
    int      ffn_dim;
    int      layer_start;
    int      layer_end;
    int      n_local_layers;   /* layer_end - layer_start + 1 */
    int      kv_group;         /* n_heads / n_kv_heads */
    float    rope_base;
    int      max_seq;
    int      n_threads;
    int      has_bias;
    float    rms_eps;
    int      gpu_layers;  /* layers to run on GPU (0 = CPU only); requires GGML_USE_CUDA */
    int      cuda_device; /* CUDA device index (default 0) */
    int      max_sessions; /* concurrent KV cache slots (default DEFAULT_MAX_SESSIONS) */
} cfg;

/* ── Utilities ─────────────────────────────────────────────────────────────── */
static void die(const char *msg) {
    fprintf(stderr, "circuit-runner: %s\n", msg);
    exit(1);
}

static void die_fmt(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "circuit-runner: ");
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
    exit(1);
}

/* Read exactly n bytes from fd, retrying on EINTR/partial read */
static void read_exact(int fd, void *buf, size_t n) {
    size_t done = 0;
    while (done < n) {
        ssize_t r = read(fd, (char *)buf + done, n - done);
        if (r <= 0) {
            if (r == 0) exit(0);  /* clean EOF = session done */
            perror("read");
            exit(1);
        }
        done += (size_t)r;
    }
}

static void write_exact(int fd, const void *buf, size_t n) {
    size_t done = 0;
    while (done < n) {
        ssize_t w = write(fd, (const char *)buf + done, n - done);
        if (w <= 0) { perror("write"); exit(1); }
        done += (size_t)w;
    }
}

/* ── Shard parsing ─────────────────────────────────────────────────────────── */
static void load_shard(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) die_fmt("cannot open shard: %s", path);

    fseek(f, 0, SEEK_END);
    g_shard_size = (size_t)ftell(f);
    rewind(f);

    g_shard_buf = malloc(g_shard_size);
    if (!g_shard_buf) die("out of memory for shard");
    if (fread(g_shard_buf, 1, g_shard_size, f) != g_shard_size)
        die("short read on shard");
    fclose(f);

    /* Parse shard header */
    size_t off = 0;
    uint32_t num_tensors;
    memcpy(&num_tensors, g_shard_buf + off, 4); off += 4;
    if (num_tensors > MAX_TENSORS) die("too many tensors in shard");

    for (uint32_t i = 0; i < num_tensors; i++) {
        TensorRecord *rec = &g_tensors[g_n_tensors++];
        memset(rec, 0, sizeof(*rec));

        uint16_t name_len;
        memcpy(&name_len, g_shard_buf + off, 2); off += 2;
        if (name_len >= MAX_NAME_LEN) die("tensor name too long");
        memcpy(rec->name, g_shard_buf + off, name_len);
        rec->name[name_len] = '\0';
        off += name_len;

        memcpy(&rec->ggml_type, g_shard_buf + off, 4); off += 4;

        uint32_t ndim;
        memcpy(&ndim, g_shard_buf + off, 4); off += 4;
        rec->ndim = (int)ndim;
        for (int d = 0; d < (int)ndim; d++) {
            uint32_t dim;
            memcpy(&dim, g_shard_buf + off, 4); off += 4;
            rec->dims[d] = dim;
        }

        memcpy(&rec->data_len, g_shard_buf + off, 4); off += 4;
        rec->data_offset = off;
        off += rec->data_len;
    }

    fprintf(stderr, "[circuit-runner] shard loaded: %d tensors, %.1f MB\n",
            g_n_tensors, (double)g_shard_size / (1024.0 * 1024.0));
}

/* Find a tensor record by exact name */
static TensorRecord *find_tensor(const char *name) {
    for (int i = 0; i < g_n_tensors; i++) {
        if (strcmp(g_tensors[i].name, name) == 0)
            return &g_tensors[i];
    }
    return NULL;
}

/* ── ggml weight setup ──────────────────────────────────────────────────────── */
static void setup_weights(void) {
    /* Weight context: just metadata, data lives in g_shard_buf */
    size_t wctx_size = (size_t)g_n_tensors * ggml_tensor_overhead() + 4096;
    void *wctx_buf = malloc(wctx_size);
    if (!wctx_buf) die("oom for weight context");

    struct ggml_init_params p = {
        .mem_size   = wctx_size,
        .mem_buffer = wctx_buf,
        .no_alloc   = true,    /* we set tensor->data manually */
    };
    g_wctx = ggml_init(p);
    if (!g_wctx) die("ggml_init failed for weight context");

    /* Create ggml tensors for all shard entries — data points into shard buf */
    for (int i = 0; i < g_n_tensors; i++) {
        TensorRecord *rec = &g_tensors[i];
        struct ggml_tensor *t = NULL;

        if (rec->ndim == 1) {
            t = ggml_new_tensor_1d(g_wctx, (enum ggml_type)rec->ggml_type, rec->dims[0]);
        } else if (rec->ndim == 2) {
            t = ggml_new_tensor_2d(g_wctx, (enum ggml_type)rec->ggml_type,
                                   rec->dims[0], rec->dims[1]);
        } else {
            die_fmt("unsupported tensor ndim %d for %s", rec->ndim, rec->name);
        }
        if (!t) die_fmt("ggml_new_tensor failed for %s", rec->name);
        t->data   = g_shard_buf + rec->data_offset;
        rec->tensor = t;
    }

    /* Wire up per-layer tensor pointers */
    for (int li = cfg.layer_start; li <= cfg.layer_end; li++) {
        int slot = li - cfg.layer_start;
        LayerTensors *lt = &g_layers[slot];
        char name[MAX_NAME_LEN];

#define LOOKUP(field, suffix) \
    snprintf(name, sizeof(name), "blk.%d." suffix, li); \
    { TensorRecord *r = find_tensor(name); \
      if (!r) die_fmt("missing tensor: %s", name); \
      lt->field = r->tensor; }

#define LOOKUP_OPT(field, suffix) \
    snprintf(name, sizeof(name), "blk.%d." suffix, li); \
    { TensorRecord *r = find_tensor(name); \
      lt->field = r ? r->tensor : NULL; }

        LOOKUP(attn_norm,  "attn_norm.weight");
        LOOKUP(wq,         "attn_q.weight");
        LOOKUP(wk,         "attn_k.weight");
        LOOKUP(wv,         "attn_v.weight");
        LOOKUP(wo,         "attn_output.weight");
        LOOKUP(ffn_norm,   "ffn_norm.weight");
        LOOKUP(ffn_gate,   "ffn_gate.weight");
        LOOKUP(ffn_up,     "ffn_up.weight");
        LOOKUP(ffn_down,   "ffn_down.weight");

        LOOKUP_OPT(bq, "attn_q.bias");
        LOOKUP_OPT(bk, "attn_k.bias");
        LOOKUP_OPT(bv, "attn_v.bias");

#undef LOOKUP
#undef LOOKUP_OPT
    }

    fprintf(stderr, "[circuit-runner] weights set up for layers %d-%d\n",
            cfg.layer_start, cfg.layer_end);
}

/* ── Per-session KV cache management ────────────────────────────────────────── */
/* Allocate a slot's KV buffers. Returns 0 on success, -1 on OOM (caller rejects
 * the session gracefully rather than the whole process dying). */
static int _kv_slot_alloc(KVSession *s) {
    int n = cfg.n_local_layers;
    s->kv_k = calloc(n, sizeof(float *));
    s->kv_v = calloc(n, sizeof(float *));
    if (!s->kv_k || !s->kv_v) { free(s->kv_k); free(s->kv_v); s->kv_k = s->kv_v = NULL; return -1; }
    size_t per_layer = (size_t)cfg.max_seq * cfg.n_kv_heads * cfg.head_dim;
    for (int i = 0; i < n; i++) {
        s->kv_k[i] = calloc(per_layer, sizeof(float));
        s->kv_v[i] = calloc(per_layer, sizeof(float));
        if (!s->kv_k[i] || !s->kv_v[i]) return -1;  /* partial alloc freed at exit */
    }
    s->last_pos = -1;
    return 0;
}

static void _kv_slot_reset(KVSession *s) {
    size_t per_layer = (size_t)cfg.max_seq * cfg.n_kv_heads * cfg.head_dim;
    for (int i = 0; i < cfg.n_local_layers; i++) {
        memset(s->kv_k[i], 0, per_layer * sizeof(float));
        memset(s->kv_v[i], 0, per_layer * sizeof(float));
    }
    s->last_pos = -1;
}

/* Init scores buffer + session table; KV slots are allocated lazily on first use. */
static void alloc_kv_cache(void) {
    g_scores = calloc((size_t)cfg.max_seq, sizeof(float));
    if (!g_scores) die("oom for scores buffer");
    g_sessions = calloc((size_t)cfg.max_sessions, sizeof(KVSession));
    if (!g_sessions) die("oom for session table");
}

/* Return the KVSession for session_id, allocating or LRU-evicting a slot as needed.
 * Returns NULL only if a fresh slot's KV buffers can't be allocated (OOM) — the
 * caller rejects that one session instead of crashing the worker. A returned slot
 * with last_pos == -1 has no attention history (fresh or just evicted); the caller
 * compares last_pos against pos-1 to detect a continuation whose history was lost. */
static KVSession *get_session(uint32_t session_id) {
    /* 1. Find existing slot for this session */
    for (int i = 0; i < cfg.max_sessions; i++) {
        if (g_sessions[i].id == session_id && g_sessions[i].kv_k) {
            g_sessions[i].clock = ++g_kv_clock;
            return &g_sessions[i];
        }
    }
    /* 2. Claim a free slot */
    for (int i = 0; i < cfg.max_sessions; i++) {
        if (!g_sessions[i].kv_k) {
            if (_kv_slot_alloc(&g_sessions[i]) != 0) {
                fprintf(stderr, "[circuit-runner] KV: alloc failed for session %u (OOM)\n", session_id);
                return NULL;
            }
            g_sessions[i].id    = session_id;
            g_sessions[i].clock = ++g_kv_clock;
            return &g_sessions[i];
        }
    }
    /* 3. LRU evict the slot with the smallest clock */
    int lru = 0;
    for (int i = 1; i < cfg.max_sessions; i++) {
        if (g_sessions[i].clock < g_sessions[lru].clock) lru = i;
    }
    fprintf(stderr, "[circuit-runner] KV: evicting session %u for %u\n",
            g_sessions[lru].id, session_id);
    g_sessions[lru].id    = session_id;
    g_sessions[lru].clock = ++g_kv_clock;
    _kv_slot_reset(&g_sessions[lru]);  /* sets last_pos = -1 */
    return &g_sessions[lru];
}

/* ── GPU weight upload (CUDA path) ──────────────────────────────────────────── */
#ifdef GGML_USE_CUDA
/*
 * After setup_weights() fills g_wctx with CPU-backed tensors, this function:
 *   1. Initialises the CUDA backend.
 *   2. Allocates one contiguous VRAM buffer for every weight tensor.
 *   3. Uploads the quantized weights from g_shard_buf to VRAM.
 *   4. Re-points F32 tensors (norm weights, biases) back to g_shard_buf so
 *      forward_layer() can still access them as plain CPU pointers.
 *   5. Pre-allocates a GPU I/O tensor (g_cuda_xv) for matmul inputs.
 *   6. Creates a gallocr that allocates result tensors in VRAM on demand.
 */
static void upload_weights_to_gpu(void) {
    g_cuda_backend = ggml_backend_cuda_init(cfg.cuda_device);
    if (!g_cuda_backend)
        die_fmt("CUDA: failed to init backend on device %d", cfg.cuda_device);
    fprintf(stderr, "[circuit-runner] CUDA: backend initialised on device %d\n",
            cfg.cuda_device);

    /* Save CPU data pointers — they point into g_shard_buf (set by setup_weights). */
    void  *cpu_ptrs [MAX_TENSORS];
    size_t cpu_sizes[MAX_TENSORS];
    for (int i = 0; i < g_n_tensors; i++) {
        cpu_ptrs [i] = g_tensors[i].tensor->data;
        cpu_sizes[i] = ggml_nbytes(g_tensors[i].tensor);
    }

    /* ggml_backend_alloc_ctx_tensors() only allocates tensors whose ->data is NULL
     * (it treats a set ->data as "already allocated" and skips it). setup_weights()
     * pointed every tensor at the shard buffer, so without clearing them the
     * allocator finds nothing to allocate and returns NULL. Clear them now; we
     * re-upload from the saved cpu_ptrs immediately after. */
    for (int i = 0; i < g_n_tensors; i++) g_tensors[i].tensor->data = NULL;

    /* Allocate one VRAM buffer covering all weight tensors. */
    g_gpu_weight_buf = ggml_backend_alloc_ctx_tensors(g_wctx, g_cuda_backend);
    if (!g_gpu_weight_buf) die("CUDA: failed to allocate VRAM for weights");

    /* Upload every tensor from the shard buffer to VRAM. */
    for (int i = 0; i < g_n_tensors; i++)
        ggml_backend_tensor_set(g_tensors[i].tensor, cpu_ptrs[i], 0, cpu_sizes[i]);

    /* F32 tensors (norm weights, Q/K/V biases) are accessed via raw ->data pointer
     * in forward_layer(); they must stay in CPU-addressable memory.
     * Re-point them to their original positions in the shard buffer. */
    for (int i = 0; i < g_n_tensors; i++) {
        TensorRecord *rec = &g_tensors[i];
        if (rec->tensor->type == GGML_TYPE_F32)
            rec->tensor->data = g_shard_buf + rec->data_offset;
    }

    /* Pre-allocate a GPU input tensor sized for the largest matmul we'll do.
     * matmul() creates a 2D view of this tensor at the correct in_dim each call. */
    int max_in = cfg.ffn_dim > cfg.hidden_dim ? cfg.ffn_dim : cfg.hidden_dim;
    size_t io_ctx_sz = 2 * ggml_tensor_overhead() + 256;
    void *io_mem = malloc(io_ctx_sz);
    if (!io_mem) die("oom for CUDA io context");

    struct ggml_init_params io_p = { io_ctx_sz, io_mem, true };
    g_cuda_io_ctx = ggml_init(io_p);
    g_cuda_xv     = ggml_new_tensor_2d(g_cuda_io_ctx, GGML_TYPE_F32, max_in, 1);
    g_cuda_io_buf = ggml_backend_alloc_ctx_tensors(g_cuda_io_ctx, g_cuda_backend);
    if (!g_cuda_io_buf) die("CUDA: failed to allocate GPU I/O buffer");

    /* Graph allocator that places result tensors in VRAM. */
    g_gallocr = ggml_gallocr_new(ggml_backend_cuda_buffer_type(cfg.cuda_device));
    if (!g_gallocr) die("CUDA: failed to create gallocr");

    /* Estimate VRAM used by weights. */
    size_t total_vram = 0;
    for (int i = 0; i < g_n_tensors; i++) total_vram += cpu_sizes[i];
    fprintf(stderr, "[circuit-runner] CUDA: %.1f MB weights in VRAM, ready\n",
            (double)total_vram / (1024.0 * 1024.0));
}
#endif  /* GGML_USE_CUDA */

/* ── Matrix multiply via ggml ───────────────────────────────────────────────── */
/*
 * Computes out = W × x using ggml (handles any quantized type in W).
 * W tensor shape in ggml convention: ne[0] = in_dim, ne[1] = out_dim.
 * x: float32 vector [in_dim]
 * out: float32 vector [out_dim] = W.ne[1]
 */
static void matmul(struct ggml_tensor *W, const float *x, float *out) {
    int in_dim  = (int)W->ne[0];
    int out_dim = (int)W->ne[1];

#ifdef GGML_USE_CUDA
    /*
     * GPU path: only for quantized weight matrices (F32 tensors stay on CPU).
     * g_cuda_xv is a pre-allocated VRAM tensor sized max(hidden_dim, ffn_dim).
     * We create a 2D view of it at the correct in_dim, upload the input vector,
     * build a tiny compute graph, let gallocr allocate the result in VRAM,
     * compute on the CUDA backend, then copy the result back to CPU.
     */
    if (g_cuda_backend && W->type != GGML_TYPE_F32) {
        int ok = 0;
        do {
            struct ggml_init_params p = {
                .mem_size   = SCRATCH_SIZE,
                .mem_buffer = g_scratch,
                .no_alloc   = true,   /* view tensors need no allocation */
            };
            struct ggml_context *ctx = ggml_init(p);
            if (!ctx) break;

            /* xv: 2D view of the pre-allocated GPU buffer at current in_dim */
            struct ggml_tensor *xv = ggml_view_2d(ctx, g_cuda_xv,
                (int64_t)in_dim, 1, (size_t)in_dim * sizeof(float), 0);

            /* Upload input to GPU (writes first in_dim floats; rest are unused) */
            ggml_backend_tensor_set(g_cuda_xv, x, 0, (size_t)in_dim * sizeof(float));

            /* W already in VRAM; xv is a view into GPU I/O buffer.
             * result will be allocated by gallocr into VRAM. */
            struct ggml_tensor *result = ggml_mul_mat(ctx, W, xv);
            struct ggml_cgraph *gf     = ggml_new_graph(ctx);
            ggml_build_forward_expand(gf, result);

            /* gallocr allocates result in VRAM; reuses existing allocation when
             * the output shape is unchanged (common case after first token). */
            if (!ggml_gallocr_alloc_graph(g_gallocr, gf)) { ggml_free(ctx); break; }

            enum ggml_status st = ggml_backend_graph_compute(g_cuda_backend, gf);
            if (st != GGML_STATUS_SUCCESS) { ggml_free(ctx); break; }

            ggml_backend_tensor_get(result, out, 0, (size_t)out_dim * sizeof(float));
            ggml_free(ctx);
            ok = 1;
        } while (0);

        if (ok) return;
        /* GPU compute failed — fall through to CPU path */
        fprintf(stderr, "[circuit-runner] WARN: GPU matmul failed, falling back to CPU\n");
    }
#endif  /* GGML_USE_CUDA */

    /* ── CPU path (original) ─────────────────────────────────────────────── */
    {
        struct ggml_init_params p = {
            .mem_size   = SCRATCH_SIZE,
            .mem_buffer = g_scratch,
            .no_alloc   = false,
        };
        struct ggml_context *ctx = ggml_init(p);
        if (!ctx) die("ggml_init scratch failed");

        struct ggml_tensor *xv = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, in_dim, 1);
        memcpy(xv->data, x, (size_t)in_dim * sizeof(float));

        struct ggml_tensor *result = ggml_mul_mat(ctx, W, xv);
        struct ggml_cgraph *gf     = ggml_new_graph(ctx);
        ggml_build_forward_expand(gf, result);
        ggml_graph_compute_with_ctx(ctx, gf, cfg.n_threads);

        memcpy(out, result->data, (size_t)out_dim * sizeof(float));
        ggml_free(ctx);
    }
}

/* ── Math helpers ───────────────────────────────────────────────────────────── */
static void rms_norm(const float *x, const float *weight, int n, float eps, float *out) {
    float ss = 0.0f;
    for (int i = 0; i < n; i++) ss += x[i] * x[i];
    float scale = 1.0f / sqrtf(ss / (float)n + eps);
    for (int i = 0; i < n; i++) out[i] = x[i] * scale * weight[i];
}

/* NeoX-style RoPE: pairs (x[i], x[i + n/2]) as used by Qwen2 */
static void apply_rope(float *x, int pos, int n_dims, float rope_base) {
    int half = n_dims / 2;
    for (int i = 0; i < half; i++) {
        float theta = (float)pos / powf(rope_base, 2.0f * (float)i / (float)n_dims);
        float cos_t = cosf(theta);
        float sin_t = sinf(theta);
        float v0 = x[i];
        float v1 = x[i + half];
        x[i]        = v0 * cos_t - v1 * sin_t;
        x[i + half] = v0 * sin_t + v1 * cos_t;
    }
}

/* In-place softmax over n elements */
static void softmax(float *x, int n) {
    float max_val = x[0];
    for (int i = 1; i < n; i++) if (x[i] > max_val) max_val = x[i];
    float sum = 0.0f;
    for (int i = 0; i < n; i++) { x[i] = expf(x[i] - max_val); sum += x[i]; }
    for (int i = 0; i < n; i++) x[i] /= sum;
}

/* In-place SiLU: x = x * sigmoid(x) */
static void silu_inplace(float *x, int n) {
    for (int i = 0; i < n; i++) x[i] = x[i] / (1.0f + expf(-x[i]));
}

/* ── Layer forward pass ─────────────────────────────────────────────────────── */
static void forward_layer(int slot, const float *hidden, int pos, float *out_hidden, float **kv_k, float **kv_v) {
    LayerTensors *lt = &g_layers[slot];
    int H  = cfg.hidden_dim;
    int Nh = cfg.n_heads;
    int Nk = cfg.n_kv_heads;
    int Dh = cfg.head_dim;
    int F  = cfg.ffn_dim;

    /* Temporary vectors — use pre-allocated global buffers (sized at startup) */
    float *x_norm   = g_x_norm;
    float *q        = g_q_buf;
    float *k        = g_k_buf;
    float *v        = g_v_buf;
    float *attn     = g_attn_buf;
    float *attn_out = g_ao_buf;

    /* ── Attention pre-norm ──────────────────────────────────────────────── */
    const float *norm_w = (const float *)lt->attn_norm->data;
    rms_norm(hidden, norm_w, H, cfg.rms_eps, x_norm);

    /* ── QKV projections ─────────────────────────────────────────────────── */
    matmul(lt->wq, x_norm, q);
    matmul(lt->wk, x_norm, k);
    matmul(lt->wv, x_norm, v);

    /* Add biases if present (Qwen2 has them, Llama does not) */
    if (lt->bq) {
        const float *b = (const float *)lt->bq->data;
        for (int i = 0; i < Nh * Dh; i++) q[i] += b[i];
    }
    if (lt->bk) {
        const float *b = (const float *)lt->bk->data;
        for (int i = 0; i < Nk * Dh; i++) k[i] += b[i];
    }
    if (lt->bv) {
        const float *b = (const float *)lt->bv->data;
        for (int i = 0; i < Nk * Dh; i++) v[i] += b[i];
    }

    /* ── RoPE on Q and K (NeoX-style, per head) ─────────────────────────── */
    for (int h = 0; h < Nh; h++)
        apply_rope(q + h * Dh, pos, Dh, cfg.rope_base);
    for (int h = 0; h < Nk; h++)
        apply_rope(k + h * Dh, pos, Dh, cfg.rope_base);

    /* ── Write K, V to cache at position pos ─────────────────────────────── */
    if (pos >= cfg.max_seq) {
        fprintf(stderr, "[circuit-runner] pos %d >= max_seq %d — KV write skipped\n",
                pos, cfg.max_seq);
        memcpy(out_hidden, hidden, (size_t)H * sizeof(float));
        return;
    }
    float *kc = kv_k[slot] + (size_t)pos * Nk * Dh;
    float *vc = kv_v[slot] + (size_t)pos * Nk * Dh;
    memcpy(kc, k, (size_t)Nk * Dh * sizeof(float));
    memcpy(vc, v, (size_t)Nk * Dh * sizeof(float));

    /* ── Grouped-query attention ─────────────────────────────────────────── */
    float scale = 1.0f / sqrtf((float)Dh);
    float *scores = g_scores;
    memset(attn, 0, (size_t)Nh * Dh * sizeof(float));

    for (int h = 0; h < Nh; h++) {
        /* Proportional mapping: always in [0, Nk) even when Nh % Nk != 0 */
        int kv_h = (h * Nk) / Nh;
        const float *q_h = q + h * Dh;
        float *ao_h = attn + h * Dh;

        /* Attention scores Q·K^T / sqrt(Dh) */
        for (int p = 0; p <= pos; p++) {
            const float *k_p = kv_k[slot] + (size_t)p * Nk * Dh + kv_h * Dh;
            float dot = 0.0f;
            for (int d = 0; d < Dh; d++) dot += q_h[d] * k_p[d];
            scores[p] = dot * scale;
        }
        softmax(scores, pos + 1);

        /* Weighted sum of values */
        for (int p = 0; p <= pos; p++) {
            const float *v_p = kv_v[slot] + (size_t)p * Nk * Dh + kv_h * Dh;
            float w = scores[p];
            for (int d = 0; d < Dh; d++) ao_h[d] += w * v_p[d];
        }
    }

    /* ── Output projection + residual ────────────────────────────────────── */
    matmul(lt->wo, attn, attn_out);
    for (int i = 0; i < H; i++) out_hidden[i] = hidden[i] + attn_out[i];

    /* ── FFN pre-norm ────────────────────────────────────────────────────── */
    const float *fnorm_w = (const float *)lt->ffn_norm->data;
    rms_norm(out_hidden, fnorm_w, H, cfg.rms_eps, x_norm);

    /* ── FFN: SwiGLU (gate + up → silu(gate) * up → down) + residual ────── */
    matmul(lt->ffn_gate, x_norm, g_gate_buf);
    matmul(lt->ffn_up,   x_norm, g_up_buf);

    silu_inplace(g_gate_buf, F);
    for (int i = 0; i < F; i++) g_gate_buf[i] *= g_up_buf[i];

    matmul(lt->ffn_down, g_gate_buf, g_ffn_buf);
    for (int i = 0; i < H; i++) out_hidden[i] += g_ffn_buf[i];
}

/* ── Argument parsing ───────────────────────────────────────────────────────── */
static void parse_args(int argc, char **argv) {
    /* Defaults */
    cfg.rope_base    = 10000.0f;
    cfg.max_seq      = MAX_SEQ_DEFAULT;
    cfg.n_threads    = 4;
    cfg.has_bias     = 0;
    cfg.rms_eps      = 1e-6f;
    cfg.max_sessions = DEFAULT_MAX_SESSIONS;

    for (int i = 1; i < argc; i++) {
#define NEXT_VAL(var, parse_fn) \
        if (i + 1 >= argc) die_fmt("missing value for %s", argv[i]); \
        var = parse_fn(argv[++i]);
#define NEXT_INT(var) NEXT_VAL(var, atoi)
#define NEXT_FLT(var) NEXT_VAL(var, atof)

        if (!strcmp(argv[i], "--shard")) {
            if (i + 1 >= argc) die("missing shard path");
            strncpy(cfg.shard_path, argv[++i], sizeof(cfg.shard_path) - 1);
        } else if (!strcmp(argv[i], "--hidden-dim")) {
            NEXT_INT(cfg.hidden_dim);
        } else if (!strcmp(argv[i], "--n-heads")) {
            NEXT_INT(cfg.n_heads);
        } else if (!strcmp(argv[i], "--n-kv-heads")) {
            NEXT_INT(cfg.n_kv_heads);
        } else if (!strcmp(argv[i], "--head-dim")) {
            NEXT_INT(cfg.head_dim);
        } else if (!strcmp(argv[i], "--ffn-dim")) {
            NEXT_INT(cfg.ffn_dim);
        } else if (!strcmp(argv[i], "--layers")) {
            if (i + 1 >= argc) die("missing layer range");
            char *range = argv[++i];
            if (sscanf(range, "%d:%d", &cfg.layer_start, &cfg.layer_end) != 2)
                die_fmt("invalid layer range: %s (expect S:E)", range);
        } else if (!strcmp(argv[i], "--rope-base")) {
            NEXT_FLT(cfg.rope_base);
        } else if (!strcmp(argv[i], "--max-seq")) {
            NEXT_INT(cfg.max_seq);
        } else if (!strcmp(argv[i], "--threads")) {
            NEXT_INT(cfg.n_threads);
        } else if (!strcmp(argv[i], "--has-bias")) {
            cfg.has_bias = 1;
        } else if (!strcmp(argv[i], "--rms-eps")) {
            NEXT_FLT(cfg.rms_eps);
        } else if (!strcmp(argv[i], "--gpu-layers")) {
            NEXT_INT(cfg.gpu_layers);
        } else if (!strcmp(argv[i], "--cuda-device")) {
            NEXT_INT(cfg.cuda_device);
        } else if (!strcmp(argv[i], "--max-sessions")) {
            NEXT_INT(cfg.max_sessions);
        } else {
            die_fmt("unknown argument: %s", argv[i]);
        }

#undef NEXT_VAL
#undef NEXT_INT
#undef NEXT_FLT
    }

    /* Validate required args */
    if (!cfg.shard_path[0]) die("--shard required");
    if (!cfg.hidden_dim)    die("--hidden-dim required");
    if (!cfg.n_heads)       die("--n-heads required");
    if (!cfg.n_kv_heads)    die("--n-kv-heads required");
    if (!cfg.head_dim)      die("--head-dim required");
    if (!cfg.ffn_dim)       die("--ffn-dim required");
    if (cfg.layer_end < cfg.layer_start) die("--layers: end must be >= start");
    if (cfg.max_sessions < 1) die("--max-sessions must be >= 1");

    cfg.n_local_layers = cfg.layer_end - cfg.layer_start + 1;
    cfg.kv_group       = cfg.n_heads / cfg.n_kv_heads;

    fprintf(stderr,
        "[circuit-runner] config: hidden=%d heads=%d kv_heads=%d head_dim=%d "
        "ffn=%d layers=%d:%d rope_base=%.0f max_seq=%d threads=%d bias=%d gpu_layers=%d "
        "max_sessions=%d\n",
        cfg.hidden_dim, cfg.n_heads, cfg.n_kv_heads, cfg.head_dim,
        cfg.ffn_dim, cfg.layer_start, cfg.layer_end, (double)cfg.rope_base,
        cfg.max_seq, cfg.n_threads, cfg.has_bias, cfg.gpu_layers, cfg.max_sessions);
}

/* ── Main ───────────────────────────────────────────────────────────────────── */
int main(int argc, char **argv) {
    parse_args(argc, argv);

    /* Allocate scratch buffer for ggml computation contexts */
    g_scratch = malloc(SCRATCH_SIZE);
    if (!g_scratch) die("oom for scratch buffer");

    /* Load shard and set up ggml weight tensors */
    load_shard(cfg.shard_path);
    setup_weights();

#ifdef GGML_USE_CUDA
    if (cfg.gpu_layers > 0) upload_weights_to_gpu();
#endif

    /* Allocate KV cache */
    alloc_kv_cache();

    /* Pre-allocate attention scratch buffers (avoids per-layer alloca) */
    int H = cfg.hidden_dim;
    g_x_norm   = malloc((size_t)H * sizeof(float));
    g_q_buf    = malloc((size_t)(cfg.n_heads    * cfg.head_dim) * sizeof(float));
    g_k_buf    = malloc((size_t)(cfg.n_kv_heads * cfg.head_dim) * sizeof(float));
    g_v_buf    = malloc((size_t)(cfg.n_kv_heads * cfg.head_dim) * sizeof(float));
    g_attn_buf = malloc((size_t)(cfg.n_heads    * cfg.head_dim) * sizeof(float));
    g_ao_buf   = malloc((size_t)H * sizeof(float));
    if (!g_x_norm || !g_q_buf || !g_k_buf || !g_v_buf || !g_attn_buf || !g_ao_buf)
        die("oom for attention scratch buffers");

    g_gate_buf = malloc((size_t)cfg.ffn_dim * sizeof(float));
    g_up_buf   = malloc((size_t)cfg.ffn_dim * sizeof(float));
    g_ffn_buf  = malloc((size_t)H * sizeof(float));
    if (!g_gate_buf || !g_up_buf || !g_ffn_buf)
        die("oom for ffn scratch buffers");
    float *hidden_in  = malloc((size_t)H * sizeof(float));
    float *hidden_out = malloc((size_t)H * sizeof(float));
    if (!hidden_in || !hidden_out) die("oom for hidden state buffers");

    fprintf(stderr, "[circuit-runner] ready, waiting for tokens\n");

    /* Flush stderr before entering loop */
    fflush(stderr);

    /* ── Token loop ──────────────────────────────────────────────────────── */
    for (;;) {
        uint32_t session_id, pos, hidden_len;

        /* Read 12-byte header: [4B session_id][4B pos][4B hidden_len] */
        read_exact(STDIN_FILENO, &session_id, 4);
        read_exact(STDIN_FILENO, &pos, 4);
        read_exact(STDIN_FILENO, &hidden_len, 4);

        if ((int)hidden_len != H) {
            fprintf(stderr, "[circuit-runner] WARN: unexpected hidden_len %u (expected %d)\n",
                    hidden_len, H);
            /* Drain the input to stay in sync */
            uint8_t *drain = malloc(hidden_len * sizeof(float));
            if (drain) { read_exact(STDIN_FILENO, drain, hidden_len * sizeof(float)); free(drain); }
            /* Write zeros to keep wire protocol alive */
            uint32_t out_len = (uint32_t)H;
            write_exact(STDOUT_FILENO, &out_len, 4);
            memset(hidden_out, 0, (size_t)H * sizeof(float));
            write_exact(STDOUT_FILENO, hidden_out, (size_t)H * sizeof(float));
            continue;
        }

        read_exact(STDIN_FILENO, hidden_in, (size_t)H * sizeof(float));

        /* Look up (or create) this session's KV cache slot */
        KVSession *sess = get_session(session_id);

        /* Refuse cleanly (out_len != H → worker.js forward error) when either:
         *  - the slot couldn't be allocated (OOM), or
         *  - this is a continuation token (pos > 0) whose KV history is missing or
         *    non-contiguous: the slot was LRU-evicted under load, or positions
         *    arrived out of order. Computing anyway would emit silently-wrong
         *    output, so we fail the request instead. */
        if (!sess || (pos != 0 && sess->last_pos != (int)pos - 1)) {
            fprintf(stderr, "[circuit-runner] session %u refused at pos %d "
                    "(%s)\n", session_id, pos,
                    !sess ? "alloc failed" : "no/!contiguous KV history — evicted under load?");
            uint32_t out_len = 0;  /* sentinel: != H signals error to worker.js */
            write_exact(STDOUT_FILENO, &out_len, 4);
            memset(hidden_out, 0, (size_t)H * sizeof(float));
            write_exact(STDOUT_FILENO, hidden_out, (size_t)H * sizeof(float));
            fflush(stdout);
            continue;
        }

        /* pos == 0 starts a new sequence — reset this session's KV cache */
        if (pos == 0) _kv_slot_reset(sess);

        /* Copy hidden state for in-place modification across layers */
        memcpy(hidden_out, hidden_in, (size_t)H * sizeof(float));

        /* Forward through all assigned layers using this session's KV cache */
        for (int li = cfg.layer_start; li <= cfg.layer_end; li++) {
            int slot = li - cfg.layer_start;
            float *in  = (li == cfg.layer_start) ? hidden_in : hidden_out;
            forward_layer(slot, in, (int)pos, hidden_out, sess->kv_k, sess->kv_v);
        }

        /* Record the position we just wrote so the next token's contiguity check
         * (and eviction detection) is accurate. */
        sess->last_pos = (int)pos;

        /* Write output */
        uint32_t out_len = (uint32_t)H;
        write_exact(STDOUT_FILENO, &out_len, 4);
        write_exact(STDOUT_FILENO, hidden_out, (size_t)H * sizeof(float));
        fflush(stdout);
    }

    return 0;
}
