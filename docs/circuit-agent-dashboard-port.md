# Porting the "Signal Gold on Carbon" redesign to the circuit-agent dashboard

This is the design language introduced in `circuit-node-client/ui/dashboard.html`
(2026‑07‑02) and how to bring the same look‑and‑feel to
`circuit-agent/lib/dashboard.html` **without losing any functionality**.

The two dashboards already share a skeleton — sidebar shell (`#sidebar`,
`.sb-nav`, `showTab()`, `data-tab`, `body.sb-collapsed`), a `#topbar`
(`.tb-title`, `.tb-clock`), and the `.card` / `.kv` / `.btn` vocabulary — so the
port is mostly **"swap the `<style>` block, keep the markup and JS."**

---

## 1. What the redesign actually is

A precise console aesthetic, not a theme swap. Five principles:

1. **Dual typography = the biggest lever.** Sans for *chrome* (nav, labels,
   headings, buttons), mono for *data* (values, addresses, code, tables,
   numbers). This one change is what makes it read "designed" instead of
   "terminal dump." Everything numeric gets `font-variant-numeric:tabular-nums`.
2. **Layered carbon + one signal color.** Near‑black warm surfaces stacked with
   subtle top‑highlight (`inset 0 1px 0 rgba(255,232,150,.055)`) and soft
   shadows for depth. Gold (`--yellow:#ffe000`) is the *only* accent that glows.
   Don't introduce competing hues.
3. **A repeated motif.** Cards are "targeting reticles": corner brackets
   (`::before`/`::after`) that brighten and grow on hover, plus a leading dot +
   gradient underline on each card title. Consistency is what makes it memorable.
4. **Purposeful motion.** Panels cross‑fade on tab switch; cards/chips stagger
   in; nav has a glowing active rail; the topbar has a slow signal sweep; status
   rings ripple. All cheap, all `prefers-reduced-motion`‑gated.
5. **Tactile controls.** Segmented preset cards, filled slider tracks with a
   glowing thumb + live readout, focus‑glow inputs, and a filled‑gold primary
   CTA. Controls should feel like hardware.

Before/after reference screenshots: `circuit-node-client/docs/redesign-shots/`.

---

## 2. The one rule that keeps functionality intact

**Class names and element IDs are a contract with the inline JS. Restyle them;
never rename or remove them.** The node‑client JS drives the UI by:

- toggling `.active` on `.panel` and `.sb-nav`
- adding/stripping the bare modifier words `green` / `amber` / `red` / `teal`
  on elements via a regex (`className.replace(/\b(green|amber|red|teal)\b/…)`)
- setting `el.className = 'ring online'`, `'live-dot red'`, `'chat-msg user'`,
  `.sel` on `.preset`, `.show` on copy toasts, etc.

So before editing, extract the contract from the agent dashboard and treat it as
frozen:

```bash
cd ~/circuit-agent
# every id the JS reads:
grep -oE "\\\$\('[a-zA-Z0-9-]+'\)|getElementById\('[a-zA-Z0-9-]+'\)" lib/dashboard.html | sort -u
# every class the JS toggles / assigns:
grep -oE "classList\.(add|remove|toggle)\('[^']*'|\.className\s*=\s*'[^']*'" lib/dashboard.html | sort -u
```

Keep every one of those working. You are free to change *how* they look, add
new decorative classes, add wrapper elements, and add new `<script>` for
cosmetic behavior — just don't delete a hook.

---

## 3. ⚠️ The agent‑specific gotcha: green/red mean money, not "success"

In **node‑client**, the `.green` modifier maps to gold (`--yellow`) because green
just means "good/online." In **circuit‑agent**, `--green:#7acc60` /
`--red:#e04444` are **semantic P&L colors** (profit up / loss down) and the JS
toggles them on positions, trades, and unrealized‑P&L. 

**Do NOT fold green into gold on the agent dashboard.** Keep this split:

