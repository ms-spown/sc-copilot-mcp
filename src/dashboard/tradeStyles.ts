/**
 * Styles of the commerce card (tradePanel.ts), appended to the View's stylesheet by page.ts. One design system with the
 * rest of the cockpit: the tokens of viewStyles.ts only (spacing, radii, sizes, tints, host colours with their
 * fallbacks), light and dark, 360 to 2000 px. No image, no url(), no font.
 *
 * Measured and estimated never look alike: a measured bar is solid, an estimated one is hatched with a dashed edge and
 * carries the word "estimé"; colour is never the only signal (every bar has its value, its sign and its tag).
 * Nothing moves, so prefers-reduced-motion has nothing to switch off.
 */
export const TRADE_CSS = `
.trade { grid-column: 1 / -1; display: flex; flex-direction: column; gap: var(--sp-4); }
.tr-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--sp-2) var(--sp-3); }
.tr-titles { min-width: 0; display: flex; flex-direction: column; gap: 2px; flex: 1 1 260px; }
.tr-route { margin: 0; font-size: var(--fs-l); font-weight: 650; overflow-wrap: anywhere; }
.tr-route:empty, .tr-meta:empty { display: none; }
.tr-meta { margin: 0; font-size: var(--fs-s); color: var(--sc-text2); overflow-wrap: anywhere; }
.tr-stage { font-size: var(--fs-xs); font-weight: 650; padding: 3px 12px; border-radius: 999px; border: 1px solid var(--sc-border); color: var(--sc-text2); white-space: nowrap; }
.tr-stage[data-stage="complete"] { color: var(--sc-ok); background: var(--tint-ok); border-color: transparent; }
.tr-stage[data-stage="open"], .tr-stage[data-stage="partial"] { color: var(--sc-info); background: var(--tint-info); border-color: transparent; }
.tr-stage[data-stage="sold_only"] { color: var(--sc-warn); background: var(--tint-warn); border-color: transparent; }
.tr-warn { margin: 0; padding: var(--sp-3); border: 1px solid var(--sc-warn); border-left-width: 4px; background: var(--tint-warn); border-radius: var(--r-m); font-size: var(--fs-s); overflow-wrap: anywhere; }
.tr-message { margin: 0; padding: var(--sp-3); background: var(--sc-bg3); border-radius: var(--r-m); color: var(--sc-text2); font-size: var(--fs-s); }

/* ---------- the headline numbers ---------- */
.tr-hero { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr)); gap: var(--sp-2); }
.tr-tile { background: var(--sc-bg3); border-radius: var(--r-m); padding: var(--sp-3); min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.tr-tile-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 2px var(--sp-2); }
.tr-tile-label { font-size: var(--fs-xs); font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sc-text2); }
.tr-tile-value { font-size: 22px; font-weight: 650; line-height: 1.15; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.tr-tile-value[data-tone="ok"] { color: var(--sc-ok); }
.tr-tile-value[data-tone="bad"] { color: var(--sc-bad); }
.tr-tile-sub { font-size: var(--fs-xs); color: var(--sc-text3); overflow-wrap: anywhere; }
@media (min-width: 640px) {
  .tr-tile-big { grid-column: span 2; }
  .tr-tile-big .tr-tile-value { font-size: 34px; }
}
.tr-tag { font-size: var(--fs-xs); font-weight: 600; padding: 0 8px; border-radius: 999px; color: var(--sc-text2); background: var(--sc-bg2); border: 1px solid var(--sc-line); white-space: nowrap; }
.tr-tag[data-estimate="1"] { border: 1px dashed var(--sc-warn); color: var(--sc-warn); background: transparent; }

/* ---------- the waterfall ---------- */
.tr-block { min-width: 0; }
.tr-block .sub-title { margin-top: 0; }
.tr-wf { display: flex; flex-direction: column; gap: 6px; }
.tr-wf-row { --c: var(--sc-text3); display: grid; grid-template-columns: minmax(110px, 190px) minmax(0, 1fr) minmax(130px, auto); gap: var(--sp-1) var(--sp-3); align-items: center; }
.tr-wf-row[data-tone="ok"] { --c: var(--sc-ok); }
.tr-wf-row[data-tone="bad"] { --c: var(--sc-bad); }
.tr-wf-row[data-tone="warn"] { --c: var(--sc-warn); }
.tr-wf-row[data-tone="info"] { --c: var(--sc-info); }
.tr-wf-names { display: flex; flex-direction: column; min-width: 0; }
.tr-wf-label { font-weight: 600; }
.tr-wf-hint { font-size: var(--fs-xs); color: var(--sc-text3); overflow-wrap: anywhere; }
.tr-wf-track { position: relative; height: 18px; background: color-mix(in srgb, var(--sc-line) 55%, transparent); border-radius: 4px; }
.tr-wf-zero { position: absolute; top: -2px; bottom: -2px; left: calc(var(--z, 0) * 1%); width: 1px; background: var(--sc-text3); }
.tr-wf-bar { position: absolute; top: 2px; bottom: 2px; left: calc(var(--l, 0) * 1%); width: calc(var(--w, 0) * 1%); background: var(--c); border-radius: 3px; }
.tr-wf-row[data-kind="delta"] .tr-wf-bar { top: 5px; bottom: 5px; }
.tr-wf-row[data-estimate="1"] .tr-wf-bar { background: repeating-linear-gradient(135deg, var(--c) 0 3px, transparent 3px 7px); outline: 1px dashed var(--c); outline-offset: -1px; }
.tr-wf-vals { display: flex; align-items: baseline; justify-content: flex-end; gap: var(--sp-2); flex-wrap: wrap; }
.tr-wf-value { font-weight: 650; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tr-wf-row[data-tone="ok"] .tr-wf-value { color: var(--sc-ok); }
.tr-wf-row[data-tone="bad"] .tr-wf-value { color: var(--sc-bad); }
@media (max-width: 560px) {
  .tr-wf-row { grid-template-columns: minmax(0, 1fr) auto; }
  .tr-wf-track { grid-column: 1 / -1; grid-row: 2; }
}

/* ---------- fees and pace ---------- */
.tr-duo { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: var(--sp-4); }
.tr-lines { display: flex; flex-direction: column; }
.tr-line-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 var(--sp-3); padding: 6px 0; border-top: 1px solid var(--sc-line); align-items: baseline; }
.tr-line-row:first-child { border-top: 0; }
.tr-line-label { color: var(--sc-text2); font-size: var(--fs-s); }
.tr-line-value { font-weight: 650; font-variant-numeric: tabular-nums; text-align: right; }
.tr-line-sub { grid-column: 1 / -1; font-size: var(--fs-xs); color: var(--sc-text3); overflow-wrap: anywhere; }
.tr-line-row[data-estimate="1"] .tr-line-value { border-bottom: 1px dashed var(--sc-warn); }

/* ---------- the price curve ---------- */
.tr-chart-wrap { position: relative; }
.tr-dot { position: absolute; right: -4px; top: calc(var(--y, 50) * 1%); width: 8px; height: 8px; margin-top: -4px; border-radius: 50%; background: var(--sc-info); box-shadow: 0 0 0 2px var(--sc-bg2); }
.tr-chart { display: block; width: 100%; height: 88px; background: var(--sc-bg3); border-radius: var(--r-s); overflow: visible; }
.tr-chart line, .tr-chart polyline { vector-effect: non-scaling-stroke; fill: none; }
.tr-curve { stroke: var(--sc-info); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.tr-area { fill: var(--tint-info); stroke: none; }
.tr-mean { stroke: var(--sc-text3); stroke-width: 1; stroke-dasharray: 2 3; }
.tr-target { stroke: var(--sc-warn); stroke-width: 1.6; stroke-dasharray: 7 4; }
.tr-real { stroke: var(--sc-ok); stroke-width: 2.2; }
.tr-range { margin-top: var(--sp-2); }
.tr-range-bar { position: relative; height: 6px; border-radius: 3px; background: var(--sc-line); margin: 8px 0 4px; }
.tr-range-mark { position: absolute; top: -5px; bottom: -5px; left: calc(var(--at, 0) * 1%); width: 3px; margin-left: -1px; border-radius: 2px; }
.tr-range-target { background: var(--sc-warn); }
.tr-range-real { background: var(--sc-ok); }
.tr-range-ends { display: flex; justify-content: space-between; font-size: var(--fs-xs); color: var(--sc-text3); font-variant-numeric: tabular-nums; }
.tr-legend { list-style: none; margin: var(--sp-2) 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 2px var(--sp-4); font-size: var(--fs-s); color: var(--sc-text2); }
.tr-legend-item { display: inline-flex; align-items: center; gap: 6px; }
.tr-swatch { display: inline-block; width: 20px; height: 0; border-top: 2px solid var(--sc-info); }
.tr-swatch[data-kind="mean"] { border-top: 1px dashed var(--sc-text3); }
.tr-swatch[data-kind="target"] { border-top: 2px dashed var(--sc-warn); }
.tr-swatch[data-kind="real"] { border-top: 3px solid var(--sc-ok); }

/* ---------- folded details ---------- */
.tr-more { padding: var(--sp-3) var(--sp-4); background: var(--sc-bg3); border-radius: var(--r-m); }
.tr-more-sum { cursor: pointer; color: var(--sc-text2); font-size: var(--fs-s); }
.tr-more-sum:focus-visible { outline: 2px solid var(--sc-ring); outline-offset: 2px; }
.tr-assumptions, .tr-history { margin: 0; padding-left: 18px; color: var(--sc-text2); font-size: var(--fs-s); }
.tr-more-body .sub-title:first-child { margin-top: var(--sp-3); }
[data-grey="1"] .trade { opacity: 0.5; filter: grayscale(1); }
`;
