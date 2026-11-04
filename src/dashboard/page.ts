import { CALIBRATION_VIEW_FUNCTIONS } from "./calibrationPanel.js";
import { CALIBRATION_CSS } from "./calibrationStyles.js";
import { HEALTH_VIEW_FUNCTIONS } from "./healthPanel.js";
import { HEALTH_CSS } from "./healthStyles.js";
import { LEDGER_VIEW_FUNCTIONS } from "./ledgerPanel.js";
import { LEDGER_CSS } from "./ledgerStyles.js";
import { SESSION_VIEW_FUNCTIONS } from "./sessionPanel.js";
import { SESSION_CSS } from "./sessionStyles.js";
import { dashboardMain } from "./viewApp.js";
import { minifyScript } from "./scriptMinify.js";
import { MOVEMENTS_VIEW_FUNCTIONS } from "./movementsPanel.js";
import { MOVEMENTS_CSS } from "./movementsStyles.js";
import { SPECS_VIEW_FUNCTIONS } from "./specsView.js";
import { SPECS_CSS } from "./specsStyles.js";
import { TRADE_ACTIONS_VIEW_FUNCTIONS } from "./tradeActions.js";
import { TRADE_ACTIONS_CSS } from "./tradeActionsStyles.js";
import { TRADE_PREFLIGHT_VIEW_FUNCTIONS } from "./tradePreflight.js";
import { TRADE_PREFLIGHT_CSS } from "./tradePreflightStyles.js";
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

/**
 * The style sheet loses what a browser ignores: comments, indentation, line breaks, the blanks around `{ } ; ,`, the blank after a `:` and the
 * last `;` of a block. Nothing else is touched: a quoted string (a `content:` value, a font name) is copied as it is, and no
 * blank that separates two words of a value, a selector or a media query is removed (`a b`, `calc(1px + 2px)`, `and (`).
 * A test checks that a CSS parser reads the two sheets the same.
 */
export function compactCss(css: string): string {
  const parts: string[] = [];
  let i = 0;
  let from = 0;
  const flush = (to: number) => {
    // Outside a string: comments out, blanks collapsed, then the blanks around the four punctuation marks.
    // A punctuation mark after an odd number of backslashes is escaped: it is part of a name (`.e\, .f` is one class and a
    // descendant), and the blanks around it mean something. They are kept.
    const escaped = (text: string, at: number) => {
      let n = 0;
      while (at - 1 - n >= 0 && text[at - 1 - n] === "\\") n += 1;
      return n % 2 === 1;
    };
    const plain = css
      .slice(from, to)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\s+/g, " ")
      .replace(/( ?)([{};,])( ?)/g, (m, a, c, _b, at, text) =>
        escaped(text, at + a.length) ? m : c,
      )
      .replace(/: /g, (m, at, text) => (escaped(text, at) ? m : ":"));
    parts.push(plain);
  };
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      flush(i);
      let j = i + 1;
      while (j < css.length && css[j] !== c) j += css[j] === "\\" ? 2 : 1;
      parts.push(css.slice(i, j + 1));
      i = j + 1;
      from = i;
    } else if (c === "/" && css[i + 1] === "*") {
      // A comment may hold a quote: skip it whole so that the quote does not open a string.
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 2;
    } else {
      i += 1;
    }
  }
  flush(css.length);
  return parts
    .join("")
    .replace(/(?<!\\);}/g, "}")
    .trim();
}

/** The style sheet as written, every module's rules in one string (the page ships `compactCss` of it). */
export const pageCss = (): string =>
  `${VIEW_CSS}${SPECS_CSS}${LEDGER_CSS}${TRADE_CSS}${TRADE_ACTIONS_CSS}${TRADE_PREFLIGHT_CSS}${SESSION_CSS}${MOVEMENTS_CSS}${HEALTH_CSS}${CALIBRATION_CSS}`;

/** The script as assembled, before `minifyScript`: each function as `toString` gives it. */
export function rawViewScript(): string {
  // viewLogic.ts first, then the ship sheet module (specsView.ts), then the transport ledger panel
  // (ledgerPanel.ts), the commerce card (tradePanel.ts) and its action bar slot (tradeActions.ts): one scope, one object L.
  const all = [
    ...VIEW_FUNCTIONS,
    ...SPECS_VIEW_FUNCTIONS,
    ...LEDGER_VIEW_FUNCTIONS,
    ...TRADE_VIEW_FUNCTIONS,
    ...TRADE_ACTIONS_VIEW_FUNCTIONS,
    ...TRADE_PREFLIGHT_VIEW_FUNCTIONS,
    ...SESSION_VIEW_FUNCTIONS,
    ...MOVEMENTS_VIEW_FUNCTIONS,
    ...CALIBRATION_VIEW_FUNCTIONS,
    ...HEALTH_VIEW_FUNCTIONS,
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

/**
 * The script the page ships: `rawViewScript` without comments, indentation, line breaks or any blank that is not needed
 * (see scriptMinify.ts; a test checks that a JavaScript parser reads both the same).
 */
export const viewScript = (): string => minifyScript(rawViewScript());

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
    `<style>${compactCss(pageCss())}</style>`,
    "</head>",
    "<body>",
    '<div id="app" data-stream="init" data-mode="inline" data-grey="1"></div>',
    `<script>${script}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
