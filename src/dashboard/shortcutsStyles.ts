/**
 * Styles of the "Raccourcis" zone (shortcutsPanel.ts), appended to the View's stylesheet by page.ts. The cockpit's tokens,
 * host colours with their fallbacks, no image, no url(), nothing that moves. A keycap is a bordered box; an alert is also
 * written in bold, so colour is never the only signal.
 */
export const SHORTCUTS_CSS = `
.sc { margin-top: var(--sp-2); padding: var(--sp-2) var(--sp-4); background: var(--sc-bg2); border-radius: var(--r-l); }
.sc-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--sp-2); }
.sc-title { font-size: var(--fs-s); font-weight: 650; }
.sc-ctx, .sc-n, .sc-note, .sc-empty { color: var(--sc-text2); font-size: var(--fs-s); margin: 0; }
.sc-list { list-style: none; margin: var(--sp-1) 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
[data-mode=inline] .sc-list { flex-direction: row; flex-wrap: wrap; gap: 3px var(--sp-4); }
[data-mode=fullscreen] .sc-list { max-width: 36em; }
.sc-row { display: flex; flex-wrap: wrap; align-items: center; gap: 2px var(--sp-2); }
.sc-k { display: inline-flex; align-items: center; gap: 3px; margin-left: auto; }
[data-mode=inline] .sc-k { margin-left: 0; }
.sc-kc { font: 600 var(--fs-xs)/1.3 var(--sc-mono); padding: 1px 6px; background: var(--sc-bg); border: 1px solid var(--sc-border); border-bottom-width: 2px; border-radius: var(--r-s); }
.sc-h { color: var(--sc-text3); font-size: var(--fs-xs); }
.sc-row[data-tier="0"] .sc-t { font-weight: 650; color: var(--sc-warn); }
.sc-row[data-tier="3"] .sc-t { color: var(--sc-text2); }
.sc-fold { margin-left: auto; }
.sc-more { margin-top: var(--sp-1); }
`;
