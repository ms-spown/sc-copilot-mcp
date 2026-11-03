// Regenerates docs/TOOLS.md from the tool definitions. Run after changing a tool.
//   npm run build && npm run docs:tools
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(path.join(root, "dist", rel)).href);

const { renderToolDocs } = await load("docs/toolDocs.js");
const { allTools } = await load("tools/registry.js");
const { Scmdb } = await load("providers/scmdb/store.js");
const { GameLog } = await load("providers/gamelog/reader.js");
const { FleetStore } = await load("providers/fleet/store.js");

// Only the definitions are read, so the clients are never called.
const unused = { defaults: {}, get: async () => ({ data: {} }) };
const tools = allTools({
  uexClient: unused,
  scwClient: unused,
  sctClient: unused,
  scmdb: new Scmdb({ raw: unused, api: unused, repo: "o/r", cacheDir: () => "" }),
  gameLog: new GameLog({}),
  fleet: new FleetStore("unused.json"),
});

const target = path.join(root, "docs", "TOOLS.md");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, renderToolDocs(tools));
console.log(`wrote ${path.relative(root, target)} (${tools.length} tools)`);
