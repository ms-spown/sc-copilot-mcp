/**
 * Styles of the health strip (healthPanel.ts), appended to the View's stylesheet by page.ts. It speaks the cockpit's
 * language: the tokens of viewStyles.ts, host colours with their fallbacks, no image, no url(), nothing that moves.
 * Every state is written in a tag as well as coloured: colour is never the only signal.
 */
export const HEALTH_CSS = `
.hl { margin: var(--sp-2) 0 0; padding: var(--sp-3) var(--sp-4); background: var(--sc-bg2); border-radius: var(--r-l); border-left: 3px solid var(--sc-border); }
.hl-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.hl-title { font-size: var(--fs-m); font-weight: 650; margin-right: auto; }
.hl-list { list-style: none; margin: var(--sp-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.hl-item { min-width: 0; }
.hl-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--sp-2); }
.hl-tag { font-size: var(--fs-xs); font-weight: 600; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--sc-border); color: var(--sc-text2); white-space: nowrap; }
.hl-item[data-kind="ok"] .hl-tag { color: var(--sc-ok); background: var(--tint-ok); border-color: transparent; }
.hl-item[data-kind="todo"] .hl-tag { color: var(--sc-warn); background: var(--tint-warn); border-color: transparent; }
.hl-item[data-kind="info"] .hl-tag { color: var(--sc-info); background: var(--tint-info); border-color: transparent; }
.hl-name { font-size: var(--fs-s); }
.hl-text { color: var(--sc-text2); font-size: var(--fs-s); overflow-wrap: anywhere; }
.hl-fix { margin: 4px 0 0 var(--sp-2); padding-left: var(--sp-3); border-left: 2px solid var(--sc-line); display: flex; flex-direction: column; gap: 4px; }
.hl-fix-text { margin: 0; font-size: var(--fs-s); color: var(--sc-text2); overflow-wrap: anywhere; }
.hl-cmd-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.hl-cmd { flex: 0 1 auto; min-width: 0; font-size: var(--fs-s); background: var(--sc-bg3); border: 1px solid var(--sc-line); border-radius: var(--r-s); padding: 2px 8px; overflow-wrap: anywhere; user-select: all; -webkit-user-select: all; }
.hl-legend { margin-top: var(--sp-3); padding-top: var(--sp-3); border-top: 1px solid var(--sc-line); }
.hl-sub { font-size: var(--fs-m); font-weight: 650; }
.hl-terms { margin: var(--sp-2) 0 0; display: flex; flex-direction: column; gap: 3px; }
.hl-term { display: flex; flex-wrap: wrap; gap: 0 var(--sp-2); font-size: var(--fs-s); }
.hl-glyph { font-weight: 650; margin: 0; white-space: nowrap; }
.hl-mean { margin: 0; color: var(--sc-text2); overflow-wrap: anywhere; flex: 1 1 14em; }
.hl-note { margin: var(--sp-2) 0 0; font-size: var(--fs-s); color: var(--sc-text2); }
.btn.quiet { border-color: transparent; color: var(--sc-text2); min-width: 28px; padding-left: 8px; padding-right: 8px; }
.btn.quiet:hover, .btn.quiet[aria-expanded="true"] { color: var(--sc-text); border-color: var(--sc-border); }
`;
