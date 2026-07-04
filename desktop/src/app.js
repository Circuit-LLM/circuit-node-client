/* Circuit Node desktop — frontend.
 * The main view is the node's OWN full dashboard (served at localhost:PORT), embedded in an iframe,
 * wrapped by the native shell: tray + notifications (Rust), a first-run mode-picker/wizard, app
 * updates, and a thin top bar. Native calls go through the Rust node_api proxy; the embedded
 * dashboard talks to its own origin directly (same-origin inside the iframe). */
'use strict';

const T = window.__TAURI__ || {};
const invoke = T.core ? T.core.invoke : async () => { throw new Error('not in Tauri'); };
const listen = T.event ? T.event.listen : async () => {};

async function api(method, path, body) { return invoke('node_api', { method, path, body: body ?? null }); }
const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b);

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
const isSolAddr = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const store = { get: (k, f) => { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

let NODE = { port: 19000 };
let SETUP = null;
let payoutWallet = store.get('payoutWallet', '');

function show(view) { ['boot', 'picker', 'main'].forEach(v => { const n = $('#' + v); if (n) n.hidden = (v !== view); }); }

// ── boot ────────────────────────────────────────────────────────────
async function boot() {
  applyTheme();
  try { NODE = await invoke('node_info_cmd'); } catch {}
  const status = $('#boot-status');
  for (let i = 0; i < 60; i++) {
    try { if ((await get('/health')).ok) { await afterUp(); return; } } catch {}
    if (i === 8) status.textContent = 'the node is taking a moment to come up…';
    if (i === 25) status.textContent = 'still starting — first run initializes your node identity…';
    await sleep(700);
  }
  bootFailed();
}
function bootFailed() {
  const boot = $('#boot'); boot.classList.add('failed');
  $('#boot-status').textContent = 'Could not reach the node.';
  if (!$('#boot-retry')) {
    const b = el('button', 'btn'); b.id = 'boot-retry'; b.textContent = 'Retry'; b.style.marginTop = '16px';
    b.onclick = async () => { b.remove(); boot.classList.remove('failed'); $('#boot-status').textContent = 'restarting the node…'; try { await invoke('restart_node'); } catch {} boot(); };
    boot.appendChild(b);
  }
}
async function afterUp() {
  try { NODE = await invoke('node_info_cmd'); } catch {}
  try { SETUP = (await get('/setup/status')).body; } catch { SETUP = {}; }
  wireStatic();
  // Always land on the node dashboard (its default tab is Overview). The mode picker is a
  // deliberate "Contribute" screen reached from the top bar, not the app's landing page.
  showMain();
  checkUpdate();
}

// ── first-run picker ────────────────────────────────────────────────
async function openPicker() {
  show('picker');
  try { const node = (await get('/node')).body; $('#picker-node').textContent = `node ${String(node.nodeId || '').slice(0, 16)}… · v${node.version || NODE.app_version}`; } catch {}
}
$$('.mode-card').forEach(c => c.addEventListener('click', () => { c.dataset.mode === 'cpu' ? wizardCpu() : wizardGpu(); }));

// ── main view: the node's full dashboard, embedded ──────────────────
let statusTimer = null;
function showMain() {
  show('main');
  const f = $('#dashframe');
  const url = `http://localhost:${NODE.port}/`;
  if (f.getAttribute('src') !== url) f.setAttribute('src', url);   // set once — don't reload on refresh
  pollStatus();
  clearInterval(statusTimer);
  statusTimer = setInterval(pollStatus, 10000);
}
async function pollStatus() {
  if ($('#main').hidden) return;
  const pill = $('#net-pill'); if (!pill) return;
  try {
    const hub = (await get('/network/hub')).body;
    pill.textContent = hub.reachable ? 'network · online' : 'network · offline';
    pill.className = 'pill ' + (hub.reachable ? 'ok' : 'bad');
  } catch { pill.textContent = 'node offline'; pill.className = 'pill bad'; }
}

// ── CPU connect wizard ──────────────────────────────────────────────
async function wizardCpu() {
  const c = SETUP?.cpu || (await get('/setup/status')).body.cpu;
  if (!c.hostPresent) {
    modal(`<h2>Set up CPU hosting</h2><div class="sub">Fetching the agent-host…</div>`);
    const r = await post('/setup/install/cpu').catch(() => ({ ok: false, body: {} }));
    if ($('#modal').hidden) return;
    if (!r.ok || !r.body?.present) {
      const hint = r.body?.hint || 'Place a circuit-agent-cloud checkout in your home folder, or install the host package.';
      modal(`<h2>CPU hosting needs a one-time setup</h2>
        <div class="sub">Hosting runs agents on your machine under a budget you set. The agent-host isn’t bundled yet, so it has to be installed once — after that it’s click-to-start.</div>
        <div class="step"><span class="n">i</span><div>${esc(hint)}</div></div>
        <div id="recheck-note" class="hint" style="color:var(--red)" hidden>Still not found — the host package isn’t in place yet.</div>
        <div class="btn-group"><button class="btn" id="dl">Open downloads</button><button class="btn ghost" id="rechk">Re-check</button></div>`);
      $('#dl').onclick = () => invoke('open_url', { url: 'https://github.com/Circuit-LLM/circuit-node-client/releases' });
      $('#rechk').onclick = async () => { const rr = await post('/setup/install/cpu').catch(() => ({ ok: false, body: {} })); if (rr.ok && rr.body?.present) wizardCpu(); else $('#recheck-note').hidden = false; };
      return;
    }
  }
  const p = (SETUP?.cpu || c).presets || {}; const m = p.machine || {};
  let preset = 'balanced';
  modal(`<h2>Host agents</h2>
    <div class="sub">Pick how much of this ${m.cores ? m.cores + '-core' : ''} machine to lend. Agents run under a hard budget; their keys never touch your box.</div>
    <div class="seg" id="seg">${['light', 'balanced', 'max'].map(k => `<button data-k="${k}" class="${k === preset ? 'sel' : ''}">${k}<span class="n">${p[k]?.maxAgents ?? '?'} agents · ${p[k]?.maxCpu ?? '?'} cores</span></button>`).join('')}</div>
    <label class="fld">Payout wallet (optional)<input id="wallet" placeholder="Solana address" value="${esc(payoutWallet)}" /></label>
    <button class="btn row" id="start">Start hosting</button>`);
  $$('#seg button').forEach(x => x.onclick = () => { preset = x.dataset.k; $$('#seg button').forEach(y => y.classList.toggle('sel', y === x)); });
  $('#start').onclick = async () => {
    const wallet = $('#wallet').value.trim();
    if (wallet && !isSolAddr(wallet)) { toast('That doesn’t look like a Solana address'); return; }
    if (wallet) { payoutWallet = wallet; store.set('payoutWallet', wallet); }
    $('#start').disabled = true; $('#start').textContent = 'Starting…';
    const r = await post('/cloud/host/start', { preset, payoutWallet: wallet }).catch(() => ({ ok: false }));
    if (r.ok) { closeModal(); toast('Hosting started'); try { SETUP = (await get('/setup/status')).body; } catch {} showMain(); }
    else { $('#start').disabled = false; $('#start').textContent = 'Start hosting'; toast('Could not start hosting'); }
  };
}

// ── GPU connect wizard ──────────────────────────────────────────────
async function wizardGpu() {
  SETUP = (await get('/setup/status')).body; const g = SETUP.gpu || {};
  if (!g.present) {
    modal(`<h2>No NVIDIA GPU here</h2><div class="sub">The inference mesh needs an NVIDIA GPU. This machine doesn’t have one — but CPU agent hosting works on any computer and earns too.</div><button class="btn row" id="tocpu">Set up CPU hosting instead</button>`);
    $('#tocpu').onclick = wizardCpu; return;
  }
  if (!g.enginePresent) {
    let gpuDocker = {}; try { gpuDocker = (await get('/gpu/status')).body; } catch {}
    if (gpuDocker.present) {
      modal(`<h2>GPU node found</h2><div class="sub">A Circuit GPU node container is installed (${esc(g.info?.name || 'GPU')}). Start it to begin serving inference.</div><button class="btn row" id="start">Start GPU node</button>`);
      $('#start').onclick = async () => { const r = await post('/gpu/start').catch(() => ({ ok: false })); if (r.ok) { closeModal(); toast('GPU node starting'); showMain(); } else toast('Could not start container'); };
      return;
    }
    modal(`<h2>Provision the GPU engine</h2>
      <div class="sub">Serving inference needs the Circuit engine (Docker + model) on this box. Follow the desktop GPU guide, then come back.</div>
      <div class="step"><span class="n">1</span><div>Install Docker + NVIDIA container toolkit (WSL2 on Windows).</div></div>
      <div class="step"><span class="n">2</span><div>Run the one-click GPU join to pull the engine + model.</div></div>
      <div class="btn-group"><button class="btn" id="guide">Open GPU setup guide</button><button class="btn ghost" id="rechk">I’ve done it</button></div>`);
    $('#guide').onclick = () => invoke('open_url', { url: 'https://circuitllm.xyz/join' });
    $('#rechk').onclick = wizardGpu;
    return;
  }
  const p = g.presets || {}; let preset = 'balanced';
  modal(`<h2>Join the inference mesh</h2>
    <div class="sub">Choose how much of ${esc(g.info?.name || 'your GPU')} (${fmt(g.info?.vramMb)} MB) to lend. More layers = bigger slice + bigger share.</div>
    <div class="seg" id="seg">${['light', 'balanced', 'max'].map(k => `<button data-k="${k}" class="${k === preset ? 'sel' : ''}">${k}<span class="n">${p[k] ?? '?'} layers</span></button>`).join('')}</div>
    <label class="fld">Payout wallet (optional)<input id="wallet" placeholder="Solana address" value="${esc(payoutWallet)}" /></label>
    <button class="btn row" id="start">Start serving</button>`);
  $$('#seg button').forEach(x => x.onclick = () => { preset = x.dataset.k; $$('#seg button').forEach(y => y.classList.toggle('sel', y === x)); });
  $('#start').onclick = async () => {
    const wallet = $('#wallet').value.trim();
    if (wallet && !isSolAddr(wallet)) { toast('That doesn’t look like a Solana address'); return; }
    if (wallet) { payoutWallet = wallet; store.set('payoutWallet', wallet); }
    $('#start').disabled = true; $('#start').textContent = 'Starting…';
    const r = await post('/dllm/worker/start', { preset, payoutWallet: wallet }).catch(() => ({ ok: false }));
    if (r.ok) { closeModal(); toast('GPU worker starting'); showMain(); }
    else { $('#start').disabled = false; $('#start').textContent = 'Start serving'; toast('Could not start the worker'); }
  };
}

// ── app update ──────────────────────────────────────────────────────
async function checkUpdate() {
  try {
    const u = await invoke('check_app_update');
    if (u.available && u.latest) {
      const b = $('#update-btn'); if (!b) return;
      b.hidden = false; b.textContent = `Update → v${u.latest}`;
      b.onclick = () => invoke('open_url', { url: u.url || 'https://github.com/Circuit-LLM/circuit-node-client/releases' });
    }
  } catch {}
}

// ── chrome ──────────────────────────────────────────────────────────
function modal(html) { $('#modal-content').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; }
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2600); }
// The embedded node dashboard is dark-only ("Signal Gold on Carbon"), so the whole app is pinned
// dark to match — a light shell around a dark dashboard just looked broken. No toggle.
function applyTheme() { document.documentElement.setAttribute('data-theme', 'dark'); }

