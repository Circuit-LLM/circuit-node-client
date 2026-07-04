/* Circuit Node desktop — frontend logic.
 * Talks to the node ONLY through the Rust `node_api` proxy (no CORS, no port/token in JS).
 * The node-client is the source of truth for everything compute/network; this is a thin shell. */
'use strict';

const T = window.__TAURI__ || {};
const invoke = T.core ? T.core.invoke : async () => { throw new Error('not in Tauri'); };
const listen = T.event ? T.event.listen : async () => {};

// ── low-level bridges ──────────────────────────────────────────────
async function api(method, path, body) {
  // returns {status, ok, body} — throws only if the sidecar is unreachable
  return invoke('node_api', { method, path, body: body ?? null });
}
const get  = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b);

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
// Escape any value that crosses a trust boundary (user input, or strings from the network /
// control plane) before it goes into an innerHTML template — defense-in-depth against XSS.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
const store = { get: (k, f) => { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } },
                set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

let NODE = { port: 19000, running: false };
let SETUP = null;         // last /setup/status
let payoutWallet = store.get('payoutWallet', '');

// ── views ──────────────────────────────────────────────────────────
function show(view) {
  ['boot', 'picker', 'dash'].forEach(v => { const n = $('#' + v); if (n) n.hidden = (v !== view); });
}

// ── boot: wait for the sidecar, then route ─────────────────────────
async function boot() {
  applyTheme(store.get('theme', 'auto'));
  try { NODE = await invoke('node_info_cmd'); } catch {}
  const status = $('#boot-status');
  for (let i = 0; i < 60; i++) {
    try {
      const h = await get('/health');
      if (h.ok) { await afterUp(); return; }
    } catch { /* sidecar not listening yet */ }
    if (i === 8) status.textContent = 'the node is taking a moment to come up…';
    if (i === 25) status.textContent = 'still starting — first run initializes your node identity…';
    await sleep(700);
  }
  bootFailed();
}

function bootFailed() {
  const boot = $('#boot');
  boot.classList.add('failed');            // CSS hides the (misleading) progress bar
  $('#boot-status').textContent = 'Could not reach the node.';
  if (!$('#boot-retry')) {
    const b = el('button', 'btn'); b.id = 'boot-retry'; b.textContent = 'Retry';
    b.style.marginTop = '16px';
    b.onclick = async () => {
      b.remove(); boot.classList.remove('failed');
      $('#boot-status').textContent = 'restarting the node…';
      try { await invoke('restart_node'); } catch {}   // nudge a node that gave up (crash backstop)
      boot();
    };
    boot.appendChild(b);
  }
}

async function afterUp() {
  try { NODE = await invoke('node_info_cmd'); } catch {}
  SETUP = (await get('/setup/status')).body;
  const connected = SETUP?.cpu?.connected || SETUP?.gpu?.connected;
  wireStatic();
  if (connected) { openDash(); } else { openPicker(); }
  checkUpdate();
}

// ── picker ─────────────────────────────────────────────────────────
async function openPicker() {
  show('picker');
  try {
    const node = (await get('/node')).body;
    $('#picker-node').textContent = `node ${String(node.nodeId || '').slice(0, 16)}… · v${node.version || NODE.app_version}`;
  } catch {}
}
$$('.mode-card').forEach(c => c.addEventListener('click', () => {
  const mode = c.dataset.mode;
  if (mode === 'cpu') wizardCpu(); else wizardGpu();
}));

// ── dashboard ──────────────────────────────────────────────────────
let pollTimer = null;
function openDash() {
  show('dash');
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 5000);
}

async function refresh() {
  if ($('#dash').hidden) return;
  try {
    SETUP = (await get('/setup/status')).body;
    renderCpu(); renderGpu(); renderSettings();
    NODE.running = true;
  } catch { markNodeDown(); return; }
  $('#node-pill').textContent = `node · v${NODE.app_version || ''}`;
  $('#node-pill').className = 'pill ok';
  renderEarnings(); renderNetwork();
}

