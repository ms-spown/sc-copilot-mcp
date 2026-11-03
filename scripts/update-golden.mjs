// Refreshes src/tools/tools-surface.golden.json (tool names and input schemas) from the code and
// says what changed. Only run it when the change is intended, and explain it in the commit message.
//   npm run build && npm run golden:update
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(path.join(root, "dist", rel)).href);

const { allTools, createRegistry } = await load("tools/registry.js");
const { Scmdb } = await load("providers/scmdb/store.js");
const { GameLog } = await load("providers/gamelog/reader.js");
const { FleetStore } = await load("providers/fleet/store.js");
const { createTelemetry } = await load("providers/telemetry/index.js");

const unused = { defaults: {}, get: async () => ({ data: {} }) };
const registry = createRegistry(
  allTools({
    uexClient: unused,
    scwClient: unused,
    sctClient: unused,
    scmdb: new Scmdb({ raw: unused, api: unused, repo: "o/r", cacheDir: () => "" }),
    gameLog: new GameLog({}),
    fleet: new FleetStore("unused.json"),
    // Enabled only so that the optional tools are part of the frozen surface; it never connects.
    telemetry: createTelemetry({ enabled: true }),
  }),
  {},
);

const now = registry
  .list()
  .map(({ name, inputSchema }) => ({ name, inputSchema }))
  .sort((a, b) => a.name.localeCompare(b.name));

const file = path.join(root, "src", "tools", "tools-surface.golden.json");
let before = [];
try {
  before = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  // No previous file: everything counts as added.
}
const old = new Map(before.map((t) => [t.name, JSON.stringify(t.inputSchema)]));

const added = now.filter((t) => !old.has(t.name)).map((t) => t.name);
const removed = [...old.keys()].filter((n) => !now.some((t) => t.name === n));
const changed = now.filter((t) => old.has(t.name) && old.get(t.name) !== JSON.stringify(t.inputSchema)).map((t) => t.name);

fs.writeFileSync(file, `${JSON.stringify(now, null, 2)}\n`);
console.log(`tools: ${now.length}`);
console.log(`added:   ${added.join(", ") || "-"}`);
console.log(`removed: ${removed.join(", ") || "-"}`);
console.log(`changed: ${changed.join(", ") || "-"}`);
