// Preview of the live dashboard View in a real browser, against a fake host and a made-up flight.
//   npm run build && node scripts/dashboard-preview.mjs [port]      then open http://127.0.0.1:4173/
// For the person who works on the View. It is NOT part of the server and the server never runs it.
//
// - Binds to 127.0.0.1 only; serves the View built from dist/, and the compiled test-support modules the page imports.
// - No network access, no game, no Claude Desktop configuration, no file written. Stop with Ctrl+C.
// - The fake host plays the scenario of src/dashboard/testing/scenario.ts through the REAL normaliser and event
//   handler, answers the ui/* requests as the measured host does, and shows what the View sends to the conversation.
// URL parameters: t=<seconds into the story> theme=light|dark w=<px> mode=inline|fullscreen balance=1 (presses the show-balance button) session=1
//                 forced=off|waiting|game_without_telemetry|incompatible cut=1 plan=1 scroll=<px>
//                 open=1  (unfolds the commerce card's details and the "Mouvements du solde" block)
//                 trade=movements  (the story plus balance movements of every kind: an item, a probable reward, an unexplained
//                 fall, a probable insurance cost; the "Mouvements du solde" block; src/dashboard/testing/movementsScenario.ts)
//                 trade=story|unknown|partial|second|none  (the commerce card, with a made-up trade journal that follows
//                 the figures of a real run: see src/dashboard/testing/tradeScenario.ts; its loop lasts 600 s, the run is
//                 settled from t=215; it implies plan=full: a plan with prices and a price curve; none = no journal)
//                 transport=story|off|loading|unreadable|empty|none   (the transport ledger; story by default, none = no field)
//                 suggest=ok|wait|error|empty|nospeed|reported|slow  (what the commerce action bar's tool answers: invented
//                 routes from src/dashboard/testing/suggestFixtures.ts, no UEX; slow = 4 s of virtual waiting)
//                 preflight=valid|watch|drifted|unknown|estimate|wait  (what the pre-flight check of the plan answers: invented verdicts from
//                 src/dashboard/testing/preflightFixtures.ts, no UEX; press it with click=Vérifier avant de partir; needs a plan: plan=1 or trade=...)
//                 trade=refusal  (the story, then a purchase the game refuses at 400 s because the price moved: the alert; use t=410)
//                 calib=1  (the route calibration section the server sends with the balance: invented ratios for Laranite on the
//                 route Port Tressler > Area18 TDD (4 runs), Gold (2 runs, wide spread) and Agricium (8 runs); needs balance=1)
//                 click=<button label>  (presses it once the page is up, e.g. click=Plus rentable)
//                 refine=1 (opens "Affiner")  card=1 (opens the details of the first card)
//                 fw=<px>  (width of the frame in full screen, to see a narrow host at 360 px in a window that cannot be that narrow)
//                 conn=disconnected|menu|closed|online  (the connection read from Game.log)
//                 sessions=story|empty|off|stale|ended|readonly|gross|none  (the saved play session bar; story by default; the
//                 figures are invented, see src/dashboard/testing/sessionScenario.ts)
//                 menu=1|detail  (opens the "Sessions" menu, or the detail of session 2, after the page has loaded)
//                 health=ok|nolog|unreadable|unregistered|sessionsoff|degraded|readonly|off|custom|everything  (the health strip: what is
//                 wired and what is missing; made-up facts through the server builder, see src/dashboard/testing/healthScenario.ts;
//                 without it the page behaves like a server that sends no health)   seen=1  (this browser remembers the legend was read)
//                 help=1  (presses the "?" button once the page is up)
//                 specs=ready|unknown|ambiguous|pending|error|none  (the ship sheet from the wiki; default ready; the figures
//                 are synthetic, see src/dashboard/testing/specsFixtures.ts; the story's ship is always the same Cutter)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const port = Number(process.argv[2] ?? 4173);

const page = await import(pathToFileURL(path.join(dist, "dashboard", "page.js")).href);

const HARNESS = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Dashboard preview</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 13px system-ui, sans-serif; background: Canvas; color: CanvasText; }
  #bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid GrayText; position: sticky; top: 0; background: Canvas; z-index: 2; }
  #bar button, #bar select { font: inherit; }
  #stage { padding: 12px; }
  #frame { border: 1px dashed GrayText; display: block; width: 560px; height: 180px; background: transparent; color-scheme: normal; }
  body[data-mode="fullscreen"] #stage { position: fixed; inset: 36px 0 0 0; padding: 0; background: Canvas; }
  body[data-mode="fullscreen"] #frame { width: 100%; height: 100%; border: 0; }
  #log { font: 11px ui-monospace, monospace; white-space: pre-wrap; max-height: 120px; overflow: auto; padding: 6px 10px; border-top: 1px solid GrayText; }
