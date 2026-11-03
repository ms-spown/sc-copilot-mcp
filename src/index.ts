import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import { loadConfig } from "./core/config.js";
import { VERSION } from "./core/useragent.js";
import { createSctClient } from "./providers/sctools/client.js";
import { createUexClient } from "./providers/uex/client.js";
import { createScwClient } from "./providers/wiki/client.js";
import { allTools, createRegistry } from "./tools/registry.js";

dotenv.config({ quiet: true });

const config = loadConfig();

if (!config.uexToken) {
  console.error("UEXTOKEN is not set: UEX requests go out without credentials.");
}

const registry = createRegistry(
  allTools({
    uexClient: createUexClient(config.uexBaseUrl, config.uexToken),
    scwClient: createScwClient(config.scwBaseUrl),
    sctClient: createSctClient(config.sctBaseUrl),
  }),
  config.enabledTools,
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
