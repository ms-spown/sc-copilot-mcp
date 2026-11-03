// Turns the live telemetry on or off, as a dry run unless --apply, and shows its state.
//
//   npm run telemetry -- status
//   npm run telemetry -- enable              show what would change, write nothing
//   npm run telemetry -- enable --apply      set GRPC_CLIENT_SERVER_ENABLED (user) and SC_TELEMETRY=on (Claude config)
//   npm run telemetry -- enable --session [--launcher <RSI Launcher.exe>] [--apply]
//   npm run telemetry -- disable [--apply]
//
// Options: --config <claude_desktop_config.json>. The logic is in src/install/ (dist/install/).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!fs.existsSync(path.join(root, "dist", "index.js"))) {
  console.error("dist/index.js is missing. Run: npm ci --ignore-scripts && npm run build");
  process.exit(1);
}
const load = (rel) => import(pathToFileURL(path.join(root, "dist", rel)).href);
const { parseArgs, runTelemetry, USAGE } = await load("install/telemetryCli.js");
const { launcherCandidatesFromEnv } = await load("install/telemetrySwitch.js");
const { WindowsUserEnvStore } = await load("install/envStore.js");
const { probeLoopbackPort } = await load("install/portProbe.js");
const { claudeConfigPath } = await load("install/claudeConfigPath.js");
const { userConfigDir } = await load("core/paths.js");

const args = parseArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(`${args.error}\n`);
  console.error(USAGE.join("\n"));
  process.exit(2);
}

// A failure in the middle (PowerShell timing out, a file that cannot be written) ends with a message, not a stack.
// What was already done is recorded in the marker, so `disable` can still undo it.
const runGuarded = (a, d) =>
  runTelemetry(a, d).catch((error) => {
    console.error(`Failed: ${error.message}\nRun "npm run telemetry -- status" to see where things stand.`);
    process.exit(1);
  });

const win = process.platform === "win32";
const result = await runGuarded(args, {
  platform: process.platform,
  store: win ? new WindowsUserEnvStore() : null,
  probe: probeLoopbackPort,
  configPath: args.config ? path.resolve(args.config) : claudeConfigPath(),
  serverName: "sc-copilot",
  markerDir: userConfigDir(),
  now: () => new Date(),
  launcherCandidates: launcherCandidatesFromEnv(process.env),
  fileExists: (file) => fs.existsSync(file),
});
console.log(result.lines.join("\n"));
process.exit(result.code);
