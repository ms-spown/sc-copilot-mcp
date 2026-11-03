/**
 * Styles of the transport ledger panel (ledgerPanel.ts), appended to the View's stylesheet by page.ts. Same rules as
 * viewStyles.ts: only the variables of the host (with the fallbacks defined on :root there), no image, no url(),
 * no font, nothing that moves (the panel has no animation, so prefers-reduced-motion has nothing to switch off).
 */
export const LEDGER_CSS = `
.full > .card.ledger { grid-column: 1 / -1; order: 50; }
.full > .missing { order: 99; }

.lg-line { margin: 6px 0 0; padding: 6px 10px; background: var(--sc-bg2); border-radius: var(--sc-radius); border-left: 3px solid var(--sc-info); font-size: 12.5px; font-weight: 600; overflow-wrap: anywhere; }

.lg-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 8px; }
.lg-contract { background: var(--sc-bg3); border-radius: var(--sc-radius-s); border-left: 3px solid var(--sc-line); padding: 8px 10px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.lg-contract[data-state="accepted"], .lg-contract[data-state="in_progress"] { border-left-color: var(--sc-info); }
.lg-contract[data-state="completed"] { border-left-color: var(--sc-ok); }
.lg-contract[data-state="abandoned"], .lg-contract[data-state="ended"] { border-left-color: var(--sc-warn); }
.lg-contract[data-state="failed"] { border-left-color: var(--sc-bad); }
.lg-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 8px; }
.lg-title { font-weight: 600; overflow-wrap: anywhere; min-width: 0; flex: 1 1 140px; }
.lg-chip { font-size: 11px; padding: 0 8px; border-radius: 999px; border: 1px solid var(--sc-border); color: var(--sc-text2); white-space: nowrap; }
.lg-meta { font-size: 11.5px; color: var(--sc-text3); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.lg-steps { list-style: none; margin: 2px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.lg-step { display: grid; grid-template-columns: 1.4em 1fr; gap: 4px; align-items: baseline; font-size: 12px; }
.lg-tick { color: var(--sc-text3); text-align: center; }
.lg-step-text { overflow-wrap: anywhere; color: var(--sc-text2); }
.lg-step[data-done="1"] .lg-tick { color: var(--sc-ok); }
.lg-step[data-done="1"] .lg-step-text { color: var(--sc-text); }
.lg-more { font-size: 11.5px; color: var(--sc-text3); }
.lg-gain { font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.lg-gain[data-tone="ok"] { color: var(--sc-ok); }
.lg-gain[data-tone="warn"] { color: var(--sc-warn); }
.lg-gain[data-tone=""] { font-weight: 400; font-size: 11.5px; color: var(--sc-text3); }
.lg-sum { margin-top: 8px; }
.lg-message { margin-top: 0; font-size: 12.5px; color: var(--sc-text2); }
`;
