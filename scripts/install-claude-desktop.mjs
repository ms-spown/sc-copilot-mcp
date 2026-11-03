// Adds this server to Claude Desktop's config with a minimal merge. Dry run unless --apply.
//
//   node scripts/install-claude-desktop.mjs                 show what would change, write nothing
//   node scripts/install-claude-desktop.mjs --apply         back up the file, then write
//
// Options: --config <path>  --name <server name>  --profiles core,trade,data,local
//          --install-dir <folder with Game.log>   --game-log <Game.log path>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { planMerge, describePlan, ConfigError } = await import(
  pathToFileURL(path.join(root, "dist/install/mergeConfig.js")).href
);

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const apply = args.includes("--apply");
const name = opt("name", "sc-copilot");
const configPath =
  opt("config") ?? path.join(process.env.APPDATA ?? path.join(process.env.HOME ?? ".", ".config"), "Claude", "claude_desktop_config.json");

const env = { SCMCP_PROFILES: opt("profiles", "core,trade,data,local") };
if (opt("install-dir")) env.SC_INSTALL_DIR = opt("install-dir");
if (opt("game-log")) env.SC_GAME_LOG_PATH = opt("game-log");

const entry = { command: process.execPath, args: [path.join(root, "dist", "index.js")], env };

if (!fs.existsSync(path.join(root, "dist", "index.js"))) {
  console.error("dist/index.js is missing. Run: npm ci --ignore-scripts && npm run build");
  process.exit(1);
}

let raw = null;
try {
  raw = fs.readFileSync(configPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

let plan;
try {
  plan = planMerge(raw, name, entry);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

console.log(`Config file: ${raw === null ? "(does not exist yet) " : ""}${configPath}`);
console.log(describePlan(plan, name));
console.log("\nNo secret is written there. Put the UEX token in a .env file next to package.json:  UEXTOKEN=...");

if (!apply) {
  console.log("\nDry run: nothing was written. Re-run with --apply to back up the file and write this entry.");
  process.exit(0);
}
if (plan.action === "unchanged") {
  console.log("\nAlready up to date: nothing to write.");
  process.exit(0);
}

fs.mkdirSync(path.dirname(configPath), { recursive: true });
if (raw !== null) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${configPath}.bak-${stamp}`;
  fs.copyFileSync(configPath, backup);
  console.log(`\nBackup written: ${backup}`);
}
const tmp = `${configPath}.${process.pid}.tmp`;
// The original text with only this entry changed: BOM, line endings, indentation and number spellings
// of the user's other servers stay as they were (re-printing the parsed file would not keep them).
fs.writeFileSync(tmp, plan.text);
fs.renameSync(tmp, configPath);
console.log("Config updated. Restart Claude Desktop to load the server.");
