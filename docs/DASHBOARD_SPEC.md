# Circuit Node-Client Dashboard — Redesign Spec

Port the **circuit-agent** dashboard redesign (command sidebar + config-v2 controls, currently
uncommitted in `~/circuit-agent/lib/dashboard.html`) onto **circuit-node-client**
(`~/circuit-node-client/ui/dashboard.html`, served by `lib/server.js`, port 19000).

## 0. Feasibility & principles

**Feasible, low-risk.** The two dashboards are already the same visual family — identical base
(`--bg:#09080a`), border (`--border:#3a2e00`), accent yellow (`#ffe000`), and font (`Courier New`).
So this is **not a recolor**; it is:
1. a **layout swap** — top tab bar → collapsible command sidebar shell, and
2. porting the **"new controls"** (polished sliders w/ live readouts, humanized units, toggle
   switches, segmented pills) onto node-client's real config surface (the Connect-GPU / Connect-CPU
   forms), and
3. moving the header vitals into the sidebar.

**Hard constraints (from the connection inventory):** it's one self-contained file, no build step, no
framework. The re-skin is CSS + HTML structure + a *surgical* JS tweak to `showTab`. **Every** element
id, inline handler name, color-class name, panel-id convention, and data connection MUST survive
(see §4). Back up first; verify every panel + endpoint after; revert = restore one file + nothing else.

**Out of scope this pass:** a generic key/value Settings tab with the agent's full dirty→save→restart
save-bar. node-client has no flat editable config — its "config" is *action forms* (start/stop
worker/host) that already have submit buttons. A generic settings panel would need a **new backend
read/write-config endpoint** and is deferred (§8). We port the control *look & interaction*, not the
save-bar.

---

## 1. Design system (target)

