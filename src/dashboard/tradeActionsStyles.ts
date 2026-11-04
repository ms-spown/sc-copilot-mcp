/**
 * Styles of the commerce action bar (tradeActions.ts), appended to the View's stylesheet by page.ts. One design system
 * with the rest of the cockpit: the tokens of viewStyles.ts only, light and dark, 360 to 2000 px. No image, no url(),
 * no font, no animation (so nothing for prefers-reduced-motion to switch off).
 *
 * Hierarchy, value first: the objective buttons and the headline route (the first card, big number) are the loud
 * things; the other routes are quiet rows; the options sit folded under "Affiner"; prices, quantities and risk factors
 * are folded inside each card. An estimate or a heuristic never relies on colour: a dashed tag with its words.
 */
export const TRADE_ACTIONS_CSS = `
/* the bar keeps its colours when the stream is grey: the planner does not need the stream */
[data-grey="1"] .full { opacity: 1; filter: none; }
[data-grey="1"] .full > :not(.trade) { opacity: 0.5; filter: grayscale(1); }
[data-grey="1"] .trade { opacity: 1; filter: none; }
[data-grey="1"] .trade > :not(.tr-actions-slot) { opacity: 0.5; filter: grayscale(1); }

.tr-actions { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); border: 1px solid var(--sc-line); border-radius: var(--r-l); background: var(--sc-bg2); min-width: 0; }
.ta-head { display: flex; flex-direction: column; gap: 2px; }
.ta-title { font-size: var(--fs-l); font-weight: 650; }
.ta-sub { margin: 0; color: var(--sc-text2); font-size: var(--fs-s); }

/* ---------- the objective buttons ---------- */
.ta-buttons { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); gap: var(--sp-2); }
.ta-obj { min-height: 54px; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-m); border: 1px solid var(--sc-border); background: transparent; font-weight: 650; font-size: var(--fs-m); cursor: pointer; text-align: center; }
.ta-obj:hover { filter: brightness(1.12); }
.ta-obj:focus-visible, .ta-apply:focus-visible, .ta-ask:focus-visible, .ta-open:focus-visible { outline: 2px solid var(--sc-ring); outline-offset: 2px; }
.ta-obj[aria-pressed="true"] { background: var(--sc-inv-bg); color: var(--sc-inv-text); border-color: transparent; }
.ta-obj[aria-pressed="true"]::before { content: "\\2713\\00a0"; }
.ta-obj[data-busy="1"] { cursor: progress; }
.ta-obj-hint { margin: 0; font-size: var(--fs-xs); color: var(--sc-text3); }

/* ---------- options, folded ---------- */
.ta-refine { border-top: 1px solid var(--sc-line); padding-top: var(--sp-2); }
.ta-refine-sum { cursor: pointer; color: var(--sc-text2); font-size: var(--fs-s); }
.ta-refine-sum:focus-visible, .ta-more-sum:focus-visible, .ta-calib-sum:focus-visible { outline: 2px solid var(--sc-ring); outline-offset: 2px; }
.ta-refine-body { display: flex; flex-direction: column; gap: var(--sp-3); margin-top: var(--sp-3); }
.ta-options { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-4); }
.ta-check { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; min-height: 32px; font-size: var(--fs-s); cursor: pointer; }
.ta-check-input { width: 18px; height: 18px; margin: 0; accent-color: var(--sc-info); }
.ta-check-note { flex-basis: 100%; padding-left: 26px; font-size: var(--fs-xs); color: var(--sc-text3); }
.ta-check-note:empty { display: none; }
.ta-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: var(--sp-3); }
.ta-field { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-s); min-width: 0; }
.ta-field-label { font-weight: 600; color: var(--sc-text2); }
.ta-field-note { font-size: var(--fs-xs); color: var(--sc-text3); }
.ta-input { font: inherit; color: var(--sc-text); background: var(--sc-bg); border: 1px solid var(--sc-border); border-radius: var(--r-s); padding: 6px 9px; min-height: 36px; min-width: 0; width: 100%; }
.ta-input:focus-visible { outline: 2px solid var(--sc-ring); outline-offset: 1px; }
.ta-input:disabled { opacity: 0.55; }

/* ---------- status, waiting ---------- */
.ta-status { margin: 0; font-size: var(--fs-s); color: var(--sc-text2); overflow-wrap: anywhere; }
.ta-status[data-tone="warn"] { color: var(--sc-warn); }
.ta-status[data-tone="bad"] { color: var(--sc-bad); }
.ta-status[data-tone="warn"]::before, .ta-status[data-tone="bad"]::before { content: "\\26A0\\00a0"; }
.ta-skeleton { display: flex; flex-direction: column; gap: var(--sp-2); }
.ta-skel { height: 84px; border-radius: var(--r-m); background: var(--sc-bg3); border: 1px dashed var(--sc-line); }
.ta-skel:first-child { height: 130px; }

/* ---------- result cards ---------- */
.ta-results { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.ta-card { display: grid; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); background: var(--sc-bg); border: 1px solid var(--sc-line); border-radius: var(--r-m); min-width: 0; }
.ta-card[data-hero="1"] { border-color: var(--sc-info); border-left-width: 4px; padding: var(--sp-4); gap: var(--sp-3); }
.ta-card-top { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: var(--sp-3); align-items: center; }
.ta-rank { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-weight: 650; font-size: var(--fs-s); background: var(--sc-bg3); color: var(--sc-text2); }
.ta-card[data-hero="1"] .ta-rank { background: var(--sc-info); color: var(--sc-bg); }
.ta-titles { min-width: 0; }
.ta-route { margin: 0; font-size: var(--fs-m); font-weight: 650; overflow-wrap: anywhere; }
.ta-card[data-hero="1"] .ta-route { font-size: var(--fs-l); }
.ta-goods { margin: 0; font-size: var(--fs-s); color: var(--sc-text2); overflow-wrap: anywhere; }
.ta-big { display: flex; flex-direction: column; align-items: flex-end; text-align: right; }
.ta-big-value { font-size: 22px; font-weight: 650; line-height: 1.15; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.ta-card[data-hero="1"] .ta-big-value { font-size: 34px; }
.ta-big-unit { font-size: var(--fs-xs); color: var(--sc-text3); }
.ta-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 130px), 1fr)); gap: var(--sp-2); margin: 0; }
.ta-fact { display: flex; flex-direction: column; min-width: 0; }
.ta-fact-label { font-size: var(--fs-xs); font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sc-text2); }
.ta-fact-value { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.ta-badges { display: flex; flex-wrap: wrap; gap: 4px var(--sp-2); }
.ta-badges .tr-tag { white-space: normal; }
.ta-card-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.ta-apply { border-color: var(--sc-info); color: var(--sc-info); font-weight: 650; cursor: pointer; }
.ta-apply[aria-pressed="true"] { background: var(--tint-info); }
.ta-apply[aria-pressed="true"]::before { content: "\\2713\\00a0"; }
.ta-ask { color: var(--sc-text2); cursor: pointer; }
.ta-more { font-size: var(--fs-s); color: var(--sc-text2); }
.ta-more-sum { cursor: pointer; color: var(--sc-text3); font-size: var(--fs-xs); }
.ta-more-body { margin-top: var(--sp-2); display: flex; flex-direction: column; gap: 4px; }
.ta-line { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 560px) {
  .ta-card-top { grid-template-columns: auto minmax(0, 1fr); }
  .ta-big { grid-column: 1 / -1; align-items: flex-start; text-align: left; }
}

/* ---------- chains: quiet, apart ---------- */
.ta-chains { display: flex; flex-direction: column; gap: var(--sp-2); padding-top: var(--sp-3); border-top: 1px dashed var(--sc-line); }
.ta-chains-title { font-size: var(--fs-s); font-weight: 650; color: var(--sc-text2); }
.ta-chains-note { margin: 0; font-size: var(--fs-xs); color: var(--sc-text3); }
.ta-chains .ta-card { background: transparent; }
.ta-foot { display: flex; flex-direction: column; gap: 4px; }
.ta-foot-line { margin: 0; font-size: var(--fs-xs); color: var(--sc-text3); overflow-wrap: anywhere; }

/* ---------- "Et ensuite ?" ---------- */
.ta-next { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--sc-info); border-radius: var(--r-l); background: var(--tint-info); }
.ta-next-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--sp-3); }
.ta-next-title { font-size: var(--fs-l); font-weight: 650; }
.ta-next-from { font-size: var(--fs-s); color: var(--sc-text2); overflow-wrap: anywhere; }
.ta-next-note { margin: 0; font-size: var(--fs-s); color: var(--sc-text2); }
.ta-open { margin-top: var(--sp-2); }
`;
