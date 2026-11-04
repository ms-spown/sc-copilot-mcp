// The saved play sessions: wipe them. A dry run unless --apply.
//
//   npm run sessions -- wipe            list the session file and its copies, delete nothing
//   npm run sessions -- wipe --apply    delete them
//
// What goes: the sessions file (SCMCP_SESSIONS_FILE, else the per-user data folder) and its copies next to it
// (.v<N>.bak, .bak-<time>, .corrupt-<time>, .lock, .tmp), by name, in that folder only. The cache folder and every
// other file are not touched. Close Claude Desktop first, or the server writes a new file at its next change.
// Only names are printed, never a content. The logic is in src/providers/sessions/wipe.ts (dist/).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!fs.existsSync(path.join(root, "dist", "index.js"))) {
  console.error("dist/index.js is missing. Run: npm ci --ignore-scripts && npm run build");
  process.exit(1);
}
const load = (rel) => import(pathToFileURL(path.join(root, "dist", rel)).href);
const { sessionsFilePath } = await load("providers/sessions/config.js");
const { planWipe, applyWipe, describeWipe } = await load("providers/sessions/wipe.js");

const usage = [
  "Usage: npm run sessions -- wipe [--apply]",
  "  wipe            list the saved sessions file and its copies (a dry run)",
  "  wipe --apply    delete them",
];
const [command, ...rest] = process.argv.slice(2);
const unknown = rest.filter((a) => a !== "--apply");
if (command !== "wipe" || unknown.length) {
  console.error(`${command === "wipe" ? `Unknown option: ${unknown[0]}` : "Unknown or missing command."}\n${usage.join("\n")}`);
  process.exit(2);
}
const apply = rest.includes("--apply");

const plan = await planWipe(sessionsFilePath());
if (plan.refused) {
  console.error(describeWipe(plan, false));
  process.exit(1);
}
if (!apply || plan.files.length === 0) {
  console.log(describeWipe(plan, false));
  process.exit(0);
}
const result = await applyWipe(plan);
console.log(describeWipe(plan, result));
process.exit(result.failed.length ? 1 : 0);
