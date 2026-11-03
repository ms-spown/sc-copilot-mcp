// Preview of the live dashboard View in a real browser, against a fake host and a made-up flight.
//   npm run build && node scripts/dashboard-preview.mjs [port]      then open http://127.0.0.1:4173/
// For the person who works on the View. It is NOT part of the server and the server never runs it.
//
// - Binds to 127.0.0.1 only; serves the View built from dist/, and the compiled test-support modules the page imports.
// - No network access, no game, no Claude Desktop configuration, no file written. Stop with Ctrl+C.
// - The fake host plays the scenario of src/dashboard/testing/scenario.ts through the REAL normaliser and event
//   handler, answers the ui/* requests as the measured host does, and shows what the View sends to the conversation.
// URL parameters: t=<seconds into the story> theme=light|dark w=<px> mode=inline|fullscreen balance=1 session=1
//                 forced=off|waiting|game_without_telemetry|incompatible cut=1 plan=1 scroll=<px>
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
import { specsSamples } from "/dist/dashboard/testing/specsFixtures.js";
const q = new URLSearchParams(location.search);
const seek = Number(q.get("t") ?? 0);
const scenario = new Scenario(Date.now() - seek * 1000);
scenario.advanceTo(seek * 1000);
if (q.get("forced")) scenario.forced = q.get("forced");
if (q.get("cut")) scenario.cut = true;
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
  if (host.displayMode === "fullscreen") { frame.style.width = "100%"; frame.style.height = "100%"; }
  else { setWidth(); frame.style.height = lastHeight + "px"; }
};
const deliver = (m) => {
  frame.contentWindow.postMessage(m, "*");
  if (m.method === "ui/notifications/host-context-changed" && m.params?.displayMode) applyMode();
};
host = createFakeHost({ scenario, theme: $("theme").value, deliver });
window.__host = host; window.__scenario = scenario;
$("specs").value = q.get("specs") ?? "ready";
// The scenario holds the wiki sheet of its ship in the chosen state; the poll sends it through the real delta protocol.
const paintSpecs = () => { scenario.specs = specsSamples(scenario.now)[$("specs").value] ?? null; };
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
    const plan = q.get("plan")
      ? { commodity: "Laranite", buy_terminal: "Port Tressler", sell_terminal: "Area18 TDD", scu: 96, expected_profit_auec: 150000, note: "Route de test" }
      : undefined;
    host.toolResult({ view: "sc_live_dashboard", ...(plan ? { plan } : {}) });
    if (q.get("mode") === "fullscreen") {
      setTimeout(() => host.contextChanged({ displayMode: "fullscreen" }), 200);
    }
  }, 300);
});
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
