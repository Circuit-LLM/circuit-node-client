// lib/chat.js — Node agent chat interface.
//
// Attaches a WebSocket server to the existing HTTP server.
//
// Chat is driven entirely by the connected circuit-agent. When agentDataPath is
// set in node config and the agent has LLM credentials (config/agent.json
// llm.openrouterKey or OPENROUTER_API_KEY env), the chat uses those — the
// node client has no LLM config of its own.
//
// If no agent is connected or the agent has no LLM key, the WS still accepts
// connections but immediately sends a "no-agent" message explaining the state.
//
// Config: config.chat
//   maxHistory: 20  — max messages retained per session (only setting needed)
//
// WebSocket protocol (text frames, JSON):
//   Client → Server: { type: "message", content: "your question" }
//   Server → Client: { type: "chunk",   content: "partial text" }   (streaming)
//   Server → Client: { type: "done" }                               (end of response)
//   Server → Client: { type: "error",   message: "..." }
//   Server → Client: { type: "context", nodeId, version, status, agentConnected, agentId, model }
//
'use strict';

const { WebSocketServer } = require('ws');
const { getSyncStatus }   = require('./sync');
const identity            = require('./identity');
const circuitAgent        = require('./circuit-agent');
const path                = require('path');

let _wss    = null;
let _config = null;

// ── Start ──────────────────────────────────────────────────────────────────────

function start(httpServer, config) {
  _config = config;

  _wss = new WebSocketServer({ server: httpServer, path: '/chat' });

  _wss.on('connection', (ws, req) => {
    // Only allow local connections (same machine)
    const ip = req.socket.remoteAddress;
    if (!_isLocal(ip)) {
      ws.close(4003, 'Remote connections not allowed');
      return;
    }

    // Resolve agent state fresh on each connection
    const aPath  = config.node?.agentDataPath ? path.resolve(config.node.agentDataPath) : null;
    const aCfg   = aPath ? circuitAgent.readConfig(aPath) : null;
    // Key resolution mirrors where the agent actually keeps it. The agent stores
    // OPENROUTER_API_KEY in its .env (loaded into the agent's OWN process), not in
    // agent.json — so we must read that .env here too, or the key is present on
    // disk yet invisible to chat. Order: config override → this process's env →
    // the agent's .env.
    const apiKey = aCfg?.llm?.openrouterKey
      || process.env.OPENROUTER_API_KEY
      || circuitAgent.readEnvVar(aPath, 'OPENROUTER_API_KEY')
      || null;
    const model  = aCfg?.llm?.model || 'x-ai/grok-4.1-fast';
    const aIdent = aPath ? circuitAgent.readJson(aPath, 'agent-identity.json') : null;

    const sync = getSyncStatus();

    // If no agent or no LLM key, tell the client and accept no messages
    if (!aCfg || !apiKey) {
      ws.send(JSON.stringify({
        type:           'no-agent',
        nodeId:         identity.nodeId.slice(0, 20) + '…',
        version:        config.node?.version ?? '0.1.0',
        status:         sync.status,
        reason:         !aPath ? 'agentDataPath not configured' : !aCfg ? 'agent config not found' : 'no OpenRouter key found — set OPENROUTER_API_KEY in the agent .env (or llm.openrouterKey in agent config)',
      }));
      return;
    }

    const session = { history: [], closed: false, aPath, aCfg, apiKey, model };

    ws.send(JSON.stringify({
      type:           'context',
      nodeId:         identity.nodeId.slice(0, 20) + '…',
      version:        config.node?.version ?? '0.1.0',
      status:         sync.status,
      model,
      agentConnected: true,
      agentId:        aIdent?.agentId ?? null,
    }));

    ws.on('message', async (raw) => {
      if (session.closed) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== 'message' || !msg.content?.trim()) return;

      await _handleMessage(ws, session, msg.content.trim(), config);
    });

    ws.on('close', () => { session.closed = true; });
    ws.on('error', () => { session.closed = true; });
  });

  console.log('[chat] WebSocket chat ready at ws://localhost:' + (config.node?.apiPort ?? 19000) + '/chat');
}

function stop() {
  if (_wss) { _wss.close(); _wss = null; }
}

// ── Message handler ────────────────────────────────────────────────────────────

async function _handleMessage(ws, session, content, config) {
  const maxHistory = config.chat?.maxHistory ?? 20;

  session.history.push({ role: 'user', content });

  if (session.history.length > maxHistory) {
    session.history = session.history.slice(-maxHistory);
  }

  try {
    await _streamLLM(ws, session, config);
  } catch (err) {
    _send(ws, { type: 'error', message: err.message });
  }
}

// ── LLM streaming (OpenRouter) ────────────────────────────────────────────────