function markNodeDown() {
  const p = $('#node-pill'); if (p) { p.textContent = 'node offline'; p.className = 'pill bad'; }
}
// Solana base58 address shape — matches the node's own isValidWallet gate (server.js), so we can
// reject a typo inline instead of surfacing the node's 400 as a vague "couldn't read balance".
const isSolAddr = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

// ---- CPU card ----
function renderCpu() {
  const c = SETUP.cpu || {};
  const on = !!c.connected && c.host?.running;
  const chip = $('#cpu-chip');
  chip.textContent = on ? 'hosting' : (c.hostPresent ? 'ready' : 'not set up');
  chip.className = 'chip ' + (on ? 'on' : (c.hostPresent ? '' : 'off'));
  const b = $('#cpu-body'); b.innerHTML = '';
  if (on) {
    const h = c.host || {};
    const bud = h.budget || {};
    b.append(
      stat('Hosting as', h.nodeId || '—'),
      stat('Budget', `${bud.maxAgents ?? '?'} agents · ${bud.maxCpu ?? '?'} cores · ${bud.maxMemoryMb ?? '?'} MB`),
      stat('Control plane', short(h.controlPlane)),
      stat('Restarts', h.restarts ?? 0),
    );
    const stop = el('button', 'btn danger row', 'Stop hosting');
    stop.onclick = async () => { await post('/cloud/host/stop'); toast('Stopped hosting'); refresh(); };
    b.append(stop);
  } else {
    b.append(el('p', 'hint', 'Lend spare CPU to host other people’s agents under a budget you set. No GPU or Docker needed — keys stay off your box.'));
    const go = el('button', 'btn row', c.hostPresent ? 'Start hosting agents' : 'Set up CPU hosting');
    go.onclick = wizardCpu;
    b.append(go);
  }
}

// ---- GPU card ----
function renderGpu() {
  const g = SETUP.gpu || {};
  const on = !!g.connected && g.worker?.running;
  const chip = $('#gpu-chip');
  chip.textContent = on ? 'serving' : (g.present ? 'ready' : 'no GPU');
  chip.className = 'chip ' + (on ? 'on' : (g.present ? '' : 'off'));
  const b = $('#gpu-body'); b.innerHTML = '';
  if (on) {
    const w = g.worker || {};
    b.append(
      stat('Role', w.role || 'gpu-worker'),
      stat('Layers held', w.capacityLayers ?? w.layers ?? '—'),
      stat('GPU', g.info ? `${g.info.name} · ${fmt(g.info.vramMb)} MB` : '—'),
      stat('Restarts', w.restarts ?? 0),
    );
    const stop = el('button', 'btn danger row', 'Stop serving');
    stop.onclick = async () => { await post('/dllm/worker/stop'); toast('Stopped GPU worker'); refresh(); };
    b.append(stop);
  } else if (g.present) {
    b.append(
      stat('GPU', g.info ? `${g.info.name} · ${fmt(g.info.vramMb)} MB` : 'detected'),
      el('p', 'hint', 'Your GPU can hold a slice of the decentralized model and serve inference.'),
    );
    const go = el('button', 'btn row', 'Join the inference mesh');
    go.onclick = wizardGpu; b.append(go);
  } else {
    b.append(el('p', 'hint', 'No NVIDIA GPU detected on this machine, so the inference mesh isn’t available here — but you can still contribute with CPU agent hosting.'));
    const go = el('button', 'btn ghost row', 'Use CPU hosting instead');
    go.onclick = wizardCpu; b.append(go);
  }
}

