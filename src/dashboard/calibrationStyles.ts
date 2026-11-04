/**
 * Styles of the estimated / measured / ratio block under a suggestion card (calibrationPanel.ts, tradeActions.ts), appended to
 * the View's stylesheet by page.ts. The tokens of viewStyles.ts only, light and dark, 360 to 2000 px. Three cells side by
 * side (two columns on a narrow frame, one on a very narrow one), each a label, a value, a unit and a quiet line; the planner's
 * cell wears the card's dashed ESTIMATION tag, so nothing relies on colour. The ratio cell has a small bar on a 0 to 200 %
 * scale with a mark at 100 %: it is decoration (aria-hidden), every figure is also written.
 */
export const CALIBRATION_CSS = `
.ta-calib { margin: 0; display: flex; flex-direction: column; gap: var(--sp-2); font-size: var(--fs-xs); color: var(--sc-text3); min-width: 0; }
.ta-cmp { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); gap: var(--sp-2); min-width: 0; }
.ta-cmp-cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--sc-line); border-radius: var(--r-s); background: var(--sc-bg2); }
.ta-cmp-cell[data-cell="estimate"] { border-style: dashed; }
.ta-cmp-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--sp-2); }
.ta-cmp-label { font-size: var(--fs-xs); font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--sc-text2); overflow-wrap: anywhere; }
.ta-cmp-value { font-size: var(--fs-l); font-weight: 650; line-height: 1.2; font-variant-numeric: tabular-nums; color: var(--sc-text); overflow-wrap: anywhere; }
.ta-cmp-unit, .ta-cmp-sub { overflow-wrap: anywhere; }
.ta-cmp-unit:empty, .ta-cmp-sub:empty { display: none; }
.ta-cmp-bar { position: relative; display: block; height: 6px; margin-top: 4px; border-radius: 3px; background: var(--sc-bg3); border: 1px solid var(--sc-line); overflow: hidden; }
.ta-cmp-fill { position: absolute; inset: 0 auto 0 0; width: var(--fill, 0%); background: var(--sc-info); }
.ta-cmp-bar::after { content: ""; position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; margin-left: -1px; background: var(--sc-text2); }
.ta-cmp-apply { margin: 0; font-size: var(--fs-s); color: var(--sc-text); overflow-wrap: anywhere; }
.ta-cmp-caution { margin: 0; overflow-wrap: anywhere; }
.ta-calib-more { flex-basis: 100%; }
.ta-calib-more-text { margin: var(--sp-2) 0 0; overflow-wrap: anywhere; }
.ta-calib > .tr-tag { align-self: flex-start; }
`;
