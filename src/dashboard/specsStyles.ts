/**
 * The part of the View's stylesheet that belongs to the ship sheet (marks on the speed gauge, the sheet line).
 * Appended after VIEW_CSS by page.ts. Same rules as viewStyles.ts: only the host's colour variables (through the
 * --sc-* tokens defined there), no image, no url(), no font, tabular numbers, a height that never depends on a value.
 */
export const SPECS_CSS = `
.bar[data-marks="1"] { position: relative; overflow: visible; }
.tick { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; left: calc(var(--at, 0) * 100%); background: var(--sc-text2); border-radius: 1px; }
.tick[data-kind="max"] { margin-left: -2px; background: var(--sc-text3); }
.bar[data-over="scm"] .fill { background: var(--sc-info); }
.bar[data-over="max"] .fill, .bar[data-over="quantum"] .fill { background: var(--sc-warn); }
.bar[data-over="max"]::after, .bar[data-over="quantum"]::after { content: "\\25B8"; position: absolute; right: -2px; top: -5px; font-size: 10px; line-height: 12px; color: var(--sc-warn); }
.tile-scale { font-size: 11px; color: var(--sc-text3); line-height: 14px; min-height: 14px; overflow-wrap: anywhere; }
.specs-line { margin: 6px 2px 0; font-size: 12px; color: var(--sc-text2); overflow-wrap: anywhere; }
[data-grey="1"] .specs-line { opacity: 0.5; }
`;
