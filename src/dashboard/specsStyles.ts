/**
 * The part of the View's stylesheet that belongs to the ship sheet (marks on the speed dial). Appended after VIEW_CSS by
 * page.ts. Same rules as viewStyles.ts: only the host's colour variables (through the --sc-* tokens defined there), no
 * image, no url(), no font.
 */
export const SPECS_CSS = `
.arc-mark { fill: none; stroke-linecap: butt; }
.arc-mark[data-kind="scm"] { stroke: var(--sc-text); stroke-width: 11; opacity: 0.9; }
.arc-mark[data-kind="max"] { stroke: var(--sc-text2); stroke-width: 11; opacity: 0.9; }
.dial[data-sheet="1"] .arc-peak { opacity: 0; }
.dial[data-over="scm"] .arc-fill { stroke: var(--sc-info); }
.dial[data-over="max"] .arc-fill { stroke: var(--sc-warn); }
.dial[data-over="max"] .dial-sub, .dial[data-over="quantum"] .dial-sub { color: var(--sc-text2); }
`;
