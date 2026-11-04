/**
 * Styles of the transport ledger panel (ledgerPanel.ts), appended to the View's stylesheet by page.ts. It speaks the
 * cockpit's language: the tokens of viewStyles.ts (spacing, radii, sizes, tints, host colours with their fallbacks),
 * the card, the rows (`.fact`), the gauge bar and the tinted pills of the conditions. No image, no url(), no font,
 * nothing that moves (the panel has no animation, so prefers-reduced-motion has nothing to switch off).
 */
export const LEDGER_CSS = `
.lg-line { margin: var(--sp-2) 0 0; padding: 5px var(--sp-3); background: var(--tint-info); color: var(--sc-info); border-radius: var(--r-m); font-size: var(--fs-s); font-weight: 600; overflow-wrap: anywhere; }

/* Greyed with the rest of the dashboard when the stream is not live (the card is inside .full, already greyed). */
[data-grey="1"] .lg-line { opacity: 0.5; filter: grayscale(1); }

.lg-message { margin: 0 0 var(--sp-3); font-size: var(--fs-s); color: var(--sc-text2); }
.lg-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: var(--sp-2); }
.lg-contract { background: var(--sc-bg3); border-radius: var(--r-m); padding: var(--sp-3); min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.lg-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px var(--sp-2); }
.lg-title { font-weight: 650; overflow-wrap: anywhere; min-width: 0; flex: 1 1 140px; }
.lg-chip { font-size: var(--fs-xs); font-weight: 600; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--sc-line); color: var(--sc-text2); white-space: nowrap; }
.lg-chip[data-state="accepted"], .lg-chip[data-state="in_progress"] { color: var(--sc-info); background: var(--tint-info); border-color: transparent; }
.lg-chip[data-state="completed"] { color: var(--sc-ok); background: var(--tint-ok); border-color: transparent; }
.lg-chip[data-state="abandoned"], .lg-chip[data-state="ended"] { color: var(--sc-warn); background: var(--tint-warn); border-color: transparent; }
.lg-chip[data-state="failed"] { color: var(--sc-bad); background: var(--tint-bad); border-color: transparent; }
.lg-meta { font-size: var(--fs-xs); color: var(--sc-text3); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.lg-contract .gauge { margin: 2px 0; }
.lg-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.lg-step { display: grid; grid-template-columns: 1.4em minmax(0, 1fr); gap: var(--sp-1); align-items: baseline; font-size: var(--fs-s); }
.lg-tick { color: var(--sc-text3); text-align: center; }
.lg-step-text { overflow-wrap: anywhere; color: var(--sc-text2); }
.lg-step[data-done="1"] .lg-tick { color: var(--sc-ok); }
.lg-step[data-done="1"] .lg-step-text { color: var(--sc-text); }
.lg-more { font-size: var(--fs-xs); color: var(--sc-text3); }
.lg-gain { align-self: flex-start; font-size: var(--fs-s); font-weight: 650; font-variant-numeric: tabular-nums; padding: 3px var(--sp-3); border-radius: var(--r-m); overflow-wrap: anywhere; }
.lg-gain[data-tone="ok"] { color: var(--sc-ok); background: var(--tint-ok); }
.lg-gain[data-tone="warn"] { color: var(--sc-warn); background: var(--tint-warn); }
.lg-gain[data-tone=""] { font-weight: 400; font-size: var(--fs-xs); color: var(--sc-text3); padding: 0; border-radius: 0; }

`;
