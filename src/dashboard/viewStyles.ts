/**
 * The stylesheet of the live dashboard View.
 *
 * One set of tokens, used everywhere: colours come from the variables the host gives (applied on the root element by
 * the View), each with a fallback in light-dark() for when a variable is missing; sizes, spacing and radii are
 * tokens too. Nothing else is hard-coded. No external font, no image, no url().
 * Layout never depends on a value: numbers are tabular, dials and tiles reserve their space.
 *
 * Levels mean the same thing everywhere: nominal = discreet green, info = blue, warning = amber, critical = red.
 * Red is kept for critical conditions: an absent or switched-off thing is grey, never red.
 * One level sits above them, "fatal": a SOLID red fill (the page background as the text colour on it), used for nothing but
 * a ship lost with the player aboard. The scale of gravity is therefore: amber (worth a look: a hit, a refused price) < red
 * tint (danger now: shields down, hostile lock) < red fill (the ship is gone). No other hue is added.
 */
export const VIEW_CSS = `
:root {
  color-scheme: light dark;
  --sc-text: var(--color-text-primary, light-dark(#1f1e1d, #faf9f5));
  --sc-text2: var(--color-text-secondary, light-dark(#4f4e4a, #c8c6bc));
  --sc-text3: var(--color-text-tertiary, light-dark(#66655f, #a8a69d));
  --sc-bg: var(--color-background-primary, light-dark(#ffffff, #1f1e1d));
  --sc-bg2: var(--color-background-secondary, light-dark(#f5f4ed, #2a2927));
  --sc-bg3: var(--color-background-tertiary, light-dark(#ebe9df, #353432));
  --sc-line: var(--color-border-tertiary, light-dark(#dedcd1, #3d3c39));
  --sc-border: var(--color-border-secondary, light-dark(#8f8d80, #7d7b74));
  --sc-ok: var(--color-text-success, light-dark(#2d6a3e, #7fd69a));
  --sc-warn: var(--color-text-warning, light-dark(#8a5a00, #f0b84a));
  --sc-bad: var(--color-text-danger, light-dark(#a3281f, #ff8a80));
  --sc-info: var(--color-text-info, light-dark(#1d5fa8, #7db7ff));
  --sc-ring: var(--color-ring-primary, light-dark(#1d5fa8, #7db7ff));
  --sc-inv-bg: var(--color-background-inverse, light-dark(#1f1e1d, #faf9f5));
  --sc-inv-text: var(--color-text-inverse, light-dark(#faf9f5, #1f1e1d));
  --tint-ok: color-mix(in srgb, var(--sc-ok) 14%, transparent);
  --tint-warn: color-mix(in srgb, var(--sc-warn) 16%, transparent);
  --tint-bad: color-mix(in srgb, var(--sc-bad) 16%, transparent);
  --tint-info: color-mix(in srgb, var(--sc-info) 14%, transparent);
  --r-s: 6px;
  --r-m: var(--border-radius-md, 10px);
  --r-l: 14px;
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-5: 24px;
  --fs-xs: 11px;
  --fs-s: 12.5px;
  --fs-m: 14px;
  --fs-l: 18px;
  --fs-xl: 28px;
  --sc-font: var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  --sc-mono: var(--font-mono, ui-monospace, "Cascadia Mono", Consolas, monospace);
}
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; }
body {
  color: var(--sc-text);
  font: var(--fs-m)/1.4 var(--sc-font);
  padding: calc(var(--sp-2) + var(--safe-top, 0px)) calc(var(--sp-2) + var(--safe-right, 0px)) calc(var(--sp-2) + var(--safe-bottom, 0px)) calc(var(--sp-2) + var(--safe-left, 0px));
}
#app { max-width: 1480px; margin: 0 auto; }
[data-hidden="1"] { display: none !important; }
button { font: inherit; color: inherit; }
code { font-family: var(--sc-mono); }
h2, h3 { margin: 0; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* ---------- header ---------- */
.top { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); min-height: 34px; }
.status { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--sp-2); min-width: 0; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--sc-text3); align-self: center; flex: none; }
.dot[data-tone="ok"] { background: var(--sc-ok); }
.dot[data-tone="warn"] { background: var(--sc-warn); }
.dot[data-tone="bad"] { background: var(--sc-bad); }
.status-label { font-weight: 600; }
.status-detail { color: var(--sc-text2); }
.verdict { padding: 3px var(--sp-3); border-radius: 999px; font-weight: 600; font-size: var(--fs-s); border: 1px solid var(--sc-border); color: var(--sc-text2); }
.verdict[data-tone="ok"] { color: var(--sc-ok); background: var(--tint-ok); border-color: transparent; }
.verdict[data-tone="warn"] { color: var(--sc-warn); background: var(--tint-warn); border-color: transparent; }
.verdict[data-tone="bad"] { color: var(--sc-bad); background: var(--tint-bad); border-color: transparent; }
.verdict[data-tone="fatal"] { color: var(--sc-bg); background: var(--sc-bad); border-color: transparent; font-weight: 700; }
.verdict[data-tone="fatal"]::before { content: "\\2715"; content: "\\2715" / ""; margin-right: 6px; }
.top-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-left: auto; }
.age { color: var(--sc-text3); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
/* the account balance: a discreet reminder, always in the header; calmer (muted) when it is not a live reading */
.acct { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); padding: 5px var(--sp-3); border-radius: var(--r-m); background: var(--sc-bg2); border: 1px solid var(--sc-border); min-width: 0; max-width: 100%; }
.acct-main { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; line-height: 1.15; }
.acct-label { display: flex; align-items: center; gap: 6px; color: var(--sc-text2); font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.08em; }
.acct-label::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--sc-text3); flex: none; }
.acct-value { font-size: var(--fs-l); font-weight: 700; color: var(--sc-text); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.acct-note { color: var(--sc-text3); font-size: var(--fs-xs); }
.acct .btn { flex: none; }
[data-mode="fullscreen"] .acct-value { font-size: 24px; }
@media (max-width: 400px) { [data-mode="fullscreen"] .acct-value { font-size: var(--fs-xl); } .acct-value { font-size: var(--fs-l); } }
.acct[data-kind="live"] { border-color: var(--sc-ok); }
.acct[data-kind="live"] .acct-label::before { background: var(--sc-ok); }
.acct[data-kind="last_known"] { border-style: dashed; border-color: var(--sc-warn); }
.acct[data-kind="last_known"] .acct-label::before { background: transparent; box-shadow: inset 0 0 0 1.5px var(--sc-warn); }
.acct[data-kind="last_known"] .acct-note { color: var(--sc-warn); font-weight: 600; }
.acct[data-kind="unknown"] .acct-value { font-size: var(--fs-m); font-weight: 600; color: var(--sc-text2); }
.acct[data-kind="unknown"] .acct-note { color: var(--sc-text2); }
.acct[data-kind="hidden"] .acct-value, .acct[data-kind="follower"] .acct-value { color: var(--sc-text2); letter-spacing: 0.1em; }

[data-tip] { cursor: help; }
.tip { position: fixed; z-index: 20; max-width: min(320px, calc(100vw - 16px)); padding: 6px 9px; border-radius: var(--r-s); font-size: var(--fs-s); line-height: 1.35; background: var(--sc-inv-bg); color: var(--sc-inv-text); box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35); pointer-events: none; }
.btn { background: transparent; border: 1px solid var(--sc-border); border-radius: var(--r-s); padding: 5px 11px; cursor: pointer; line-height: 1.2; }
.btn:hover { background: var(--sc-bg3); }
.btn:focus-visible, .pin:focus-visible, .missing-summary:focus-visible, [data-tip]:focus-visible { outline: 2px solid var(--sc-ring); outline-offset: 2px; }
.btn.primary { background: var(--sc-inv-bg); color: var(--sc-inv-text); border-color: var(--sc-inv-bg); font-weight: 600; }
.btn.primary:hover { opacity: 0.88; }
.btn.small { font-size: var(--fs-s); padding: 4px 9px; }
.btn.mini { font-size: var(--fs-xs); padding: 5px 8px; }
.btn[aria-pressed="true"] { background: var(--sc-bg3); border-color: var(--sc-info); }

.notice { background: var(--sc-bg2); border-radius: var(--r-m); padding: var(--sp-3); margin: var(--sp-2) 0 0; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.notice-text { margin: 0; color: var(--sc-text); }
.notice-cmd { background: var(--sc-bg3); border-radius: 4px; padding: 3px var(--sp-2); user-select: all; }
.toast { min-height: 18px; font-size: var(--fs-s); color: var(--sc-text2); }
.toast-top { min-height: 0; margin-top: 2px; }
.toast-top:empty { display: none; }
[data-mode="fullscreen"] .toast-top { display: none; }

/* ---------- the ship, in one banner ---------- */
.ctx { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2) var(--sp-4); margin-top: var(--sp-2); padding: var(--sp-3) var(--sp-4); background: var(--sc-bg2); border-radius: var(--r-l); }
.ctx-main { display: flex; align-items: baseline; gap: var(--sp-3); min-width: 0; flex-wrap: wrap; }
.ctx-title { font-size: var(--fs-l); font-weight: 650; overflow-wrap: anywhere; }
.ctx-maker { color: var(--sc-text2); font-size: var(--fs-s); }
.ctx-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip.state { color: var(--sc-text); background: var(--sc-bg3); border-color: transparent; font-weight: 600; }
.chip.state[data-state="quantum"], .chip.state[data-state="jump"] { color: var(--sc-info); background: var(--tint-info); }
.chip.state[data-state="off"] { color: var(--sc-text2); }

/* ---------- conditions and recent events ---------- */
.alerts { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 30px; margin: var(--sp-2) 0 2px; }
.alerts-empty { color: var(--sc-text3); font-size: var(--fs-s); }
.alert { display: inline-flex; flex-wrap: wrap; gap: 2px var(--sp-2); align-items: baseline; padding: 3px var(--sp-3); border-radius: 999px; border: 1px solid var(--sc-border); }
.alert[data-tone="bad"] { color: var(--sc-bad); background: var(--tint-bad); border-color: transparent; }
.alert[data-tone="warn"] { color: var(--sc-warn); background: var(--tint-warn); border-color: transparent; }
.alert[data-tone="info"] { color: var(--sc-info); background: var(--tint-info); border-color: transparent; }
.alert:not(.condition) { background: transparent; border: 1px solid currentColor; opacity: 0.85; }
.alert[data-verified="0"] { border-style: dashed; border-color: currentColor; }
/* Reduced = smaller and without a tint, nothing else: the age and "non vérifié" stay, the dashed border of an unverified one stays
   (only the border COLOUR changes, never its style), and no opacity: the text keeps the contrast of the secondary text colour. */
.alert[data-reduced="1"] { padding: 1px 8px; font-size: var(--fs-xs); background: transparent; border-color: var(--sc-border); color: var(--sc-text2); opacity: 1; }
.alert[data-reduced="1"] .alert-meta { font-size: 10px; }
.alert-label { font-weight: 600; }
.alert-meta { color: var(--sc-text2); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }

.pinbar { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 var(--sp-2); }
.pin-chip { display: inline-flex; gap: 6px; align-items: baseline; padding: 3px var(--sp-3); border-radius: 999px; background: var(--sc-bg2); font-size: var(--fs-s); }
.pin-chip-label { color: var(--sc-text2); }
.pin-chip-value { font-weight: 650; font-variant-numeric: tabular-nums; }

/* ---------- dials, gauges, bars ---------- */
.dial { position: relative; container-type: inline-size; width: 100%; margin: 0 auto; }
.dial.xl { max-width: 300px; }
.dial.m { max-width: 210px; }
.dial.s { max-width: 150px; }
.dial.small { max-width: 150px; }
.dial-svg { display: block; width: 100%; height: auto; aspect-ratio: 1 / 0.92; overflow: visible; }
.arc-track, .arc-fill, .arc-peak, .arc-zone, .arc-ticks { fill: none; }
.arc-track { stroke: var(--sc-line); stroke-width: 7; stroke-linecap: round; }
.arc-fill { stroke: var(--sc-text3); stroke-width: 7; stroke-linecap: butt; }
.arc-peak { stroke: var(--sc-text); stroke-width: 9; opacity: 0.8; }
.arc-ticks { stroke: var(--sc-border); stroke-width: 2.2; }
.arc-zone { stroke-width: 1.8; opacity: 0.9; }
.arc-zone[data-tone="warn"] { stroke: var(--sc-warn); }
.arc-zone[data-tone="bad"] { stroke: var(--sc-bad); }
.dial[data-level="ok"] .arc-fill { stroke: var(--sc-ok); }
.dial[data-level="info"] .arc-fill { stroke: var(--sc-info); }
.dial[data-level="warn"] .arc-fill { stroke: var(--sc-warn); }
.dial[data-level="bad"] .arc-fill { stroke: var(--sc-bad); }
.dial[data-known="0"] .arc-fill { stroke: transparent; }
.dial-body { position: absolute; left: 0; right: 0; top: 33%; display: flex; flex-direction: column; align-items: center; text-align: center; pointer-events: none; }
.dial-value { font-size: 22cqw; font-weight: 650; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; white-space: nowrap; }
.dial.xl .dial-value { font-size: 24cqw; }
.dial-value::after { content: attr(data-unit); font-size: 0.34em; font-weight: 500; color: var(--sc-text2); margin-left: 0.25em; letter-spacing: 0; }
.dial-label { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.07em; color: var(--sc-text2); margin-top: 2px; white-space: nowrap; }
.dial.small .dial-label, .dial.s .dial-label { text-transform: none; letter-spacing: 0; font-size: var(--fs-s); }
.dial-sub { text-align: center; font-size: var(--fs-xs); color: var(--sc-text3); min-height: 2.8em; margin-top: -6%; overflow-wrap: anywhere; }
.dial[data-level="bad"] .dial-value { color: var(--sc-bad); }
.dial[data-known="0"] .dial-value { color: var(--sc-text3); }
.dials, .dials-row { display: grid; gap: var(--sp-3); align-items: start; }
.dials { grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); margin-top: var(--sp-2); }
.dials-row { grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); }
.dials-row.vitals { grid-template-columns: repeat(3, minmax(0, 1fr)); }

.meter { padding: var(--sp-1) 0 var(--sp-2); position: relative; }
.meter-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--sp-2); }
.meter-label { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.07em; color: var(--sc-text2); }
.meter-value { font-size: var(--fs-l); font-weight: 650; font-variant-numeric: tabular-nums; min-width: 4ch; text-align: right; }
.meter[data-level="bad"] .meter-value { color: var(--sc-bad); }
.meter-sub { font-size: var(--fs-xs); color: var(--sc-text3); min-height: 15px; overflow-wrap: anywhere; }
.small-meter .meter-value, .vs-box .meter-value { font-size: var(--fs-m); white-space: nowrap; }
.gauge { position: relative; height: 10px; margin: 6px 0 4px; border-radius: 5px; background: var(--sc-line); overflow: hidden; }
.gauge-zone { position: absolute; top: 0; bottom: 0; opacity: 0.35; }
.gauge-zone[data-tone="warn"] { background: var(--sc-warn); }
.gauge-zone[data-tone="bad"] { background: var(--sc-bad); }
.gauge-fill { position: absolute; left: 0; top: 0; bottom: 0; width: calc(var(--p, 0) * 1%); background: var(--sc-text3); border-radius: 5px; }
.gauge[data-level="ok"] .gauge-fill { background: var(--sc-ok); }
.gauge[data-level="info"] .gauge-fill { background: var(--sc-info); }
.gauge[data-level="warn"] .gauge-fill { background: var(--sc-warn); }
.gauge[data-level="bad"] .gauge-fill { background: var(--sc-bad); }
.gauge[data-empty="1"] .gauge-fill { opacity: 0; }

.alt-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--sp-3); margin-top: var(--sp-3); }
.alt-box, .vs-box { position: relative; background: var(--sc-bg3); border-radius: var(--r-m); padding: var(--sp-3); min-width: 0; }
.val-l { font-size: var(--fs-xl); font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.15; min-height: 33px; letter-spacing: -0.01em; }
.bidi { position: relative; height: 10px; margin: 10px 0 4px; border-radius: 5px; background: var(--sc-line); overflow: hidden; }
.bidi-fill { position: absolute; top: 0; bottom: 0; width: calc(var(--p, 0) * 0.5%); }
.bidi-pos { left: 50%; background: var(--sc-info); border-radius: 0 5px 5px 0; }
.bidi-neg { right: 50%; background: var(--sc-warn); border-radius: 5px 0 0 5px; }
.bidi-zero { position: absolute; left: 50%; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--sc-text3); }

/* ---------- compass ---------- */
.compass-wrap { display: flex; flex-direction: column; align-items: center; margin-top: var(--sp-3); }
.compass { position: relative; width: 100%; max-width: 150px; display: flex; flex-direction: column; align-items: center; }
.compass-svg { display: block; width: 100%; height: auto; aspect-ratio: 1; }
.ring-minor, .ring-major { fill: none; }
.ring-minor { stroke: var(--sc-border); stroke-width: 3; }
.ring-major { stroke: var(--sc-text2); stroke-width: 5; }
.compass-letter { fill: var(--sc-text2); font-size: 8px; font-weight: 600; dominant-baseline: middle; }
.needle polygon { fill: var(--sc-info); }
.compass[data-valid="0"] .needle { opacity: 0; }
.compass[data-valid="0"] .compass-value { color: var(--sc-text3); }
.compass-body { display: flex; align-items: baseline; justify-content: center; gap: var(--sp-2); margin-top: 2px; }
.compass-value { font-size: var(--fs-l); font-weight: 650; font-variant-numeric: tabular-nums; min-width: 4ch; text-align: right; }
.compass-card { font-size: var(--fs-m); color: var(--sc-text2); font-weight: 600; min-width: 2ch; }
.compass-sub { text-align: center; }

/* ---------- cockpit layout ---------- */
.inline { margin-top: var(--sp-2); }
[data-mode="fullscreen"] .inline { display: none; }
/* compact view: one wrapping row layout, small cards beside each other when there is room, a small ship banner */
[data-mode=inline] { display: flex; flex-wrap: wrap; gap: 3px 6px; }
[data-mode=inline] > * { flex: 1 1 100%; }
[data-mode=inline] > :not(#_) { margin: 0; }
[data-mode=inline] :is(.ses, .lg-line) { flex: 1 1 240px; }
[data-mode=inline] .ta-open { flex: 1 1 140px; }
[data-mode=inline] .ses[data-fold="0"] { flex-basis: 100%; }
[data-mode=inline] .ctx { padding: 3px var(--sp-3); }
[data-mode=inline] :is(.dials, .alerts) { margin: 0; min-height: 0; }
[data-mode=inline] .dial-sub { min-height: 0; }
[data-mode=inline] .ctx-chips .chip:not(.state) { display: none; }
[data-mode=inline] .ctx-title { font-size: var(--fs-m); }
.full { display: none; }
[data-mode="fullscreen"] .full { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-3); margin-top: var(--sp-3); align-items: start; }
.col, .wide { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.wide { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 330px), 1fr)); align-items: start; }
.off-note { grid-column: 1 / -1; margin: 0; padding: var(--sp-3) var(--sp-4); background: var(--sc-bg3); border-radius: var(--r-m); color: var(--sc-text2); }
@media (min-width: 740px) {
  [data-mode="fullscreen"] .full { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .col-pilot { grid-column: 1 / -1; }
}
@media (min-width: 1100px) {
  [data-mode="fullscreen"] .full { grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) minmax(0, 1fr); }
  .col-pilot { grid-column: auto; }
}
/* The flight order (layoutOrder.ts) puts the shortcuts, the session and the health strip into this grid: full width, no margin of their own. */
.full > .sc, .full > .ses, .full > .hl { margin: 0; grid-column: 1 / -1; }
.trbox { display: flex; flex-direction: column; gap: var(--sp-2); grid-column: 1 / -1; min-width: 0; }
.trbox[data-fold="1"] > .trade { display: none; }
.tfold { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-3); padding: var(--sp-2) var(--sp-4); background: var(--sc-bg2); border-radius: var(--r-l); }
.tfold-sum { flex: 1 1 200px; min-width: 0; color: var(--sc-text2); font-size: var(--fs-s); overflow-wrap: anywhere; }
.card { background: var(--sc-bg2); border-radius: var(--r-l); padding: var(--sp-4); min-width: 0; }
.card-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); margin-bottom: var(--sp-3); }
.card-title { font-size: var(--fs-xs); font-weight: 650; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sc-text2); }
.sub-title { margin: var(--sp-4) 0 6px; font-size: var(--fs-xs); font-weight: 650; letter-spacing: 0.07em; text-transform: uppercase; color: var(--sc-text2); }
.note { margin: var(--sp-3) 0 0; font-size: var(--fs-xs); color: var(--sc-text3); }
.empty-note { margin: 0 0 var(--sp-3); color: var(--sc-text2); font-size: var(--fs-s); }
.btn-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: var(--sp-3); }
.btn-col { display: flex; flex-direction: column; align-items: stretch; gap: 6px; }

.pin { position: absolute; top: 4px; right: 4px; width: 26px; height: 26px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: var(--r-s); background: transparent; color: var(--sc-text3); cursor: pointer; opacity: 0; }
.pin-icon { width: 15px; height: 15px; fill: currentColor; }
.pinnable:hover .pin, .pin:focus-visible, [data-pinned="1"] > .pin, .dial:hover .pin, .meter:hover .pin, .fact:hover .pin { opacity: 1; }
.pin[aria-pressed="true"] { color: var(--sc-info); opacity: 1; }
@media (hover: none) { .pin { opacity: 0.55; } }

/* ---------- facts ---------- */
.facts { display: flex; flex-direction: column; margin-top: var(--sp-3); }
.fact { position: relative; display: flex; align-items: baseline; gap: var(--sp-2); padding: 6px 0; border-top: 1px solid var(--sc-line); }
.fact:first-child { border-top: 0; }
.fact-label { flex: 1 1 auto; color: var(--sc-text2); font-size: var(--fs-s); }
.fact-value { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; min-width: 6ch; overflow-wrap: anywhere; }
.fact[data-level="ok"] .fact-value { color: var(--sc-ok); }
.fact .pin { position: static; width: 22px; height: 22px; flex: none; }
.fact:focus-within .pin { opacity: 1; }

/* ---------- chips ---------- */
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { padding: 2px 10px; border-radius: 999px; border: 1px solid var(--sc-line); font-size: var(--fs-s); color: var(--sc-text3); white-space: nowrap; }
.chip[data-on="1"] { color: var(--sc-ok); background: var(--tint-ok); border-color: transparent; font-weight: 600; }
.chip[data-on="na"] { border-style: dashed; }
.unverified-chip { border-style: dashed; color: var(--sc-text2); }

/* ---------- power diagram ---------- */
.pwr { display: flex; flex-direction: column; align-items: stretch; gap: 0; }
.pwr-grid { position: relative; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; padding-top: 14px; }
.pwr-grid::before { content: ""; position: absolute; left: 12%; right: 12%; top: 6px; height: 1px; background: var(--sc-border); }
.pwr-plant { align-self: center; min-width: 40%; position: relative; }
.pwr-plant::after { content: ""; position: absolute; left: 50%; bottom: -7px; width: 1px; height: 7px; background: var(--sc-border); }
.pwr-node { display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 6px 4px; border-radius: var(--r-s); border: 1px solid var(--sc-line); background: var(--sc-bg3); color: var(--sc-text3); text-align: center; min-width: 0; }
.pwr-grid .pwr-node { position: relative; }
.pwr-grid .pwr-node::before { content: ""; position: absolute; left: 50%; top: -9px; width: 1px; height: 8px; background: var(--sc-border); }
.pwr-label { font-size: var(--fs-s); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.pwr-state { font-size: var(--fs-xs); }
.pwr-node[data-on="1"] { color: var(--sc-ok); background: var(--tint-ok); border-color: transparent; }
.pwr-node[data-on="0"] { color: var(--sc-text3); }
.pwr-node[data-on="na"] { border-style: dashed; }
.pwr-plant[data-on="0"] { color: var(--sc-bad); background: var(--tint-bad); border-color: transparent; }
.pwr[data-plant="off"] .pwr-grid { opacity: 0.45; }
.pwr[data-plant="na"] .pwr-plant { border-style: dashed; }

/* ---------- annunciator panel ---------- */
.lamps { display: grid; grid-template-columns: repeat(auto-fit, minmax(76px, 1fr)); gap: 6px; }
.lamp { display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 6px 4px; border-radius: var(--r-s); background: var(--sc-bg3); border: 1px solid var(--sc-line); }
.lamp-name { font-family: var(--sc-mono); font-weight: 700; font-size: var(--fs-s); letter-spacing: 0.04em; }
.lamp-state { font-size: var(--fs-xs); color: var(--sc-text3); text-align: center; line-height: 1.2; }
.lamp[data-tone="ok"] { background: var(--tint-ok); border-color: transparent; }
.lamp[data-tone="ok"] .lamp-name { color: var(--sc-ok); }
.lamp[data-tone="info"] { background: var(--tint-info); border-color: transparent; }
.lamp[data-tone="info"] .lamp-name { color: var(--sc-info); }
.lamp[data-tone="warn"] { background: var(--tint-warn); border-color: transparent; }
.lamp[data-tone="warn"] .lamp-name { color: var(--sc-warn); }
.lamp[data-tone="bad"] { background: var(--tint-bad); border-color: transparent; }
.lamp[data-tone="bad"] .lamp-name { color: var(--sc-bad); }
.lamp[data-tone="off"] .lamp-name { color: var(--sc-text3); }
.lamp[data-verified="0"] { border-style: dashed; border-color: var(--sc-border); }

/* ---------- weapons ---------- */
.weap-summary { margin: 0 0 var(--sp-2); font-weight: 600; }
.weap { display: flex; align-items: center; gap: var(--sp-2); padding: 4px 0; border-top: 1px solid var(--sc-line); font-size: var(--fs-s); }
.weap:first-child { border-top: 0; }
.weap-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--sc-border); flex: none; }
.weap[data-state="ready"] .weap-dot { background: var(--sc-ok); }
.weap[data-state="powered"] .weap-dot { background: var(--sc-info); }
.weap-name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.weap-state { color: var(--sc-text3); white-space: nowrap; }
.cms { margin-top: var(--sp-3); }

/* ---------- curves ---------- */
.curves { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sp-3); }
.curve { min-width: 0; }
.curve-head { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
.curve-label { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.07em; color: var(--sc-text2); }
.curve-value { font-weight: 650; font-variant-numeric: tabular-nums; }
.spark { display: block; width: 100%; height: 36px; margin: 2px 0; background: var(--sc-bg3); border-radius: var(--r-s); }
.spark polyline { stroke: var(--sc-info); stroke-width: 1.6; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
.curve-range { font-size: var(--fs-xs); color: var(--sc-text3); font-variant-numeric: tabular-nums; min-height: 15px; }

/* ---------- chronology ---------- */
.seg { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: var(--sp-2); }
.events { list-style: none; margin: 0; padding: 0; }
.event { display: grid; grid-template-columns: 62px 1fr auto; gap: var(--sp-2); align-items: baseline; padding: 5px 0; border-top: 1px solid var(--sc-line); }
.event:first-child { border-top: 0; }
.event-time { color: var(--sc-text3); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
.badge { font-size: var(--fs-xs); color: var(--sc-text3); border-radius: 999px; padding: 0 7px; }
.event[data-verified="0"] .badge, .unverified-item .badge { border: 1px dashed var(--sc-border); color: var(--sc-text2); }
.event[data-kind="marker"] .event-text { font-weight: 600; }
.event[data-alert="1"] .event-text { color: var(--sc-warn); }

/* ---------- foldable lines ---------- */
.missing { padding: var(--sp-3) var(--sp-4); background: var(--sc-bg2); border-radius: var(--r-m); }
.missing-summary { cursor: pointer; color: var(--sc-text2); font-size: var(--fs-s); }
.missing-list, .unverified-list { margin: var(--sp-2) 0 0; padding-left: 18px; color: var(--sc-text2); font-size: var(--fs-s); }
.missing-list { columns: 2; }
.unverified-list { list-style: none; padding-left: 0; }
.unverified-item { display: flex; gap: var(--sp-2); align-items: baseline; padding: 3px 0; flex-wrap: wrap; }
.unverified-label { color: var(--sc-text2); }
.unverified-text { font-weight: 600; font-variant-numeric: tabular-nums; }

/* ---------- states ---------- */
[data-grey="1"] .inline, [data-grey="1"] .full, [data-grey="1"] .ctx, [data-grey="1"] .alerts { opacity: 0.5; filter: grayscale(1); }
[data-stream="init"] .dial-value, [data-stream="init"] .val-l { color: transparent; background: var(--sc-bg3); border-radius: 4px; }
[data-ship="off"] .offable .dial, [data-ship="off"] .alt-row, [data-ship="off"] .compass-wrap { opacity: 0.45; }
@media (prefers-reduced-motion: no-preference) {
  .arc-fill, .gauge-fill, .bidi-fill { transition: stroke-dasharray 0.4s ease, width 0.4s ease; }
  .needle { transition: transform 0.4s ease; }
}
@media (max-width: 420px) {
  .missing-list { columns: 1; }
  .event { grid-template-columns: 56px 1fr; }
  .event .badge { grid-column: 2; }
  .dials-row.vitals { gap: var(--sp-2); }
}
`;
