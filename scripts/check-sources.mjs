// "New patch" check: asks every data source for its version and checks that the files and
// fields this server relies on still have the expected shape. Read-only. Takes a couple of
// minutes on the first run (SCMDB files are downloaded into the cache), seconds afterwards.
//
//   npm run build && node scripts/check-sources.mjs
//
// Exit code 0 = all sources answered and kept their shape; 1 = something to look at.
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(path.join(root, "dist", rel)).href);

const { loadConfig } = await load("core/config.js");
const { createUexClient } = await load("providers/uex/client.js");
const { createScwClient } = await load("providers/wiki/client.js");
const { createSctClient } = await load("providers/sctools/client.js");
const { createScmdb } = await load("providers/scmdb/client.js");
const { GameLog, gameLogConfigFromEnv } = await load("providers/gamelog/reader.js");
const { FleetStore, fleetFilePath } = await load("providers/fleet/store.js");
const { createProbes } = await load("providers/probes.js");
const { collectStatus } = await load("tools/status.js");

// Same environment as the server: the .env next to the package, then the game-log settings from the
// Claude Desktop entry (that is where they live), unless already set in the shell.
dotenv.config({ path: path.join(root, ".env"), quiet: true });
try {
  const cfg = path.join(process.env.APPDATA ?? path.join(process.env.HOME ?? ".", ".config"), "Claude", "claude_desktop_config.json");
  const env = JSON.parse(fs.readFileSync(cfg, "utf8"))?.mcpServers?.["sc-copilot"]?.env ?? {};
  for (const key of ["SC_INSTALL_DIR", "SC_GAME_LOG_PATH"]) if (env[key] && !process.env[key]) process.env[key] = env[key];
} catch {
  // No Claude config: the log simply stays off.
}
const config = loadConfig();
console.log(`UEX token: ${config.uexToken ? "set" : "not set (public endpoints only)"}
`);
const clients = {
  uexClient: createUexClient(config.uexBaseUrl, config.uexToken),
  scwClient: createScwClient(config.scwBaseUrl),
  sctClient: createSctClient(config.sctBaseUrl),
  scmdb: createScmdb(),
  gameLog: new GameLog(gameLogConfigFromEnv()),
  fleet: new FleetStore(fleetFilePath()),
};

let failures = 0;
const line = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? `  ${detail}` : ""}`);
};

console.log("== Versions per source (sc_data_status)");
const status = await collectStatus(createProbes(clients));
for (const s of status.sources) {
  const v = [s.live && `live ${s.live.version}`, s.ptu && `ptu ${s.ptu.version}`, ...(s.unlabelled ?? []).map((u) => `unlabelled ${u.version}`)]
    .filter(Boolean)
    .join(" | ");
  line(s.status === "ok" || s.status === "not_configured", `${s.id} [${s.status}]`, v || (s.error ?? ""));
}
for (const w of status.warnings) console.log(`  note  ${w}`);

console.log("\n== UEX: the calls the tools depend on");
for (const [label, url, params] of [
  ["game_versions", "/game_versions"],
  ["vehicles (ship names)", "/vehicles"],
  ["commodities", "/commodities"],
  ["terminals", "/terminals"],
  ["commodities_routes (needs an origin)", "/commodities_routes", { id_commodity: 1, scu: 696 }],
]) {
  try {
    const r = await clients.uexClient.get(url, { params });
    line(Array.isArray(r.data.data) || typeof r.data.data === "object", label, `${Array.isArray(r.data.data) ? r.data.data.length + " rows" : "object"}`);
  } catch (e) {
    line(false, label, e.message);
  }
}

console.log("\n== SCMDB: every file kind, LIVE then PTU (shape is checked on load)");
for (const channel of ["live", "ptu"]) {
  for (const kind of ["merged", "crafting_blueprints", "mining_data", "mining_equipment"]) {
    try {
      const f = await clients.scmdb.file(channel, kind);
      line(true, `${channel} ${kind}`, f.version);
    } catch (e) {
      // A missing PTU is normal between test cycles; anything else is not.
      const absent = channel === "ptu" && /no PTU build/.test(e.message);
      if (absent) console.log(`  --    ${channel} ${kind}  no PTU build right now`);
      else line(false, `${channel} ${kind}`, e.message);
    }
  }
  try {
    const d = await clients.scmdb.deltas(channel);
    line(true, `${channel} deltas`, `${d.data.pairs.length} updates, newest ${d.data.pairs[0]?.to}`);
  } catch (e) {
    if (channel === "ptu" && /no PTU build/.test(e.message)) console.log(`  --    ptu deltas  no PTU build right now`);
    else line(false, `${channel} deltas`, e.message);
  }
}

console.log("\n== Game.log");
if (!clients.gameLog.configured) console.log("  --    not configured (SC_GAME_LOG_PATH / SC_INSTALL_DIR)");
else {
  try {
    const r = await clients.gameLog.read();
    const s = r.parsed.session;
    line(
      Boolean(s.game_version && s.build),
      "header",
      `version ${s.game_version} build ${s.build} env ${s.environment}; ${r.parsed.events.length} events, ${r.parsed.stats.ignored}/${r.parsed.stats.lines} lines ignored`,
    );
  } catch (e) {
    line(false, "read", e.message);
  }
}

console.log(`\n${failures === 0 ? "All sources look fine." : `${failures} check(s) failed: see FAIL lines above.`}`);
process.exit(failures === 0 ? 0 : 1);