// ---- Earnings ----
let _earnBusy = false, _earnShown = false;
async function renderEarnings() {
  if (_earnBusy) return;                    // don't overlap a slow (15s RPC) in-flight poll
  const b = $('#earn-body'); const w = payoutWallet || SETUP?.cpu?.payoutWallet || SETUP?.gpu?.payoutWallet;
  if (!w) {
    _earnShown = false; b.innerHTML = '';
    b.append(el('p', 'hint', 'Set a payout wallet to track CIRC earnings from hosting and inference.'));
    const set = el('button', 'btn ghost row', 'Set payout wallet'); set.onclick = setWalletModal; b.append(set);
    return;
  }
  if (!_earnShown) { b.innerHTML = ''; b.append(el('div', 'big', '…')); }  // only blank on first paint
  _earnBusy = true;
  try {
    const e = (await get('/earnings?wallet=' + encodeURIComponent(w))).body;
    const rows = document.createDocumentFragment();
    rows.append(el('div', 'big', fmt(e.balance, 2) + ' CIRC'));
    rows.append(stat('Recent payouts', e.payouts?.length ? `${e.payouts.length} · +${fmt(e.received, 2)} CIRC` : 'none yet'));
    rows.append(stat('Wallet', short(w)));
    const qr = el('button', 'link sm', 'Show address QR'); qr.onclick = () => qrModal(w); rows.append(qr);
    b.innerHTML = ''; b.append(rows); _earnShown = true;   // atomic swap — no flicker, keeps last value on failure
  } catch {
    if (!_earnShown) { b.innerHTML = ''; b.append(el('p', 'hint', 'Could not read on-chain balance right now.')); }
  } finally { _earnBusy = false; }
}

// ---- Network ----
let _netBusy = false;
async function renderNetwork() {
  if (_netBusy) return; _netBusy = true;
  const b = $('#net-body'); const rows = document.createDocumentFragment();
  try {
    const hub = (await get('/network/hub')).body;
    const np = $('#net-pill'); if (np) { np.textContent = hub.reachable ? 'network · online' : 'network · offline'; np.className = 'pill ' + (hub.reachable ? 'ok' : 'bad'); }
    const nc = $('#netcard-chip'); if (nc) { nc.textContent = hub.reachable ? 'online' : 'offline'; nc.className = 'chip ' + (hub.reachable ? 'on' : 'off'); }
    rows.append(stat('Registry', hub.reachable ? 'reachable' : (hub.error || 'unreachable')));
  } catch {}
  try {
    const cloud = (await get('/cloud/status')).body;
    if (cloud?.cloud?.reachable) rows.append(stat('Agent cloud', `${fmt(cloud.cloud.agentsRunning)}/${fmt(cloud.cloud.agents)} agents · ${fmt(cloud.cloud.nodesUp)} nodes`));
  } catch {}
  try {
    const dllm = (await get('/dllm/info')).body;
    if (dllm?.mesh) {
      const m = dllm.mesh; const nodes = m.nodes ?? m.holders ?? m.workers;
      if (nodes != null) rows.append(stat('Inference mesh', `${fmt(nodes)} nodes` + (m.coverage != null ? ` · ${fmt(m.coverage * 100, 0)}% coverage` : '')));
    }
    if (dllm?.model) rows.append(stat('Model', dllm.model));
  } catch {}
  b.innerHTML = '';
  if (rows.childNodes.length) b.append(rows); else b.append(el('p', 'empty', 'network stats unavailable'));
  _netBusy = false;
}

// ---- Settings ----
async function renderSettings() {
  const b = $('#set-body'); b.innerHTML = '';
  b.append(stat('Node version', 'v' + (NODE.app_version || '')));
  b.append(stat('Data folder', short(NODE.home)));
  // autostart toggle
  let autostart = false; try { autostart = await invoke('get_autostart'); } catch {}
  const rowA = el('div', 'stat-row');
  rowA.append(el('span', 'k', 'Launch on login'));
  const tog = el('button', 'link', autostart ? 'On' : 'Off');
  tog.onclick = async () => { try { await invoke('set_autostart', { enabled: !autostart }); toast(!autostart ? 'Will launch on login' : 'Autostart off'); renderSettings(); } catch (e) { toast('Autostart not available'); } };
  rowA.append(tog); b.append(rowA);

  const g = el('div', 'btn-group');
  const web = el('button', 'btn ghost sm', 'Open web dashboard');
  web.onclick = () => invoke('open_url', { url: `http://localhost:${NODE.port}/` });
  const wal = el('button', 'btn ghost sm', payoutWallet ? 'Change payout wallet' : 'Set payout wallet');
  wal.onclick = setWalletModal;
  const rst = el('button', 'btn ghost sm', 'Restart node');
  rst.onclick = async () => { try { await invoke('restart_node'); toast('Node restarting…'); } catch {} };
  const logs = el('button', 'btn ghost sm', 'GPU logs');
  logs.onclick = logsModal;
  g.append(web, wal, rst, logs); b.append(g);
}

