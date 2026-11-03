import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "./core/useragent.js";
import { findPrompt, PROMPTS } from "./prompts.js";
import type { ToolRegistry } from "./tools/registry.js";

/**
 * The MCP server around a tool registry, without any transport. index.ts connects it to stdio;
 * tests connect it to an in-memory client, so they exercise the real protocol.
 */
export function createMcpServer(registry: ToolRegistry): Server {
  const server = new Server(
    { name: "star-citizen-mcp", version: VERSION },
    { capabilities: { tools: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registry.list() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return registry.call(name, args);
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(({ name, title, description, arguments: args }) => ({
      name,
      title,
      description,
      arguments: args,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = findPrompt(request.params.name);
    if (!prompt) throw new Error(`Unknown prompt: ${request.params.name}`);
    const args = request.params.arguments ?? {};
    const missing = prompt.arguments.filter((a) => a.required && !args[a.name]?.trim());
    if (missing.length) {
      throw new Error(`Missing required argument: ${missing.map((a) => a.name).join(", ")}`);
    }
    return {
      description: prompt.description,
      messages: [
        { role: "user" as const, content: { type: "text" as const, text: prompt.render(args) } },
      ],
    };
  });

  return server;
}
