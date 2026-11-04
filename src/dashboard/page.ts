import { CALIBRATION_VIEW_FUNCTIONS } from "./calibrationPanel.js";
import { CALIBRATION_CSS } from "./calibrationStyles.js";
import { LEDGER_VIEW_FUNCTIONS } from "./ledgerPanel.js";
import { LEDGER_CSS } from "./ledgerStyles.js";
import { SESSION_VIEW_FUNCTIONS } from "./sessionPanel.js";
import { SESSION_CSS } from "./sessionStyles.js";
import { dashboardMain } from "./viewApp.js";
import { MOVEMENTS_VIEW_FUNCTIONS } from "./movementsPanel.js";
import { MOVEMENTS_CSS } from "./movementsStyles.js";
import { SPECS_VIEW_FUNCTIONS } from "./specsView.js";
import { SPECS_CSS } from "./specsStyles.js";
import { TRADE_ACTIONS_VIEW_FUNCTIONS } from "./tradeActions.js";
import { TRADE_ACTIONS_CSS } from "./tradeActionsStyles.js";
import { TRADE_VIEW_FUNCTIONS } from "./tradePanel.js";
import { TRADE_CSS } from "./tradeStyles.js";
import { VIEW_FUNCTIONS } from "./viewLogic.js";
import { VIEW_CSS } from "./viewStyles.js";

/**
 * The View is one self-contained page: no CDN, no network, no package, no external font. The pure functions of
 * viewLogic.ts and the interface of viewApp.ts are serialised into one inline script, so the code that is tested
 * under Node is the code that runs in the host.
 *
 * Content-Security-Policy: the page declares its own, as tight as it can be (nothing may load, nothing may connect).
 * The host applies a policy of its own on top; this one can only narrow it.
 */
const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

export function viewScript(): string {
  // viewLogic.ts first, then the ship sheet module (specsView.ts), then the transport ledger panel
  // (ledgerPanel.ts), the commerce card (tradePanel.ts) and its action bar slot (tradeActions.ts): one scope, one object L.
  const all = [
    ...VIEW_FUNCTIONS,
    ...SPECS_VIEW_FUNCTIONS,
    ...LEDGER_VIEW_FUNCTIONS,
    ...TRADE_VIEW_FUNCTIONS,
    ...TRADE_ACTIONS_VIEW_FUNCTIONS,
    ...SESSION_VIEW_FUNCTIONS,
    ...MOVEMENTS_VIEW_FUNCTIONS,
    ...CALIBRATION_VIEW_FUNCTIONS,
  ];
  const functions = all.map((f) => f.toString()).join("\n");
  const names = all.map((f) => f.name).join(", ");
  return [
    '"use strict";',
    "(function () {",
    functions,
    `var L = { ${names} };`,
    `var dashboardMain = ${dashboardMain.toString()};`,
    "dashboardMain(window, document, L);",
    "})();",
  ].join("\n");
}

export function dashboardHtml(): string {
  const script = viewScript();
  if (script.toLowerCase().includes("</script"))
    throw new Error("the View script must not contain a closing script tag");
  return [
    "<!doctype html>",
    '<html lang="fr">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    "<title>Tableau de bord en direct</title>",
    `<style>${VIEW_CSS}${SPECS_CSS}${LEDGER_CSS}${TRADE_CSS}${TRADE_ACTIONS_CSS}${SESSION_CSS}${MOVEMENTS_CSS}${CALIBRATION_CSS}</style>`,
    "</head>",
    "<body>",
    '<div id="app" data-stream="init" data-mode="inline" data-grey="1"></div>',
    `<script>${script}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