</style></head>
<body data-mode="inline">
<div id="bar">
  <b>Aperçu</b>
  <label>thème <select id="theme"><option>dark</option><option>light</option></select></label>
  <label>largeur <select id="w"><option>360</option><option selected>560</option><option>720</option><option>1280</option><option>2000</option></select></label>
  <label>état <select id="forced"><option value="">histoire</option><option>off</option><option>waiting</option><option>game_without_telemetry</option><option>incompatible</option></select></label>
  <label>fiche <select id="specs"><option>ready</option><option>unknown</option><option>ambiguous</option><option>pending</option><option>error</option><option>none</option></select></label>
  <button id="cut">couper le flux</button>
  <span id="clock"></span>
</div>
<div id="stage"><iframe id="frame" sandbox="allow-scripts allow-same-origin" title="view"></iframe></div>
<div id="log"></div>
<script type="module">
import { Scenario } from "/dist/dashboard/testing/scenario.js";
import { createFakeHost } from "/dist/dashboard/testing/fakeHost.js";
import { transportLedger } from "/dist/dashboard/testing/ledgerScenario.js";
import { specsSamples } from "/dist/dashboard/testing/specsFixtures.js";
import { sessionBar, sessionToolAnswer } from "/dist/dashboard/testing/sessionScenario.js";
import { tradeBalanceAt, tradeLedger } from "/dist/dashboard/testing/tradeScenario.js";
import { suggestAnswer } from "/dist/dashboard/testing/suggestFixtures.js";
import { healthSection } from "/dist/dashboard/testing/healthScenario.js";
import { movementBalanceAt, movementsLedger } from "/dist/dashboard/testing/movementsScenario.js";
const q = new URLSearchParams(location.search);
const seek = Number(q.get("t") ?? 0);
const scenario = new Scenario(Date.now() - seek * 1000);
const trade = q.get("trade");
if (trade) scenario.uec = trade === "movements" ? movementBalanceAt : tradeBalanceAt; // before the first frame: the stream carries the balance of the trade story
scenario.advanceTo(seek * 1000);
if (q.get("forced")) scenario.forced = q.get("forced");
if (q.get("cut")) scenario.cut = true;
// conn=disconnected|menu|closed|online: what Game.log says (3 minutes ago); a kick for inactivity when disconnected.
if (q.get("conn")) {
  const state = q.get("conn");
  scenario.connection = {
    state,
    since: new Date(scenario.now - 185000).toISOString(),
    code: state === "disconnected" ? 30028 : null,
    reason: state === "disconnected" ? "Remote Disconnect - player inactive" : null,
  };
}
const frame = document.getElementById("frame");
const $ = (id) => document.getElementById(id);
$("theme").value = q.get("theme") ?? "dark";
const paintTheme = () => { document.documentElement.style.colorScheme = $("theme").value; };
paintTheme();
$("w").value = q.get("w") ?? "560";
$("forced").value = q.get("forced") ?? "";
const log = (s) => { $("log").textContent = (s + "\\n" + $("log").textContent).slice(0, 3000); };
let host;
let lastHeight = 180;
const applyMode = () => {
  document.body.dataset.mode = host.displayMode;
  if (host.displayMode === "fullscreen") { frame.style.width = q.get("fw") ? q.get("fw") + "px" : "100%"; frame.style.height = "100%"; }
  else { setWidth(); frame.style.height = lastHeight + "px"; }
};
const deliver = (m) => {
  frame.contentWindow.postMessage(m, "*");
  if (m.method === "ui/notifications/host-context-changed" && m.params?.displayMode) applyMode();
};
const suggestVariant = q.get("suggest") ?? "ok";
const preflightVariant = q.get("preflight") ?? "valid";
host = createFakeHost({
  scenario,
  theme: $("theme").value,
  deliver,
  suggest: (args) => {
    const answer = suggestAnswer(args, { variant: suggestVariant === "slow" ? "ok" : suggestVariant, preflight: preflightVariant });
    return suggestVariant === "slow" ? new Promise((resolve) => setTimeout(() => resolve(answer), 4000)) : answer;
  },
});
window.__host = host; window.__scenario = scenario;
// The transport ledger: invented log lines through the real parser and ledger code, with the balance of the story.
// The scenario sends it through the real delta protocol (hash, unchanged) like the other sections.
const transport = q.get("transport") ?? "story";
if (transport !== "none") {
  const plan = q.get("plan") ? { expected_profit_auec: 150000 } : undefined;
  scenario.ledger = (include, nowMs) => transportLedger(nowMs, scenario.epoch, include, transport, plan);
}
// The saved play session bar and the session tools: invented sessions, the real shapes of the server's answers.
const sess = q.get("sessions") ?? "story";
if (sess !== "none") {
  host.overrides.poll = (base, include) => ({ ...base, sessions: sessionBar(scenario.now, include, sess) });
  host.overrides.tool = (name, args) => sessionToolAnswer(name, args, scenario.now);
}
// health=...: the health strip. Composed with the session override above (both rewrite the poll).
const hv = q.get("health");
if (hv) {
  const prev = host.overrides.poll;
  host.overrides.poll = (base, include) => ({ ...(prev ? prev(base, include) : base), health: healthSection(hv, scenario.now) });
}
// seen=1: the legend was read in this browser; otherwise it is the first open (the flag lives in this origin's storage).
try { if (q.get("seen")) localStorage.setItem("sc-copilot-help-seen", "1"); else localStorage.removeItem("sc-copilot-help-seen"); } catch {}
if (q.get("help")) frame.addEventListener("load", () => setTimeout(() => {
  const b = [...frame.contentDocument.querySelectorAll("button")].find((x) => x.textContent === "?");
  if (b) b.click();
}, 1800));
// trade=...: the commerce card. The made-up stream carries the balance of the trade story, and the ledger holds the
// trade section that the real model builds from invented transactions.
const TRADE_PLAN = { commodity: "Laranite", buy_terminal: "Port Tressler", sell_terminal: "Area18 TDD", scu: 696, expected_profit_auec: 180000, buy_unit_price: 189, sell_unit_price: 457, est_trip_minutes: 25, safety_note: "Route peu risquée", price_points: [430, 436, 441, 450, 447, 455, 462, 458, 449, 452, 460, 457, 463, 459], price_points_label: "14 derniers relevés" };
if (trade) {
  scenario.ledger = trade === "movements"
    ? (include, nowMs) => movementsLedger(nowMs, scenario.epoch, include, TRADE_PLAN)
    : (include, nowMs) => tradeLedger(nowMs, scenario.epoch, include, trade, TRADE_PLAN);
}
// calib=1: the calibration section the real server adds to the ledger, only for a poll that asked for the balance.
if (q.get("calib")) {
  const g = (over) => ({ kind: "commodity", commodity: "Laranite", buy_terminal: null, sell_terminal: null, n: 4, confidence: "medium", gross_ratio: 0.737, gross_min: 0.65, gross_max: 0.83, high_variance: false, net_ratio: 0.762, net_n: 4, net_confidence: "medium", fee_rate: 0.137, fee_n: 4, last_run_age_days: 1, quantity_adjusted: 0, quantity_unknown: 0, goods_unverified: true, ...over });
  const CALIBRATION = { v: 1, patch_line: "4.10", groups: [
    g({}),
    g({ kind: "route", buy_terminal: "Port Tressler", sell_terminal: "Area18 TDD" }),
    g({ commodity: "Gold", n: 2, confidence: "low", gross_ratio: 0.58, gross_min: 0.2, gross_max: 0.96, high_variance: true, net_ratio: null, net_n: 0, fee_n: 2 }),
    g({ commodity: "Agricium", n: 8, confidence: "medium", gross_ratio: 0.91, gross_min: 0.8, gross_max: 1.04, net_ratio: 0.88, net_n: 8, fee_rate: 0.052, fee_n: 8, last_run_age_days: 23 }),
  ] };
  const withoutCalibration = scenario.ledger;
  if (withoutCalibration) scenario.ledger = (include, nowMs) => { const l = withoutCalibration(include, nowMs); return include ? { ...l, calibration: CALIBRATION } : l; };
}
$("specs").value = q.get("specs") ?? "ready";
// The scenario holds the wiki sheet of its ship in the chosen state; the poll sends it through the real delta protocol.
const paintSpecs = () => {
  const sample = specsSamples(scenario.now)[$("specs").value] ?? null;
  // The made-up routes are sized for a big hold: give the sheet one, so the bar's hold matches what it shows.
  scenario.specs = sample && sample.status === "ready" ? { ...sample, name: "Hull C", cargo_scu: 696 } : sample;
};
paintSpecs();
$("specs").onchange = paintSpecs;
const setWidth = () => { frame.style.width = $("w").value + "px"; };
setWidth();
$("w").onchange = setWidth;
$("theme").onchange = () => { paintTheme(); host.contextChanged({ theme: $("theme").value }); };
$("forced").onchange = () => { scenario.forced = $("forced").value || null; };
$("cut").onclick = () => { scenario.cut = !scenario.cut; $("cut").textContent = scenario.cut ? "rétablir le flux" : "couper le flux"; };
window.addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow) return;
  const m = e.data;
  if (m && m.method === "ui/notifications/size-changed" && document.body.dataset.mode === "inline") {
    lastHeight = Math.ceil(m.params.height);
    frame.style.height = lastHeight + "px";
  }
  if (m && (m.method === "ui/message" || m.method === "ui/update-model-context")) log(m.method + " " + JSON.stringify(m.params).slice(0, 400));
  host.receive(m, Date.now());
  if (m && m.method === "ui/message") log("-> conversation: " + (m.params.content[0].text || "").slice(0, 300));
});
frame.addEventListener("load", () => {
  // The tool result Claude sends once the dashboard tool has returned.
  setTimeout(() => {
    const plan = trade
      ? TRADE_PLAN
      : q.get("plan")
      ? { commodity: "Laranite", buy_terminal: "Port Tressler", sell_terminal: "Area18 TDD", scu: 96, expected_profit_auec: 150000, note: "Route de test" }
      : undefined;
    host.toolResult({ view: "sc_live_dashboard", ...(plan ? { plan } : {}) });
    if (q.get("mode") === "fullscreen") {
      setTimeout(() => host.contextChanged({ displayMode: "fullscreen" }), 200);
    }
  }, 300);
});
// balance=1: press "Afficher le solde" in the page, as the player would (the preview frame is same-origin).
if (q.get("balance")) frame.addEventListener("load", () => setTimeout(() => {
  const b = [...frame.contentDocument.querySelectorAll("button")].find((x) => x.textContent === "Afficher le solde");
  if (b) b.click();
}, 1200));
// click=<label>, refine=1, card=1: drive the page the way the player would (same-origin frame).
if (q.get("click") || q.get("refine") || q.get("card")) frame.addEventListener("load", () => setTimeout(() => {
  const doc = frame.contentDocument;
  if (q.get("refine")) doc.querySelectorAll("details.ta-refine").forEach((d) => { d.open = true; });
  if (q.get("click")) {
    const b = [...doc.querySelectorAll("button")].find((x) => x.textContent === q.get("click") && x.offsetParent !== null);
    if (b) b.click();
  }
  if (q.get("card")) setTimeout(() => doc.querySelectorAll("details.ta-more").forEach((d, i) => { if (i === 1) d.open = true; }), 400);
}, 3000));
// menu=1: press "Sessions" in the page; menu=detail: then open session 2.
if (q.get("menu")) frame.addEventListener("load", () => {
  setTimeout(() => {
    const b = [...frame.contentDocument.querySelectorAll("button")].find((x) => x.textContent.startsWith("Sessions"));
    if (b) b.click();
  }, 1800);
  if (q.get("menu") === "detail") setTimeout(() => {
    const r = [...frame.contentDocument.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || "").startsWith("Ouvrir la session 2"));
    if (r) r.click();
  }, 2600);
});
// open=1: unfold the commerce card's details and the "Mouvements du solde" block (they are folded by default).
if (q.get("open")) frame.addEventListener("load", () => setTimeout(() => {
  for (const d of frame.contentDocument.querySelectorAll("details.tr-more, details.mv")) d.open = true;
}, 2200));
if (q.get("scroll")) frame.addEventListener("load", () => setTimeout(() => frame.contentWindow.scrollTo(0, Number(q.get("scroll"))), 1500));
frame.src = "/view.html";
setInterval(() => { $("clock").textContent = "histoire : " + Math.round(scenario.t / 1000) + " s"; }, 500);
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (status, type, body) => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  if (url.pathname === "/") return send(200, "text/html; charset=utf-8", HARNESS);
  if (url.pathname === "/view.html") return send(200, "text/html; charset=utf-8", page.dashboardHtml());
  if (url.pathname.startsWith("/dist/") && url.pathname.endsWith(".js")) {
    const file = path.resolve(root, "." + url.pathname);
    if (file.startsWith(dist + path.sep) && fs.existsSync(file)) {
      return send(200, "text/javascript; charset=utf-8", fs.readFileSync(file));
    }
  }
  return send(404, "text/plain", "not found");
});
server.listen(port, "127.0.0.1", () => {
  console.log(`dashboard preview on http://127.0.0.1:${port}/  (Ctrl+C to stop)`);
});
