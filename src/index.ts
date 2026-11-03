import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./core/config.js";
import { VERSION } from "./core/useragent.js";
import { createGameVersionResolver, createProbes } from "./providers/probes.js";
import { GameLog, gameLogConfigFromEnv } from "./providers/gamelog/reader.js";
import { createScmdb } from "./providers/scmdb/client.js";
import { createSctClient } from "./providers/sctools/client.js";
import { createUexClient } from "./providers/uex/client.js";
import { createScwClient } from "./providers/wiki/client.js";
import { allTools, createRegistry } from "./tools/registry.js";

// The .env next to the package, never the one in the working directory: Claude starts the
// server from whatever folder is open, which may belong to another project.
dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });

const config = loadConfig();

if (!config.uexToken) {
  console.error("UEXTOKEN is not set: UEX requests go out without credentials.");
}

const clients = {
  uexClient: createUexClient(config.uexBaseUrl, config.uexToken),
  scwClient: createScwClient(config.scwBaseUrl),
  sctClient: createSctClient(config.sctBaseUrl),
  scmdb: createScmdb(),
  gameLog: new GameLog(gameLogConfigFromEnv()),
};

// A bad SCMCP_TOOLS or SCMCP_PROFILES throws here, at startup, rather than listing nothing.
const registry = createRegistry(
  allTools(clients, createProbes(clients)),
  { tools: config.enabledTools, profiles: config.profiles },
  { gameVersionFor: createGameVersionResolver(clients) },
);

const server = new Server(
  {
    name: "star-citizen-mcp",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registry.list() }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return registry.call(name, args);
});

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