// ── Pair a local circuit-agent (enables the Agent + Chat tabs) ──────
async function connectAgent() {
  let dir;
  try { dir = await invoke('pick_agent_dir'); } catch { toast('Folder picker unavailable'); return; }
  if (!dir) return; // cancelled
  toast('Pairing agent…');
  const r = await post('/setup/agent', { dataPath: dir }).catch(() => ({ ok: false, body: {} }));
  if (!(r.ok && r.body?.ok)) { toast(r.body?.error || 'That folder isn’t a circuit-agent data dir'); return; }
  toast(r.body.agentFound ? 'Agent paired — restarting node…' : 'Paired (start circuit-agent to see it) — restarting…');
  try { await invoke('restart_node'); } catch {}
  // wait for the node to come back, then reload the embedded dashboard so Agent/Chat pick up the pairing
  for (let i = 0; i < 30; i++) { try { if ((await get('/health')).ok) break; } catch {} await sleep(500); }
  const f = $('#dashframe'); if (f) { const url = `http://localhost:${NODE.port}/`; f.setAttribute('src', 'about:blank'); setTimeout(() => f.setAttribute('src', url), 80); }
}
let _wired = false;
function wireStatic() {
  if (_wired) return; _wired = true;
  $('#modal-x').onclick = closeModal;
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
  $('#skip-to-dash').onclick = showMain;
  $('#contribute-btn').onclick = openPicker;
  $('#agent-btn').onclick = connectAgent;
  $('#ext-btn').onclick = () => invoke('open_url', { url: `http://localhost:${NODE.port}/` });
  listen('node-status', (e) => { if (e.payload && e.payload.running === false) { const p = $('#net-pill'); if (p) { p.textContent = 'node offline'; p.className = 'pill bad'; } } });
  listen('node-failed', () => { if ($('#main').hidden) bootFailed(); else toast('The node stopped repeatedly — try Restart from the tray.'); });
}

boot();
