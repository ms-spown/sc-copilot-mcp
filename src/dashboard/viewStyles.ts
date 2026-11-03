/**
 * The stylesheet of the live dashboard View.
 *
 * Colours come from the variables the host gives (applied on the root element by the View), each with a fallback in
 * light-dark() for when a variable is missing. Nothing else is hard-coded. No external font, no image, no url().
 * Layout never depends on a value: numbers are tabular, tiles reserve their height, bars keep their space.
 */
export const VIEW_CSS = `
:root {
  color-scheme: light dark;
  --sc-text: var(--color-text-primary, light-dark(#1f1e1d, #faf9f5));
  --sc-text2: var(--color-text-secondary, light-dark(#5e5d59, #c2c0b6));
  --sc-text3: var(--color-text-tertiary, light-dark(#6b6a64, #a3a198));
  --sc-bg: var(--color-background-primary, light-dark(#ffffff, #1f1e1d));
  --sc-bg2: var(--color-background-secondary, light-dark(#f5f4ed, #2a2927));
  --sc-bg3: var(--color-background-tertiary, light-dark(#ebe9df, #353432));
  --sc-line: var(--color-border-tertiary, light-dark(#dedcd1, #3d3c39));
  --sc-border: var(--color-border-secondary, light-dark(#c9c7ba, #55534f));
  --sc-ok: var(--color-text-success, light-dark(#2d6a3e, #7fd69a));
  --sc-warn: var(--color-text-warning, light-dark(#8a5a00, #f0b84a));
  --sc-bad: var(--color-text-danger, light-dark(#a3281f, #ff8a80));
  --sc-info: var(--color-text-info, light-dark(#1d5fa8, #7db7ff));
  --sc-ring: var(--color-ring-primary, light-dark(#1d5fa8, #7db7ff));
  --sc-inv-bg: var(--color-background-inverse, light-dark(#1f1e1d, #faf9f5));
  --sc-inv-text: var(--color-text-inverse, light-dark(#faf9f5, #1f1e1d));
  --sc-radius: var(--border-radius-md, 8px);
  --sc-radius-s: var(--border-radius-sm, 6px);
  --sc-font: var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  --sc-mono: var(--font-mono, ui-monospace, "Cascadia Mono", Consolas, monospace);
}
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; }
body {
  color: var(--sc-text);
  font: 13px/1.4 var(--sc-font);
  padding: calc(6px + var(--safe-top, 0px)) calc(6px + var(--safe-right, 0px)) calc(6px + var(--safe-bottom, 0px)) calc(6px + var(--safe-left, 0px));
}
[data-hidden="1"] { display: none !important; }
button { font: inherit; color: inherit; }
code { font-family: var(--sc-mono); }

.top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; min-height: 30px; }
.status { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-width: 0; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--sc-text3); align-self: center; flex: none; }
.dot[data-tone="ok"] { background: var(--sc-ok); }
.dot[data-tone="warn"] { background: var(--sc-warn); }
.dot[data-tone="bad"] { background: var(--sc-bad); }
.status-label { font-weight: 600; }
.status-detail { color: var(--sc-text2); }
.top-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.age { color: var(--sc-text3); font-size: 11.5px; font-variant-numeric: tabular-nums; }

.btn { background: transparent; border: 1px solid var(--sc-border); border-radius: var(--sc-radius-s); padding: 5px 11px; cursor: pointer; line-height: 1.2; }
.btn:hover { background: var(--sc-bg3); }
.btn:focus-visible { outline: 2px solid var(--sc-ring); outline-offset: 2px; }
.btn.primary { background: var(--sc-inv-bg); color: var(--sc-inv-text); border-color: var(--sc-inv-bg); font-weight: 600; }
.btn.primary:hover { opacity: 0.88; }
.btn.small { font-size: 12px; padding: 4px 9px; }
.btn.mini { font-size: 11.5px; padding: 2px 8px; }
.btn[aria-pressed="true"] { background: var(--sc-bg3); border-color: var(--sc-info); }

.notice { background: var(--sc-bg2); border-radius: var(--sc-radius); padding: 10px 12px; margin: 8px 0 0; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.notice-text { margin: 0; color: var(--sc-text); }
.notice-cmd { background: var(--sc-bg3); border-radius: 4px; padding: 3px 8px; user-select: all; }

.alerts { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 28px; margin: 6px 0 2px; }
.alerts-empty { color: var(--sc-text3); font-size: 12px; }
.alert { display: inline-flex; flex-wrap: wrap; gap: 2px 8px; align-items: baseline; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--sc-border); }
.alert[data-tone="bad"] { color: var(--sc-bad); border-color: currentColor; }
.alert[data-tone="warn"] { color: var(--sc-warn); border-color: currentColor; }
.alert[data-verified="0"] { border-style: dashed; }
.alert-label { font-weight: 600; }
.alert-meta { color: var(--sc-text2); font-size: 11.5px; font-variant-numeric: tabular-nums; }

.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 8px; margin-top: 6px; }
.tile { background: var(--sc-bg2); border-radius: var(--sc-radius); padding: 8px 10px; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.tile-label { font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--sc-text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tile-value { font-size: 20px; line-height: 1.25; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 25px; }
.tile-sub { font-size: 11.5px; color: var(--sc-text3); min-height: 16px; line-height: 16px; overflow-wrap: anywhere; }
.tile .btn { align-self: flex-start; margin-top: 2px; }
.card .tile { background: var(--sc-bg3); margin-bottom: 6px; }
.card .tile .btn { position: static; }

.bar { height: 4px; border-radius: 2px; background: var(--sc-line); overflow: hidden; }
.fill { height: 100%; width: calc(var(--p, 0) * 100%); background: var(--sc-text3); border-radius: 2px; }
.bar[data-empty="1"] .fill { opacity: 0; }
[data-level="ok"] .fill { background: var(--sc-ok); }
[data-level="warn"] .fill { background: var(--sc-warn); }
[data-level="bad"] .fill { background: var(--sc-bad); }
[data-level="bad"] > .tile-value { color: var(--sc-bad); }
@media (prefers-reduced-motion: no-preference) { .fill { transition: width 0.4s ease; } }

[data-grey="1"] .tiles, [data-grey="1"] .full { opacity: 0.5; filter: grayscale(1); }
[data-stream="init"] .tile-value { color: transparent; background: var(--sc-bg3); border-radius: 4px; width: 62%; min-height: 25px; }
[data-stream="init"] .tile-sub { visibility: hidden; }

.full { display: none; }
[data-mode="fullscreen"] .full { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 10px; margin-top: 10px; align-items: start; }
.card { background: var(--sc-bg2); border-radius: var(--sc-radius); padding: 10px 12px; min-width: 0; }
.card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.card-title { margin: 0; font-size: 11.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sc-text2); }
.sub-title { margin: 10px 0 4px; font-size: 11.5px; font-weight: 600; color: var(--sc-text2); }
.note { margin: 8px 0 0; font-size: 11.5px; color: var(--sc-text3); }

.row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding: 5px 0; border-top: 1px solid var(--sc-line); }
.row:first-child { border-top: 0; }
.row-label { flex: 1 1 90px; color: var(--sc-text2); }
.row-value { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; min-width: 7ch; overflow-wrap: anywhere; }
.row[data-level="ok"] .row-value { color: var(--sc-ok); }
.row[data-level="warn"] .row-value { color: var(--sc-warn); }
.row[data-level="bad"] .row-value { color: var(--sc-bad); }
.instrument { flex-wrap: nowrap; }
.instrument .row-label { flex: 1 1 auto; min-width: 0; }
.instrument .row-value { min-width: 8ch; }
.spark { width: 84px; height: 28px; flex: none; }
.spark polyline { stroke: var(--sc-info); stroke-width: 1.5; vector-effect: non-scaling-stroke; stroke-linejoin: round; }

.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { padding: 2px 9px; border-radius: 999px; border: 1px solid var(--sc-line); font-size: 11.5px; color: var(--sc-text3); }
.chip::before { content: "\\25CB\\00a0"; }
.chip[data-on="1"] { color: var(--sc-ok); border-color: currentColor; }
.chip[data-on="1"]::before { content: "\\25CF\\00a0"; }
.chip[data-on="na"] { border-style: dashed; }
.chip[data-on="na"]::before { content: "?\\00a0"; }

.lights { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 8px; }
.light { display: flex; justify-content: space-between; gap: 6px; padding: 4px 8px; border-left: 3px solid var(--sc-line); background: var(--sc-bg3); border-radius: 4px; font-size: 12px; }
.light-name { font-weight: 600; font-family: var(--sc-mono); }
.light-state { color: var(--sc-text2); text-align: right; }
.light[data-tone="ok"] { border-left-color: var(--sc-ok); }
.light[data-tone="info"] { border-left-color: var(--sc-info); }
.light[data-tone="warn"] { border-left-color: var(--sc-warn); }
.light[data-tone="bad"] { border-left-color: var(--sc-bad); }
.light[data-verified="0"] { border-left-style: dashed; }

.btn-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.btn-col { display: flex; flex-direction: column; align-items: stretch; gap: 6px; }
.plan-line { margin: 0 0 2px; font-weight: 600; overflow-wrap: anywhere; }
.plan-note { margin: 0 0 4px; color: var(--sc-text2); overflow-wrap: anywhere; }

.events { list-style: none; margin: 0; padding: 0; }
.event { display: grid; grid-template-columns: 60px 1fr auto; gap: 8px; align-items: baseline; padding: 4px 0; border-top: 1px solid var(--sc-line); }
.event:first-child { border-top: 0; }
.event-time { color: var(--sc-text3); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.badge { font-size: 11px; color: var(--sc-text3); border-radius: 999px; padding: 0 7px; }
.event[data-verified="0"] .badge { border: 1px dashed var(--sc-border); color: var(--sc-text2); }
.event[data-kind="marker"] .event-text { font-weight: 600; }

.missing { margin-top: 0; padding: 10px 12px; background: var(--sc-bg2); border-radius: var(--sc-radius); }
.missing-summary { cursor: pointer; color: var(--sc-text2); font-size: 12px; }
.missing-summary:focus-visible { outline: 2px solid var(--sc-ring); outline-offset: 2px; }
.missing-list { margin: 8px 0 0; padding-left: 18px; columns: 2; color: var(--sc-text2); font-size: 12px; }

.live { margin-top: 6px; min-height: 16px; font-size: 11.5px; color: var(--sc-text3); }
`;
