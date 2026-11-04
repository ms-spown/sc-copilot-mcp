/**
 * Styles of the pre-flight block and the refusal alert (tradePreflight.ts), appended to the View's stylesheet by page.ts.
 * The tokens of viewStyles.ts only, light and dark, no image, no font, no animation. A verdict never relies on colour:
 * each chip starts with a symbol and carries its words.
 */
export const TRADE_PREFLIGHT_CSS = `
.tr-preflight { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); border: 1px solid var(--sc-line); border-radius: var(--r-l); background: var(--sc-bg2); min-width: 0; }
.pf-alert { padding: var(--sp-3) var(--sp-4); border: 1px solid var(--sc-warn); border-left-width: 4px; border-radius: var(--r-m); background: var(--tint-warn); }
.pf-alert-text { margin: 0; font-weight: 650; color: var(--sc-warn); white-space: pre-line; }
.pf-alert[data-tone="fatal"] { border-color: var(--sc-bad); background: var(--tint-bad); }
.pf-alert[data-tone="fatal"] .pf-alert-text { color: var(--sc-bad); font-size: var(--fs-m); }
.pf-alert[data-tone="fatal"] .pf-alert-text::before { content: "\\2715"; margin-right: 6px; }
.pf-loss { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-2); font-size: var(--fs-s); color: var(--sc-text2); min-width: 0; }
.pf-why-sum { cursor: pointer; color: var(--sc-text2); font-weight: 600; }
.pf-why-sum:focus-visible { outline: 2px solid var(--sc-ring); outline-offset: 2px; }
.pf-why-text, .pf-next-text { margin: var(--sp-1) 0 0; white-space: pre-line; overflow-wrap: anywhere; }
.pf-next-title { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); font-weight: 650; letter-spacing: 0.07em; text-transform: uppercase; color: var(--sc-text2); }
.pf-loss .pf-ask { align-self: flex-start; margin-top: var(--sp-1); }
.pf-alert-text::before { content: "\\26A0\\00a0"; }
.pf-alert-when { margin: 2px 0 0; font-size: var(--fs-s); color: var(--sc-text2); }
.pf-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.pf-title { margin: 0; font-size: var(--fs-l); font-weight: 650; }
.pf-status, .pf-leg, .pf-note { margin: 0; font-size: var(--fs-s); color: var(--sc-text2); white-space: pre-line; }
.pf-chip { font-size: var(--fs-s); font-weight: 650; padding: 1px 10px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
[data-tone="ok"] { --pf-tone: var(--sc-ok); }
[data-tone="info"] { --pf-tone: var(--sc-info); }
[data-tone="warn"] { --pf-tone: var(--sc-warn); }
[data-tone="bad"] { --pf-tone: var(--sc-bad); }
.pf-chip[data-tone], .pf-action[data-tone] { color: var(--pf-tone, var(--sc-text2)); }
.pf-chip[data-tone="off"] { border-style: dashed; }
.pf-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.pf-run { border-color: var(--sc-info); color: var(--sc-info); font-weight: 650; cursor: pointer; }
.pf-run[data-attention="1"] { background: var(--sc-inv-bg); color: var(--sc-inv-text); border-color: var(--sc-inv-bg); }
.pf-run:disabled { cursor: progress; opacity: 0.6; }
.pf-ask { color: var(--sc-text2); cursor: pointer; }
.pf-run:focus-visible, .pf-ask:focus-visible, .pf-more-sum:focus-visible { outline: 2px solid var(--sc-ring); outline-offset: 2px; }
.pf-result { display: flex; flex-direction: column; gap: var(--sp-2); }
.pf-headline, .pf-action { margin: 0; font-weight: 650; overflow-wrap: anywhere; }
.pf-margin { margin: 0; font-variant-numeric: tabular-nums; }
.pf-legs { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: var(--sp-2); }
.pf-leg { padding: var(--sp-2) var(--sp-3); border: 1px solid var(--sc-line); border-left: 4px solid var(--pf-tone, var(--sc-border)); border-radius: var(--r-m); background: var(--sc-bg); min-width: 0; overflow-wrap: anywhere; }
.pf-more-sum { cursor: pointer; color: var(--sc-text3); font-size: var(--fs-xs); }
.pf-line { background: var(--tint-warn); color: var(--sc-warn); }
.pf-line[data-tone="fatal"] { background: var(--sc-bad); color: var(--sc-bg); font-weight: 650; white-space: pre-line; }
[data-mode=inline] .pf-loss { padding: 0 var(--sp-3); }
`;