async function _streamLLM(ws, session, config) {
  const sysPrompt = _buildAgentSystemPrompt(session.aPath, session.aCfg, config);

  const messages = [
    { role: 'system', content: sysPrompt },
    ...session.history,
  ];

  let res;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${session.apiKey}`,
        'Content-Type':  'application/json',
        'HTTP-Referer':  'https://circuitllm.xyz',
        'X-Title':       'CIRCUIT Agent Chat',
      },
      body: JSON.stringify({
        model:       session.model,
        messages,
        stream:      true,
        temperature: 0.7,
        max_tokens:  1024,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new Error('LLM request failed: ' + err.message);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 402 || errBody.includes('credit') || errBody.includes('insufficient')) {
      throw new Error('OpenRouter credits exhausted — top up at openrouter.ai to continue chatting with your agent.');
    }
    if (res.status === 401) {
      throw new Error('OpenRouter API key rejected — check llm.openrouterKey in your agent config.');
    }
    if (res.status === 429) {
      throw new Error('OpenRouter rate limit hit — try again in a moment.');
    }
    throw new Error(`LLM error ${res.status}: ${errBody.slice(0, 200)}`);
  }

  // Stream SSE response
  let assistantText = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') break;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }

      // OpenRouter sometimes returns 200 but embeds the error in the stream
      if (chunk.error) {
        const code = chunk.error.code ?? chunk.error.status ?? 0;
        const msg  = chunk.error.message ?? JSON.stringify(chunk.error);
        if (code === 402 || msg.toLowerCase().includes('credit') || msg.toLowerCase().includes('insufficient') || msg.toLowerCase().includes('balance')) {
          throw new Error('OpenRouter credits exhausted — top up at openrouter.ai to continue chatting with your agent.');
        }
        throw new Error(`LLM error ${code}: ${msg.slice(0, 200)}`);
      }

      const delta = chunk.choices?.[0]?.delta?.content ?? '';
      if (delta) {
        assistantText += delta;
        _send(ws, { type: 'chunk', content: delta });
      }
    }
  }

  if (assistantText) {
    session.history.push({ role: 'assistant', content: assistantText });
  }

  _send(ws, { type: 'done' });
}

// ── System prompts ─────────────────────────────────────────────────────────────

// Used when agentDataPath is configured — LLM speaks as the trading agent.
function _buildAgentSystemPrompt(aPath, aCfg, config) {
  const identity_  = circuitAgent.readJson(aPath, 'agent-identity.json') ?? {};
  const positions  = circuitAgent.readJson(aPath, 'positions.json') ?? {};
  const history    = circuitAgent.readJson(aPath, 'trade_history.json') ?? [];
  const strategy   = circuitAgent.readJson(aPath, 'session_strategy.json') ?? {};
  const notes      = circuitAgent.readJson(aPath, 'agent-notes.json') ?? [];
  const summary    = circuitAgent.readText(aPath, 'conversation_summary.md') ?? '';

  const openPos = Object.values(positions);
  const recent  = Array.isArray(history) ? history.slice(-20).reverse() : [];
  const strat   = aCfg?.strategy ?? {};

  // Summarise open positions
  const posLines = openPos.length
    ? openPos.map(p => `  ${p.symbol ?? p.mint?.slice(0,8)} — held ${_elapsed(p.entryTime)}, entry $${p.entryPrice ?? '?'}, P&L ${p.pnlPct != null ? p.pnlPct.toFixed(1) + '%' : 'n/a'}`).join('\n')
    : '  (none)';

  // Summarise recent trades
  const tradeLines = recent.slice(0, 10).map(t => {
    const side = t.exitTime ? 'SELL' : 'BUY';
    const pnl  = t.pnlSol != null ? (t.pnlSol >= 0 ? '+' : '') + t.pnlSol.toFixed(4) + ' SOL' : '';
    return `  ${side} ${t.symbol ?? '?'} ${pnl} (${t.reason ?? ''})`.trim();
  }).join('\n') || '  (none)';

  // Top notes (most recent per category)
  const noteLines = Array.isArray(notes)
    ? notes.slice(-5).map(n => `  [${n.category ?? 'note'}] ${n.value}`).join('\n')
    : '';

  return `You are a Solana trading agent running autonomously on the CIRCUIT network.
You are speaking directly with your operator through the node dashboard.
Answer in first person as the agent — not as an assistant explaining the agent.

IDENTITY:
  Agent ID: ${identity_.agentId ?? 'unknown'}
  Wallet:   ${identity_.address ?? 'unknown'}

CURRENT SESSION STRATEGY:
  Mode:           ${strategy.mode ?? 'unknown'}
  Pattern filter: ${JSON.stringify(strategy.patternFilter ?? [])}
  Min score:      ${strategy.minScoreOverride ?? strat.minScanScore ?? '?'}
  Goal:           ${strategy.sessionGoal ?? ''}
  Reasoning:      ${strategy.reasoning ?? ''}
  Expires:        ${strategy.expiresAt ?? 'n/a'}

OPEN POSITIONS (${openPos.length}):
${posLines}

RECENT TRADES:
${tradeLines}

TRADING CONFIG:
  Entry budget:     ${strat.entryBudgetSol ?? '?'} SOL
  Stop loss:        ${strat.stopLossPct ?? '?'}%
  Take profit:      ${strat.takeProfitPct ?? '?'}%
  Max hold:         ${strat.maxHoldMinutes ?? '?'} min
  Min liquidity:    $${strat.minLiquidity ?? '?'}
  Max open pos:     ${strat.maxOpenPositions ?? '?'}
  Trailing stop:    activates at +${strat.trailingStopActivatePct ?? '?'}%, trails ${strat.trailingStopDistancePct ?? '?'}%

MEMORY / LEARNED PATTERNS:
${noteLines || '  (none yet)'}

RECENT SESSION SUMMARY:
${summary.slice(0, 800) || '  (none)'}

Respond as the agent. Be direct and honest about performance, current state, and reasoning.
If asked what you're doing or why, explain your current strategy and position rationale.
If asked to change config or strategy, explain what you'd recommend and why — but note that
changes require restarting with updated config/agent.local.json.`;
}

function _elapsed(isoTs) {
  if (!isoTs) return '?';
  const ms = Date.now() - new Date(isoTs).getTime();
  const m  = Math.floor(ms / 60000);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
}

// ── Generic helpers ───────────────────────────────────────────────────────────

function _send(ws, obj) {
  try {
    if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(obj));
  } catch {}
}

function _isLocal(ip) {
  return !ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

module.exports = { start, stop };
