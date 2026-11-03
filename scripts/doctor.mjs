// Checks that the installation is healthy and says how to fix each problem. Local only: it makes
// no network call and never prints a secret. For the data sources, run `npm run check:sources`.
//   npm run build && npm run doctor
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(path.join(root, "dist", rel)).href);

const distBuilt = fs.existsSync(path.join(root, "dist", "index.js"));
if (!distBuilt) {
  console.error("dist/ is missing. Run: npm ci --ignore-scripts && npm run build");
  process.exit(1);
}
const { diagnose, summarize } = await load("install/doctor.js");
const { gatherTelemetryFacts } = await load("install/telemetrySwitch.js");
const { stripBom } = await load("install/mergeConfig.js");
const { WindowsUserEnvStore } = await load("install/envStore.js");
const { probeLoopbackPort } = await load("install/portProbe.js");
const { claudeConfigPath } = await load("install/claudeConfigPath.js");
const { userCacheDir } = await load("core/paths.js");
const { FleetStore, fleetFilePath } = await load("providers/fleet/store.js");
const { GameLog, shortPath } = await load("providers/gamelog/reader.js");

const readOrNull = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const serverName = "sc-copilot";
const configPath = claudeConfigPath();
const claudeConfig = readOrNull(configPath);

// The game log settings live in the Claude config entry, because that is the environment the server runs in.
let entryEnv = {};
try {
  entryEnv = JSON.parse(stripBom(claudeConfig ?? "{}"))?.mcpServers?.[serverName]?.env ?? {};
} catch {
  // Reported by the config check.
}
const logEnv = { ...process.env, ...entryEnv };
const gameLog = new GameLog({ logPath: logEnv.SC_GAME_LOG_PATH, installDir: logEnv.SC_INSTALL_DIR });

const env = readOrNull(path.join(root, ".env"));
const fleet = { exists: false, count: 0 };
try {
  const ships = await new FleetStore(fleetFilePath()).list();
  fleet.exists = fs.existsSync(fleetFilePath());
  fleet.count = ships.length;
} catch (error) {
  fleet.error = error.message;
}

let cacheWritable = true;
try {
  const dir = userCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.accessSync(dir, fs.constants.W_OK);
} catch {
  cacheWritable = false;
}

const gameLogFacts = { configured: gameLog.configured, readable: false };
if (gameLog.configured) {
  try {
    const r = await gameLog.read("current", 64 * 1024);
    gameLogFacts.readable = true;
    gameLogFacts.file = shortPath(r.file);
  } catch (error) {
    gameLogFacts.error = error.message;
  }
}

// Read-only. The port is only tested when SC_TELEMETRY is on in the config; no gRPC connection is ever opened.
const telemetry = await gatherTelemetryFacts({
  configRaw: claudeConfig,
  serverName,
  store: process.platform === "win32" ? new WindowsUserEnvStore() : null,
  probe: probeLoopbackPort,
});

const checks = diagnose({
  nodeVersion: process.version,
  distBuilt,
  envFile: { exists: env !== null, hasToken: /^UEXTOKEN=\S+/m.test(env ?? "") },
  claudeConfig,
  serverName,
  expectedEntry: path.join(root, "dist", "index.js"),
  fleet,
  cacheWritable,
  gameLog: gameLogFacts,
  telemetry,
});

const icon = { ok: "  ok  ", warn: " warn ", fail: " FAIL " };
for (const c of checks) {
  console.log(`${icon[c.status]} ${c.message}`);
  if (c.fix) console.log(`        -> ${c.fix}`);
}
const { failed, warned } = summarize(checks);
console.log(`\n${failed ? `${failed} problem(s) to fix.` : warned ? "Works, with things you may want to set up." : "Everything looks good."} For the data sources themselves: npm run check:sources`);
process.exit(failed ? 1 : 0);
