/**
 * Styles of the session bar (sessionPanel.ts), appended to the View's stylesheet by page.ts. It speaks the cockpit's
 * language: the tokens of viewStyles.ts (spacing, radii, sizes, tints, host colours with their fallbacks). No image,
 * no url(), no font, nothing that moves.
 *
 * Reading order, by value: the result (or, with the balance hidden, the trips and the playing time) is the big figure;
 * the per-hour rate and the rest are smaller; the controls and the past sessions are quiet buttons on the right.
 */
export const SESSION_CSS = `
.ses { margin: var(--sp-2) 0 0; padding: var(--sp-3) var(--sp-4); background: var(--sc-bg2); border-radius: var(--r-l); }
.ses-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-5); }
.ses-id { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 200px; }
.ses-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px var(--sp-2); }
.ses-title { font-size: var(--fs-l); font-weight: 650; }
.ses-chip { font-size: var(--fs-xs); font-weight: 600; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--sc-line); color: var(--sc-text2); white-space: nowrap; }
.ses[data-state="open"] .ses-chip { color: var(--sc-ok); background: var(--tint-ok); border-color: transparent; }
.ses[data-state="stale"] .ses-chip { color: var(--sc-warn); background: var(--tint-warn); border-color: transparent; }
.ses-sub { color: var(--sc-text2); font-size: var(--fs-s); overflow-wrap: anywhere; }

.ses-kpis { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-2) var(--sp-5); flex: 2 1 320px; min-width: 0; }
.ses-kpi { display: flex; flex-direction: column; min-width: 0; }
.ses-k-label { color: var(--sc-text3); font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.04em; }
.ses-k-value { font-size: var(--fs-l); font-weight: 650; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; line-height: 1.2; }
.ses-k-sub { color: var(--sc-text3); font-size: var(--fs-xs); overflow-wrap: anywhere; }
.ses-kpi[data-first="1"] .ses-k-value { font-size: var(--fs-xl); }
.ses-kpi[data-tone="ok"] .ses-k-value { color: var(--sc-ok); }
.ses-kpi[data-tone="warn"] .ses-k-value { color: var(--sc-warn); }
.ses-kpi[data-kpi="time"], .ses-kpi[data-kpi="trips"] { color: var(--sc-text); }
.ses-kpi[data-kpi="net"][data-tone=""] .ses-k-value { color: var(--sc-text3); font-weight: 500; }

.ses[data-state="waiting"] .ses-chip { color: var(--sc-info); border-color: var(--sc-info); }
.ses[data-state="ended"] .ses-chip { color: var(--sc-text); border-color: var(--sc-text3); font-weight: 650; }
.ses-hint, .ses-confirm-text { margin: var(--sp-2) 0 0; font-size: var(--fs-s); color: var(--sc-text2); overflow-wrap: anywhere; }
.ses-confirm { margin: var(--sp-2) 0 0; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--sc-warn); border-radius: var(--r-m); background: var(--tint-warn); }
.ses-confirm-text { margin: 0 0 var(--sp-2); color: var(--sc-text); }
.ses-confirm-row { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.ses-status { margin: 0; font-size: var(--fs-s); font-weight: 600; overflow-wrap: anywhere; }
.ses-status:not(:empty) { margin-top: var(--sp-2); }
.ses-status:focus-visible { outline: 2px solid var(--sc-ring); outline-offset: 2px; }
.ses-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--sp-2); margin-left: auto; }
.ses-notes { margin: var(--sp-2) 0 0; display: flex; flex-direction: column; gap: 2px; }
.ses-note { margin: 0; font-size: var(--fs-s); color: var(--sc-text2); overflow-wrap: anywhere; }

.ses-menu { margin-top: var(--sp-3); padding-top: var(--sp-3); border-top: 1px solid var(--sc-line); display: flex; flex-direction: column; gap: var(--sp-2); }
.ses-menu-head, .ses-detail-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.ses-menu-head .btn:last-child { margin-left: auto; }
.ses-menu-title { font-size: var(--fs-m); font-weight: 650; margin-right: auto; }
.ses-stats { background: var(--sc-bg3); border-radius: var(--r-m); padding: var(--sp-2) var(--sp-3); display: flex; flex-direction: column; gap: 2px; }
.ses-stat { margin: 0; font-size: var(--fs-s); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.ses-stat:first-child { font-weight: 600; }
.ses-list { display: flex; flex-direction: column; gap: 4px; max-height: 320px; overflow-y: auto; }
.ses-row { display: grid; grid-template-columns: 4.5em minmax(7em, 10em) minmax(0, 1fr) auto; gap: var(--sp-1) var(--sp-3); align-items: baseline; text-align: left; background: var(--sc-bg); border: 1px solid var(--sc-line); border-radius: var(--r-s); padding: 6px var(--sp-3); cursor: pointer; font-size: var(--fs-s); }
.ses-row:hover { background: var(--sc-bg3); }
.ses-row:focus-visible { outline: 2px solid var(--sc-ring); outline-offset: 2px; }
.ses-row[data-open="1"] { border-color: var(--sc-ok); }
.ses-r-n { font-weight: 650; font-variant-numeric: tabular-nums; }
.ses-r-when { color: var(--sc-text2); }
.ses-r-detail { color: var(--sc-text2); overflow-wrap: anywhere; }
.ses-r-status { grid-column: 2 / -1; color: var(--sc-text3); font-size: var(--fs-xs); }
.ses-row[data-open="1"] .ses-r-status { color: var(--sc-ok); }
.ses-r-result { font-weight: 650; font-variant-numeric: tabular-nums; text-align: right; }
.ses-r-result[data-tone="ok"] { color: var(--sc-ok); }
.ses-r-result[data-tone="warn"] { color: var(--sc-warn); }
.ses-detail { display: flex; flex-direction: column; gap: var(--sp-2); }
.ses-facts { display: flex; flex-direction: column; gap: 3px; }
.ses-fact { margin: 0; font-size: var(--fs-s); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.ses-sub-title { margin: var(--sp-2) 0 0; font-size: var(--fs-xs); color: var(--sc-text3); text-transform: uppercase; letter-spacing: 0.04em; }
.ses-trips { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.ses-trip { font-size: var(--fs-s); color: var(--sc-text2); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }

/* The tabs of the page and the Sessions view (a second panel in its view form). While the view is the tab on screen, the
   rest of the page is hidden; the header, the tabs, the toasts, the notices and the view stay. */
.tabs { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: var(--sp-2) 0 0; }
.tabs .btn[aria-selected="true"] { background: var(--sc-inv-bg); color: var(--sc-inv-text); border-color: var(--sc-inv-bg); font-weight: 600; }
[data-view="sessions"] > :not(.top):not(.tabs):not(.ses-view):not(.toast):not(.notice):not(.sr-only):not(.tip) { display: none !important; }
.ses-view { margin: var(--sp-3) 0 0; }
.ses-view > .ses-menu { margin-top: 0; padding-top: 0; border-top: 0; }
.ses-filters { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.ses-filters .btn[aria-pressed="true"] { background: var(--sc-inv-bg); color: var(--sc-inv-text); border-color: var(--sc-inv-bg); font-weight: 600; }
.ses-split { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-3); }
@media (min-width: 760px) { .ses-view .ses-split { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); align-items: start; } }
.ses-view .ses-list { max-height: none; }
/* In the view the list column is narrow: number and date on the first line with the result, then the figures, then the state. */
.ses-view .ses-row { grid-template-columns: 3.5em minmax(0, 1fr) auto; }
.ses-view .ses-r-result { grid-row: 1; grid-column: 3; }
.ses-view .ses-r-detail { grid-row: 2; grid-column: 2 / -1; }
.ses-view .ses-r-status { grid-row: 3; grid-column: 2 / -1; }
.ses-rowwrap { display: flex; flex-direction: column; gap: 2px; }
.ses-r-acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--sp-2); }
.ses-r-confirm { border: 1px solid var(--sc-warn); border-radius: var(--r-m); background: var(--tint-warn); padding: var(--sp-2) var(--sp-3); }
.ses-row[data-sel="1"] { border-color: var(--sc-info); background: var(--sc-bg3); }
.ses-export { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-2) 0; }
.ses-export-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.ses-export-pre { margin: 0; max-height: 220px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: var(--fs-xs) ui-monospace, monospace; background: var(--sc-bg3); border: 1px solid var(--sc-line); border-radius: var(--r-s); padding: var(--sp-2); user-select: all; -webkit-user-select: all; }

.ses-one { display: none; width: 100%; min-height: 28px; padding: 3px 0; background: none; border: 0; text-align: left; font-size: var(--fs-s); font-weight: 600; }
[data-mode=inline] .ses-one { display: block; }
[data-mode=inline] .ses[data-fold="1"] { padding-block: 0; }
/* Unfolded in the compact view, the fold button above already says "Session N · ...": not a second title. */
[data-mode=inline] .ses[data-fold="0"] .ses-title { display: none; }
[data-mode=inline] .ses[data-fold="1"] > :not(.ses-one) { display: none; }

@media (max-width: 520px) {
  .ses { padding: var(--sp-3); }
  .ses-row { grid-template-columns: 3.5em minmax(0, 1fr) auto; }
  .ses-r-detail, .ses-r-status { grid-column: 1 / -1; }
  .ses-kpi[data-first="1"] .ses-k-value { font-size: var(--fs-l); }
}
`;
