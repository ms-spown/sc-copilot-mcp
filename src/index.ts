import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./core/config.js";
import { createGameVersionResolver, createProbes } from "./providers/probes.js";
import { FleetStore, fleetFilePath } from "./providers/fleet/store.js";
import { GameLog, gameLogConfigFromEnv } from "./providers/gamelog/reader.js";
import { createGameLogHint } from "./providers/telemetry/gamelogHint.js";
import { createTelemetry } from "./providers/telemetry/index.js";
import { createScmdb } from "./providers/scmdb/client.js";
import { createSctClient } from "./providers/sctools/client.js";
import { createUexClient } from "./providers/uex/client.js";
import { createScwClient } from "./providers/wiki/client.js";
import { createMcpServer } from "./server.js";
import { allResources, allTools, createRegistry } from "./tools/registry.js";

// The .env next to the package, never the one in the working directory: Claude starts the
// server from whatever folder is open, which may belong to another project.
dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });

const config = loadConfig();

if (!config.uexToken) {
  console.error("UEXTOKEN is not set: UEX requests go out without credentials.");
}

const gameLog = new GameLog(gameLogConfigFromEnv());

const clients = {
  uexClient: createUexClient(config.uexBaseUrl, config.uexToken),
  scwClient: createScwClient(config.scwBaseUrl),
  sctClient: createSctClient(config.sctBaseUrl),
  scmdb: createScmdb(),
  gameLog,
  fleet: new FleetStore(fleetFilePath()),
  // Off unless SC_TELEMETRY=on. When off this loads nothing and never connects.
  telemetry: createTelemetry({
    enabled: config.telemetry,
    options: { gameLogHint: createGameLogHint(gameLog) },
  }),
};

// A bad SCMCP_TOOLS or SCMCP_PROFILES throws here, at startup, rather than listing nothing.
const registry = createRegistry(
  allTools(clients, createProbes(clients)),
  { tools: config.enabledTools, profiles: config.profiles },
  { gameVersionFor: createGameVersionResolver(clients), resources: allResources(clients) },
);

const server = createMcpServer(registry);

/**
 * Start the server.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Star Citizen MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