// ── CPU connect wizard ─────────────────────────────────────────────
async function wizardCpu() {
  const c = SETUP?.cpu || (await get('/setup/status')).body.cpu;
  if (!c.hostPresent) {
    // try one-click vendor from a local checkout; otherwise guide.
    modal(`<h2>Set up CPU hosting</h2><div class="sub">Fetching the agent-host…</div>`);
    const r = await post('/setup/install/cpu').catch(() => ({ ok: false, body: {} }));
    if ($('#modal').hidden) return;   // user closed the loading modal mid-request — don't reopen unbidden
    if (!r.ok || !r.body?.present) {
      const hint = r.body?.hint || 'Place a circuit-agent-cloud checkout in your home folder, or install the host package.';
      modal(`<h2>CPU hosting needs a one-time setup</h2>
        <div class="sub">Hosting runs other users’ agents on your machine under a budget you set. The agent-host isn’t bundled yet, so it has to be installed once — after that it’s click-to-start.</div>
        <div class="step"><span class="n">i</span><div>${esc(hint)}</div></div>
        <div id="recheck-note" class="hint" style="color:var(--red)" hidden>Still not found — the host package isn’t in place yet.</div>
        <div class="btn-group"><button class="btn" id="dl">Open downloads</button><button class="btn ghost" id="rechk">Re-check</button></div>`);
      $('#dl').onclick = () => invoke('open_url', { url: 'https://github.com/Circuit-LLM/circuit-node-client/releases' });
      $('#rechk').onclick = async () => {
        const rr = await post('/setup/install/cpu').catch(() => ({ ok: false, body: {} }));
        if (rr.ok && rr.body?.present) wizardCpu();      // now present → proceed to budget
        else $('#recheck-note').hidden = false;          // no silent identical-modal reloop
      };
      return;
    }
  }
  const p = (SETUP?.cpu || c).presets || {};
  const m = p.machine || {};
  let preset = 'balanced';
  modal(`<h2>Host agents</h2>
    <div class="sub">Pick how much of this ${m.cores ? m.cores + '-core' : ''} machine to lend. Agents run under a hard budget; their keys never touch your box.</div>
    <div class="seg" id="seg">
      ${['light', 'balanced', 'max'].map(k => `<button data-k="${k}" class="${k === preset ? 'sel' : ''}">${k}<span class="n">${p[k]?.maxAgents ?? '?'} agents · ${p[k]?.maxCpu ?? '?'} cores</span></button>`).join('')}
    </div>
    <label class="fld">Payout wallet (optional)<input id="wallet" placeholder="Solana address" value="${esc(payoutWallet)}" /></label>
    <button class="btn row" id="start">Start hosting</button>`);
  $$('#seg button').forEach(x => x.onclick = () => { preset = x.dataset.k; $$('#seg button').forEach(y => y.classList.toggle('sel', y === x)); });
  $('#start').onclick = async () => {
    const wallet = $('#wallet').value.trim();
    if (wallet && !isSolAddr(wallet)) { toast('That doesn’t look like a Solana address'); return; }
    if (wallet) { payoutWallet = wallet; store.set('payoutWallet', wallet); }
    $('#start').disabled = true; $('#start').textContent = 'Starting…';
    const r = await post('/cloud/host/start', { preset, payoutWallet: wallet }).catch(e => ({ ok: false }));
    if (r.ok) { closeModal(); toast('Hosting started'); await refresh(); openDash(); }
    else { $('#start').disabled = false; $('#start').textContent = 'Start hosting'; toast('Could not start hosting'); }
  };
}