```css
--yellow:#ffe000;   /* brand + interactive accent + "online/active" glow  */
--green:#7acc60;    /* P&L up  — KEEP true green (money), do not remap     */
--red:#e04444;      /* P&L down — KEEP true red                           */
--amber:#ffa42a;    /* warnings / pending                                 */
```

Practically: audit where the agent JS applies `green`/`red`. If a spot means
"this metric is healthy/online," you may route it to gold for cohesion; if it
means "position is up/down," it must stay green/red. When unsure, leave it green.

---

## 4. Drop‑in procedure

1. **Back up & set up a screenshot target.** The agent dashboard is served from
   `lib/dashboard.html` via `readFileSync`, so edits are live on reload — no
   rebuild. Run an agent instance (or point a spare one at the file) and note its
   dashboard port for Playwright.

2. **Replace the head `<style>` block** with the node‑client design system
   (`circuit-node-client/ui/dashboard.html`, the first `<style>…</style>`).
   Adjust the `:root` token values per §3. Keep the sidebar/topbar/card/kv/btn
   rules verbatim — they already match the agent's markup.

3. **Add the agent's own component styles** for classes node‑client doesn't have.
   From the grep, the agent uses `.card` (17×), `.kv`, `.btn` (10×), `.sb-vital`,
   `.sb-mode`, `.tb-title` — all covered. But the agent has content node‑client
   lacks: **positions/trades tables, a scanner, a swarm view, and the config
   tab.** Style those with the vocabulary in §5.

4. **Kill leftover inline `<style>` blocks.** node‑client had a second inline
   `<style>` (old preset styles) that overrode the head because it came later in
   source order. Grep for `<style>` — there should be exactly one. Remove or fold
   any others into the head, or they silently win.

5. **Add the brand glyph + favicon** (§6) and the **slider‑fill script** (§5.3)
   if the config tab has range inputs.

6. **Verify** (§7).

---

## 5. Reusable control recipes (copy‑paste)

### 5.1 Card + reticle + titled header
```css
.card{background:linear-gradient(180deg,var(--s1),#0c0a06);border:1px solid var(--border);
  padding:15px 17px;margin-bottom:12px;position:relative;overflow:hidden;border-radius:3px;
  box-shadow:inset 0 1px 0 var(--hair),0 10px 30px -22px #000;transition:border-color .2s,box-shadow .2s}
.card:hover{border-color:var(--border2);box-shadow:inset 0 1px 0 var(--hair),0 0 0 1px rgba(255,224,0,.04),0 16px 40px -26px #000}
.card::before,.card::after{content:'';position:absolute;width:9px;height:9px;z-index:5;transition:opacity .2s,width .2s,height .2s}
.card::before{top:5px;left:5px;border-top:1px solid var(--gold);border-left:1px solid var(--gold);opacity:.85}
.card::after{bottom:5px;right:5px;border-bottom:1px solid var(--gold);border-right:1px solid var(--gold);opacity:.4}
.card:hover::before,.card:hover::after{opacity:1;width:12px;height:12px}
.card-t{font-family:var(--font-ui);font-size:10px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;
  color:var(--gold-soft);margin:-15px -17px 13px;padding:9px 16px 9px 22px;position:relative;display:flex;
  justify-content:space-between;align-items:center;background:linear-gradient(90deg,var(--s2),rgba(22,19,10,0));border-bottom:1px solid var(--border)}
.card-t::before{content:'';position:absolute;left:11px;top:50%;transform:translateY(-50%);width:4px;height:4px;background:var(--gold);border-radius:50%;box-shadow:0 0 7px var(--glow)}
.card-t::after{content:'';position:absolute;bottom:-1px;left:0;width:44px;height:1px;background:linear-gradient(90deg,var(--yellow),transparent)}
```
> The agent's cards may not use a `.card-t` header today (node‑client has 0 →
> agent has 0). If they use a plain heading, either add `.card-t` markup or map
> the recipe onto the existing heading class.

