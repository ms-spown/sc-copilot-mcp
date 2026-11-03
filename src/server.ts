import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "./core/useragent.js";
import type { ToolRegistry } from "./tools/registry.js";

/**
 * The MCP server around a tool registry, without any transport. index.ts connects it to stdio;
 * tests connect it to an in-memory client, so they exercise the real protocol.
 */
export function createMcpServer(registry: ToolRegistry): Server {
  const server = new Server(
    { name: "star-citizen-mcp", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registry.list() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return registry.call(name, args);
  });

  return server;
}