// ── GPU connect wizard ─────────────────────────────────────────────
async function wizardGpu() {
  SETUP = (await get('/setup/status')).body;
  const g = SETUP.gpu || {};
  if (!g.present) {
    modal(`<h2>No NVIDIA GPU here</h2>
      <div class="sub">The inference mesh needs an NVIDIA GPU. This machine doesn’t have one — but CPU agent hosting works on any computer and earns too.</div>
      <button class="btn row" id="tocpu">Set up CPU hosting instead</button>`);
    $('#tocpu').onclick = wizardCpu; return;
  }
  if (!g.enginePresent) {
    let gpuDocker = {}; try { gpuDocker = (await get('/gpu/status')).body; } catch {}
    if (gpuDocker.present) {
      // A GPU node container from the one-click installer exists — just start it.
      modal(`<h2>GPU node found</h2>
        <div class="sub">A Circuit GPU node container is installed (${esc(g.info?.name || 'GPU')}). Start it to begin serving inference.</div>
        <button class="btn row" id="start">Start GPU node</button>`);
      $('#start').onclick = async () => { const r = await post('/gpu/start').catch(() => ({ ok: false })); if (r.ok) { closeModal(); toast('GPU node starting'); refresh(); openDash(); } else toast('Could not start container'); };
      return;
    }
    modal(`<h2>Provision the GPU engine</h2>
      <div class="sub">Serving inference needs the Circuit engine (Docker + model) on this box. This is the one heavier step — follow the desktop GPU guide, then come back.</div>
      <div class="step"><span class="n">1</span><div>Install Docker + NVIDIA container toolkit (WSL2 on Windows).</div></div>
      <div class="step"><span class="n">2</span><div>Run the one-click GPU join to pull the engine + model.</div></div>
      <div class="btn-group"><button class="btn" id="guide">Open GPU setup guide</button><button class="btn ghost" id="rechk">I’ve done it</button></div>`);
    $('#guide').onclick = () => invoke('open_url', { url: 'https://circuitllm.xyz/join' });
    $('#rechk').onclick = wizardGpu;
    return;
  }
  // Engine present → pick capacity and start the worker.
  const p = g.presets || {};
  let preset = 'balanced';
  modal(`<h2>Join the inference mesh</h2>
    <div class="sub">Choose how much of ${esc(g.info?.name || 'your GPU')} (${fmt(g.info?.vramMb)} MB) to lend. More layers = bigger slice of the model + bigger share.</div>
    <div class="seg" id="seg">
      ${['light', 'balanced', 'max'].map(k => `<button data-k="${k}" class="${k === preset ? 'sel' : ''}">${k}<span class="n">${p[k] ?? '?'} layers</span></button>`).join('')}
    </div>
    <label class="fld">Payout wallet (optional)<input id="wallet" placeholder="Solana address" value="${esc(payoutWallet)}" /></label>
    <button class="btn row" id="start">Start serving</button>`);
  $$('#seg button').forEach(x => x.onclick = () => { preset = x.dataset.k; $$('#seg button').forEach(y => y.classList.toggle('sel', y === x)); });
  $('#start').onclick = async () => {
    const wallet = $('#wallet').value.trim();
    if (wallet && !isSolAddr(wallet)) { toast('That doesn’t look like a Solana address'); return; }
    if (wallet) { payoutWallet = wallet; store.set('payoutWallet', wallet); }
    $('#start').disabled = true; $('#start').textContent = 'Starting…';
    const r = await post('/dllm/worker/start', { preset, payoutWallet: wallet }).catch(() => ({ ok: false }));
    if (r.ok) { closeModal(); toast('GPU worker starting'); await refresh(); openDash(); }
    else { $('#start').disabled = false; $('#start').textContent = 'Start serving'; toast('Could not start the worker'); }
  };
}