### 5.2 Config‑tab controls — the part to sweat
Segmented presets (great for risk profiles / strategy modes), the filled slider,
focus‑glow inputs, and the gold CTA. These are the highest‑value pieces to bring
to the **config tab** specifically.
```css
.preset{flex:1;background:linear-gradient(180deg,var(--s2),#0c0a06);border:1px solid var(--border2);border-radius:6px;
  padding:12px 8px;cursor:pointer;text-align:center;transition:all .16s cubic-bezier(.2,.7,.2,1);position:relative;overflow:hidden}
.preset::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--gold),var(--yellow));transform:scaleX(0);transform-origin:left;transition:transform .22s}
.preset:hover{border-color:#7a6320;transform:translateY(-2px)}
.preset.sel{border-color:var(--yellow);background:linear-gradient(180deg,rgba(255,224,0,.07),#0c0a06);box-shadow:inset 0 0 0 1px var(--yellow),0 0 26px -10px var(--glow)}
.preset.sel::before{transform:scaleX(1)}
.adv-row input[type=range]{-webkit-appearance:none;appearance:none;flex:1;height:6px;border-radius:100px;
  background:linear-gradient(90deg,var(--gold) 0 var(--fill,50%),var(--c5) var(--fill,50%) 100%);border:1px solid var(--border);outline:none;cursor:pointer}
.adv-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;
  background:radial-gradient(circle at 35% 30%,#fff6c8,var(--yellow));border:1px solid var(--bg);box-shadow:0 0 8px var(--glow);transition:transform .12s}
.adv-row input[type=range]::-webkit-slider-thumb:hover{transform:scale(1.15)}
input:focus,textarea:focus,select:focus{border-color:var(--yellow)!important;box-shadow:0 0 0 1px rgba(255,224,0,.14),0 0 22px -10px var(--glow);outline:none}
.btn.primary{border-color:var(--gold);color:#1a1400;font-weight:800;background:linear-gradient(180deg,#ffe873,var(--gold));box-shadow:0 0 22px -9px var(--glow),inset 0 1px 0 rgba(255,255,255,.28)}
.btn.primary:hover{background:linear-gradient(180deg,#fff2a2,#e9c73c)}
```

### 5.3 Filled‑slider script (cosmetic; wraps hooks, never edits logic)
The gold track fill needs a `--fill` % that native range inputs don't provide.
Add this as a **new** `<script>` before `</body>`; it wraps existing functions
instead of touching them:
```html
<script>(function(){function fill(el){if(!el||el.type!=='range')return;var lo=+el.min||0,hi=+el.max;if(!isFinite(hi))hi=100;
var v=+el.value;if(!isFinite(v))v=lo;el.style.setProperty('--fill',(hi>lo?((v-lo)/(hi-lo))*100:0).toFixed(1)+'%');}
function all(){document.querySelectorAll('input[type=range]').forEach(fill);}
document.addEventListener('input',function(e){if(e.target&&e.target.matches&&e.target.matches('input[type=range]'))fill(e.target);},true);
['loadConfig','pickPreset','showTab'].forEach(function(fn){var o=window[fn];if(typeof o==='function')window[fn]=function(){var r=o.apply(this,arguments);
if(r&&r.then)r.then(all);else all();requestAnimationFrame(all);return r;};});
window.addEventListener('load',function(){requestAnimationFrame(all);});requestAnimationFrame(all);})();</script>
```
(Swap `loadConfig`/`pickPreset` for whatever the agent uses to set slider values.)

### 5.4 Tables & P&L (agent‑specific)
Positions/trades read best as mono, tabular, with up/down color kept semantic:
```css
th{font-family:var(--font-ui);font-size:9px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
td{font-family:var(--font);font-variant-numeric:tabular-nums}
tr{transition:background .12s} tr:hover td{background:var(--s2)}
.pnl-up{color:var(--green)} .pnl-down{color:var(--red)}   /* keep true green/red */
```