Faithful to circuit-agent; expressed in node-client's existing token names where they exist, plus a
few **additive** vars (never rename node-client's existing vars — 132KB of CSS depends on them).

### Tokens
Keep node-client's `:root` (`--bg --s1 --s2 --s3 --border --border2 --text --muted --dim --bright
--yellow --gold --amber --red --green --font`). **Add** (additive only), to render the sidebar active
state + control states faithfully:
```
--c5:#221a00;   /* active-nav / slider-track / pill-on tint (agent --c5) */
--c4:#3d3100;   /* badge bg */
--green2:#1e4020; --green3:#0a1f0a;   /* toggle on */
--amber2:#c06800;                     /* dirty/restart border */
```
Semantic mapping agent→node-client: `--c`→`--yellow`, `--c2`→`--gold`, `--c3`→`--dim`,
`--text2`→`--muted`, `--text3`→`--dim`, `--bg1/2/3`→`--s1/2/3`.

### Shell
```
#shell    flex, min-height:100vh
  #sidebar   216px (52px when body.sb-collapsed), sticky full-height, hidden scrollbar
  #content   flex:1
     #topbar  panel title + live clock (+ existing header warnings if any)
     #main    the existing .main scroll area — panels unchanged inside
```
Sidebar top→bottom: `.sb-brand` (live dot + "CIRCUIT NODE" + collapse chevron ‹/›) · `.sb-mini`
(collapsed dot) · `.sb-vitals` (node vitals — see §3) · `.sb-nav-wrap` (`.sb-nav[data-tab]` = `.sb-ico`
glyph + `.sb-label` + optional `.sb-badge`) · `.sb-foot` (external links). Collapsed hides
brand-name/vitals/labels/badges, shows `.sb-mini`.

### Controls ("new controls")
Port the agent's `.cfg-*` control CSS and apply to node-client's connect-form inputs:
- `.cfg-slider` + `.cfg-readout` + `.cfg-minmax` — replaces raw `<input type=range>` for `gpu-cap`,
  `cpu-agents`, `cpu-cores`, `cpu-ram`. Live readout with **humanized units** (`cpu-ram` MB → `= 2 GB`,
  `gpu-cap` → `N layers`, `cpu-cores` → `N cores`, `cpu-agents` → `N agents`).
- `.cfg-pills`/`.cfg-pill(.on)` — segmented styling for the existing light/balanced/max preset chips.
- `.cfg-text` — payout-wallet text inputs.
- `.cfg-toggle`+`.cfg-track` — available for any future boolean (not required this pass).
No save-bar: the forms keep their existing **Connect** submit + `_sel`/`pickPreset`/`onAdv` logic.

### Interaction
- `switchTab`/`showTab`: sidebar `.sb-nav[data-tab]` → keep calling `showTab('<id>')`; **update the
  active-highlight matcher** to `data-tab` (see §5) — more robust than today's onclick-string match.
- `toggleSidebar()`: toggle `body.sb-collapsed`, persist `localStorage.sbCollapsed`, swap chevron;
  `⌘\`/`Ctrl+\` shortcut; restore inline pre-body to avoid flash. (New, additive.)
- Topbar clock ticks 1s. (New, additive.)
- Refresh model unchanged — the 15s `setInterval` loop and per-tab lazy-load stay exactly as-is.

---

## 2. node-client current state (condensed)

Top tab bar (`<nav class="tabs">`) → `.panel` sections via `showTab(id)` (matches active tab by
onclick-string; shows `#panel-<id>`). 10 tabs: **overview, network, staking, dllm, cloud, inference
(CHAT), agent, chat (AGENT CHAT), rpc (RPC KEY), updates**. Header shows hstat vitals + live dot.
Config lives in 3 action-forms (GPU connect, CPU connect, admin-token) + manual stake wallet. One 15s
poll loop; one `/chat` WebSocket; one `/inference/chat` SSE. All detail in the inventory (below, §4).

---

## 3. The port — mapping

| Agent design element | node-client target | Notes |
|---|---|---|
| Command sidebar shell | wraps existing header/tabs/main | replaces `<header>`+`<nav.tabs>` |
| `.sb-brand` "CIRCUIT" | "CIRCUIT NODE" + live dot (reuse existing pulse dot id) | keep the live-dot element id |
| `.sb-vitals` (portfolio/SOL/CIRC) | **node vitals**: Status, Sync, Uptime, Node ID(short), Region | reuse ids `h-status,h-sync,h-uptime,ov-region,nodeid-val` — relocate, don't rename |
| `.sb-nav` items | 10 existing tabs, each `data-tab` + `onclick="showTab('x')"` | glyphs per tab; `.sb-badge` for e.g. online-peers/agent-count |
| `.sb-mode` LIVE/PAPER pill | node online/offline/syncing state pill | fed by `/health` (reuse ring state) |
| topbar title+clock | panel title (uppercase id) + clock | additive |
| `.cfg-slider`+readout | gpu-cap / cpu-agents / cpu-cores / cpu-ram sliders | humanized readouts |
| `.cfg-pills` | light/balanced/max preset chips | keep `pickPreset`, `_sel`, ids `#{kind}-pre-*` |
| `.cfg-text` | payout-wallet inputs | keep ids `gpu-wallet`,`cpu-wallet` |
| stat-card/box/table/badge | already present as `.chip`/`.card`/`.kv`/`.b-*` | keep as-is, restyle only via shared tokens |
| Chat/inference surfaces | AGENT CHAT (WS) + CHAT (SSE) | **do not touch** stream parsing / `.chat-cursor` |

Sidebar glyphs (suggested): overview ▤ · network ⋈ · staking ◈ · dllm ⌬ · cloud ☁ · inference ✎ ·
agent ◎ · chat ✺ · rpc ⚿ · updates ↺.

---

## 4. Preserve-list — the "every connection still works" contract

**Do not rename / remove any of these.** Verified against the live dashboard.

**Data connections (client→server) — all must still fire & render:**
`/health`, `/node`, `/llm/status`, `/api/network/nodes/map`, `/network/hub`, `/stake/check`(+`?wallet=`),
`/earnings?wallet=`, `/qr?data=`, `/dllm/info`, `/dllm/worker/{start,stop,restart}`,
`/gpu/{status,start,stop,logs}`, `/setup/status`, `/setup/install/cpu`, `/cloud/status`,
`/cloud/host/{start,stop}`, `/agent/status`, `/inference/{status,chat}`, `/update/{status,apply,rollback}`,
and the **`ws://…/chat` WebSocket**. (Full method/renders-into table lives in the inventory report.)

**Structural contracts:**
- ~93 element ids read via `$(id)` / written via `txt()` / `innerHTML` — incl. subtree targets
  `net-peers, net-shards, net-versions, dllm-mesh-slots, cl-agents-list, ag-positions-list, ag-log,
  upd-history, upd-rollback-list, earn-payouts, infer-messages, chat-messages, ov-log`.
- ~50 inline handlers (`showTab`×13, `connectGpu, connectCpu, pickPreset, dllmWorker, gpuNode,
  applyUpdate, doRollback, setAdminToken, copyKey, connectStakeWallet`, …). Keep inline (no CSP change).
- `panel-<id>` naming + `.panel`/`.panel.active` display rule (poll loop checks `.active`).
- Color-class contract set-by-string in JS: `green|amber|red|teal` (`txt`), `ring online|syncing|offline`,
  badges `b-green|b-amber|b-red|b-teal|b-dim`, `stake-access-status locked|unlocked`,
  `#stake-progress-fill` width bar, `.sel` on preset chips, `#{kind}-adv` collapse, `.chat-cursor`.
- `showTab`'s tab re-highlight matcher (the one thing we intentionally change — §5).

---

## 5. Implementation plan (ordered, single-file, reversible)

0. **Backup:** `cp ui/dashboard.html ui/dashboard.html.pre-redesign.bak`. (Server change none — same file.)
1. **Tokens:** add the additive vars (§1) to `:root`. Restart-free (static file); hard-reload to verify.
2. **Shell CSS:** add `#shell/#sidebar/#content/#topbar/#main` + `.sb-*` + `.cfg-*` CSS blocks (append to
   the `<style>` — additive; existing classes untouched).
3. **HTML structure:** replace `<header>`+`<nav class="tabs">` with `<div id="shell"><aside id="sidebar">…
   </aside><div id="content"><div id="topbar">…</div><div id="main">`; move the `.main`/panels inside
   `#main`; close the wrappers. **Relocate** the vitals elements into `.sb-vitals` keeping their ids.
   Build `.sb-nav` items with `data-tab` + existing `onclick="showTab('x')"`.
4. **JS — surgical:** (a) in `showTab`, change the active-tab match from `.tab`+onclick-string to
   `document.querySelectorAll('.sb-nav')` + `el.dataset.tab===id`; leave panel show/hide + lazy-load
   dispatch **unchanged**. (b) add `toggleSidebar()`, the pre-body restore, the `⌘\` binding, and the
   topbar clock (all additive). (c) `.cfg-slider` readout painters for the 4 connect sliders (additive
   `oninput` that only updates a readout span — does not change submit logic).
5. **Controls:** convert the 4 range inputs to `.cfg-slider` markup + `.cfg-readout`/`.cfg-minmax`;
   restyle preset chips as `.cfg-pills`; wallet inputs `.cfg-text`. Keep all ids + `pickPreset/onAdv`.

**Test gate after EACH of 1–5** (hard-reload http://localhost:19000):
- Page renders, no console errors.
- All 10 tabs switch; each panel shows; active nav highlights.
- Header/sidebar vitals populate from `/health`+`/node`.
- Spot each live panel: network peers, staking (+manual wallet → `/stake/check` + `/earnings`), dllm
  mesh slots, cloud, agent, updates. Connect forms render with working sliders/presets (don't submit
  destructive actions — just confirm the form builds + readouts update).
- Both streams still work: open AGENT CHAT (WS connects) + CHAT/inference (SSE) — status dots green.
- Confirm the 15s poll still refreshes the active panel (watch a vital tick).
If any gate fails → restore `.bak`, reload, stop, report.

---

## 6. Rollback
`cp ui/dashboard.html.pre-redesign.bak ui/dashboard.html` → hard-reload. No server/process restart
needed (static file). Instant, single-file, zero blast radius beyond the dashboard.

## 7. Definition of done
Every §4 connection fires and renders as before (or better); sidebar shell + collapse + clock work;
the 4 connect sliders are polished cfg-sliders with live humanized readouts; presets are segmented
pills; both live streams intact; no console errors; backup retained; `docs/` spec committed with the
change.

## 8. Deferred (optional, needs backend)
A dedicated **Settings tab** using the agent's full schema-driven config-v2 (dirty→save→restart bar)
over `config/client.json` keys (autoUpdate, autoApply, checkIntervalMs, behindProxy, ports, default
payout wallets). Requires a new `GET/POST /config` admin endpoint in `lib/server.js` + a
`FIELD_SPEC_FE`. Not in this pass (keeps the change front-end-only + instantly reversible).