// ── small modals ───────────────────────────────────────────────────
function setWalletModal() {
  modal(`<h2>Payout wallet</h2><div class="sub">Your Solana address. Earnings settle here; the app only ever reads the public balance.</div>
    <label class="fld">Address<input id="w" value="${esc(payoutWallet)}" placeholder="Solana address" /></label>
    <div id="werr" class="hint" style="color:var(--red)" hidden>That doesn’t look like a Solana address.</div>
    <button class="btn row" id="save">Save</button>`);
  $('#save').onclick = () => {
    const val = $('#w').value.trim();
    if (val && !isSolAddr(val)) { $('#werr').hidden = false; return; }
    payoutWallet = val; store.set('payoutWallet', payoutWallet); closeModal(); toast('Wallet saved'); renderEarnings();
  };
}
async function qrModal(w) {
  modal(`<h2>Payout address</h2><div class="sub mono" style="word-break:break-all">${esc(w)}</div><div id="qr" style="margin-top:14px;display:flex;justify-content:center"></div>`);
  try { const r = await get('/qr?data=' + encodeURIComponent(w)); $('#qr').innerHTML = r.body.raw || ''; $('#qr svg') && ($('#qr svg').style.maxWidth = '220px'); } catch {}
}
async function logsModal() {
  modal(`<h2>GPU node logs</h2><div class="sub">Recent container output.</div><div class="logbox" id="lg">loading…</div>`);
  try { const r = await get('/gpu/logs?tail=120'); $('#lg').textContent = r.body.text || r.body.error || 'no logs (GPU node not installed)'; }
  catch { $('#lg').textContent = 'logs unavailable'; }
}

// ── update ─────────────────────────────────────────────────────────
async function checkUpdate() {
  try {
    const u = await invoke('check_app_update');
    if (u.available && u.latest) {
      $('#update-text').textContent = `Update available — v${u.current} → v${u.latest}. Updating keeps your node current on the network.`;
      $('#update-banner').hidden = false;
      $('#update-btn').onclick = () => invoke('open_url', { url: u.url || 'https://github.com/Circuit-LLM/circuit-node-client/releases' });
      $('#update-dismiss').onclick = () => { $('#update-banner').hidden = true; };
    }
  } catch {}
}

// ── helpers / chrome ───────────────────────────────────────────────
function stat(k, v) {
  // textContent, never innerHTML — v may be a network-controlled string (model name, node id, url).
  const r = el('div', 'stat-row');
  const ke = el('span', 'k'); ke.textContent = k;
  const ve = el('span', 'v'); ve.textContent = String(v);
  r.append(ke, ve); return r;
}
function short(s) { s = String(s || ''); return s.length > 30 ? s.slice(0, 14) + '…' + s.slice(-10) : (s || '—'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function modal(html) { $('#modal-content').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; }
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2600); }

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  store.set('theme', mode);
  const btn = document.getElementById('theme-btn');
  if (btn) { btn.textContent = mode === 'light' ? '☀' : mode === 'dark' ? '☾' : '◐'; btn.title = `Theme: ${mode}`; }
}
function wireStatic() {
  $('#modal-x').onclick = closeModal;
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
  $('#theme-btn').onclick = () => {
    const cur = store.get('theme', 'auto');
    const next = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
    applyTheme(next); toast('Theme: ' + next);
  };
  $$('[data-open-web]').forEach(b => b.onclick = () => invoke('open_url', { url: `http://localhost:${NODE.port}/` }));
  listen('node-status', (e) => { NODE.running = e.payload?.running; if (!NODE.running) markNodeDown(); });
  // The host emits node-failed when the crash backstop trips (node can't start after N tries).
  listen('node-failed', () => {
    if ($('#dash').hidden) bootFailed();
    else { markNodeDown(); toast('The node stopped repeatedly — try Restart node in Settings.'); }
  });
}

boot();