### 5.5 Metric chips, badges (pill), status ring, log — take verbatim
`.chip/.chip-l/.chip-v`, `.badge/.b-*`, `.status-ring/.ring.online::after`
(ripple), `.log-box/.log-line.ok|warn|err` all port as‑is from the node‑client
head block.

---

## 6. Brand glyph + favicon (memorability, and it kills the favicon 404)

Add the rotating hex circuit‑node mark to `.sb-brand` (keep any JS‑driven
`#live-dot` — reparent it as a status pip, don't delete it), and make the glyph
the collapsed‑rail expand control:

```html
<span class="sb-glyph-wrap" onclick="toggleSidebar()" title="Collapse / expand (Ctrl+\)"
      style="position:relative;width:22px;height:22px;flex-shrink:0;display:inline-flex;cursor:pointer">
  <svg class="sb-glyph" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <g class="spin">
      <polygon points="16,3 27,9.5 27,22.5 16,29 5,22.5 5,9.5" stroke="#dcb820" stroke-width="1.3" fill="none" opacity=".5"/>
      <circle cx="16" cy="3" r="1.7" fill="#ffe000"/><circle cx="27" cy="22.5" r="1.7" fill="#ffe000"/><circle cx="5" cy="22.5" r="1.7" fill="#ffe000"/>
    </g>
    <circle cx="16" cy="16" r="4.3" stroke="#ffe000" stroke-width="1.4" fill="none"/><circle cx="16" cy="16" r="1.8" fill="#ffe000"/>
  </svg>
</span>
```
```css
.sb-glyph{width:20px;height:20px;filter:drop-shadow(0 0 5px var(--glow))}
.sb-glyph .spin{transform-origin:16px 16px;animation:glyphspin 14s linear infinite}
@keyframes glyphspin{to{transform:rotate(360deg)}}
body.sb-collapsed .sb-collapse{display:none} /* glyph is the expand control when collapsed */
```
Favicon (inline SVG data URI in `<head>`):
```html
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23100d07'/%3E%3Cpolygon points='16,4 26,10 26,22 16,28 6,22 6,10' fill='none' stroke='%23dcb820' stroke-width='1.6'/%3E%3Ccircle cx='16' cy='16' r='4' fill='none' stroke='%23ffe000' stroke-width='1.6'/%3E%3Ccircle cx='16' cy='16' r='1.8' fill='%23ffe000'/%3E%3C/svg%3E">
```

---

## 7. Verification checklist (how the node‑client port was proven)

1. **Structural sanity:** exactly one head `<style>`; balanced `<script>` tags;
   every id from the §2 grep still present in the DOM.
2. **Console clean:** load each tab in Playwright, `browser_console_messages`
   level=error → only expected *network* errors (e.g. a 503 from an offline
   service), zero JS errors.
3. **Every modifier path renders:** trigger the states the JS sets — online vs
   offline ring, P&L up/down colors, preset `.sel`, chat bubble roles, copy
   toast `.show`, `body.sb-collapsed`.
4. **Collapse both ways:** collapse via chevron, expand via the glyph; confirm
   the expand affordance survives (this was a real regression — an inline
   `display` on the glyph wrapper beat the collapse CSS rule; move display to
   CSS or make the glyph itself the toggle).
5. **Screenshot every tab** at 1440×900 and eyeball hierarchy, spacing, and that
   no data value shows `undefined`/`NaN`.

## 8. Pitfalls I hit (so you don't)

- A later inline `<style>` silently overrides the head design system (source
  order). Keep one stylesheet.
- Inline `style="display:…"` beats stylesheet `display` rules — bit the sidebar
  collapse. Prefer CSS for anything a state class needs to toggle.
- Slider track fill needs the `--fill` JS shim; native ranges won't fill.
- Preserve JS‑owned singletons like `#live-dot` — reparent, don't remove.
- Don't remap the agent's green/red P&L semantics into gold (see §3).
- `@media(prefers-reduced-motion:reduce)` — keep it; the motion is liberal.
