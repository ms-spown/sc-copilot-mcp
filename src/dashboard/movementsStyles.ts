/**
 * Styles of the "Mouvements du solde" block (movementsPanel.ts), appended to the View's stylesheet by page.ts. Same
 * design system as the commerce card: the tokens of viewStyles.ts only, light and dark, 360 to 2000 px, no image, no
 * url(), no font, nothing that moves. A weak label (probable, ambiguous, without a known cause) never looks like a
 * measured one: its tag is dashed (the `tr-tag[data-estimate]` rule of the card) and its row carries a dashed edge;
 * colour is never the only signal (every row has its sign, its amount and its word).
 */
export const MOVEMENTS_CSS = `
.mv { margin-top: var(--sp-3); border: 1px solid var(--sc-line); border-radius: var(--r-m); background: var(--sc-bg2); }
.mv-sum { cursor: pointer; padding: var(--sp-2) var(--sp-3); font-weight: 650; }
.mv-body { padding: 0 var(--sp-3) var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
.mv-explain { display: flex; flex-direction: column; gap: 4px; padding: var(--sp-2) var(--sp-3); background: var(--sc-bg3); border-radius: var(--r-m); }
.mv-explain-line { margin: 0; font-size: var(--fs-s); overflow-wrap: anywhere; }
.mv-totals .tr-line-row[data-estimate="1"] .tr-line-label::after { content: " · probable ou non expliqué"; color: var(--sc-text3); font-size: var(--fs-xs); font-weight: 400; }
.mv-filters { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); }
.mv-chip { font: inherit; font-size: var(--fs-xs); font-weight: 600; min-height: 28px; display: inline-flex; align-items: center; padding: 3px 12px; border-radius: 999px; border: 1px solid var(--sc-line); background: transparent; color: var(--sc-text2); cursor: pointer; }
.mv-chip[aria-pressed="true"] { background: var(--tint-info); color: var(--sc-info); border-color: transparent; }
.mv-chip:focus-visible { outline: 2px solid var(--sc-ring); outline-offset: 2px; }
.mv-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.mv-row { padding: var(--sp-2) var(--sp-3); border-radius: var(--r-s); background: var(--sc-bg3); min-width: 0; border-left: 3px solid var(--sc-line); }
.mv-row[data-category="unexplained"], .mv-row[data-category="probable_contract_reward"], .mv-row[data-category="probable_insurance_or_hangar_cost"] { border-left-style: dashed; border-left-color: var(--sc-warn); }
.mv-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--sp-2); }
.mv-time { font-size: var(--fs-xs); color: var(--sc-text3); font-variant-numeric: tabular-nums; }
.mv-label { font-weight: 600; flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }
.mv-amount { font-weight: 650; font-variant-numeric: tabular-nums; white-space: nowrap; margin-left: auto; }
.mv-amount[data-tone="ok"] { color: var(--sc-ok); }
.mv-amount[data-tone="bad"] { color: var(--sc-bad); }
.mv-detail { display: block; margin-top: 2px; font-size: var(--fs-xs); color: var(--sc-text3); overflow-wrap: anywhere; }
.mv-empty:empty, .mv-foot:empty { display: none; }
`;
