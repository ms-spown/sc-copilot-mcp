/**
 * Styles of the calibration line under a suggestion card (calibrationPanel.ts, tradeActions.ts), appended to the View's
 * stylesheet by page.ts. The tokens of viewStyles.ts only, light and dark, 360 to 2000 px. The line is quiet (small,
 * muted); its tag is the card's dashed estimate tag, so it never relies on colour: the words "estimé" and the
 * confidence are in the text.
 */
export const CALIBRATION_CSS = `
.ta-calib { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--sp-2); font-size: var(--fs-xs); color: var(--sc-text3); min-width: 0; }
.ta-calib-text { overflow-wrap: anywhere; min-width: 0; }
.ta-calib-more { flex-basis: 100%; }

`;
