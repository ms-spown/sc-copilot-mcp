import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { UI_EXTENSION_ID, UI_MIME_TYPE } from "./dashboard/constants.js";
import { VERSION } from "./core/useragent.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { findPrompt, PROMPTS } from "./prompts.js";
import type { ToolRegistry } from "./tools/registry.js";

/**
 * The MCP server around a tool registry, without any transport. index.ts connects it to stdio;
 * tests connect it to an in-memory client, so they exercise the real protocol.
 */
export function createMcpServer(registry: ToolRegistry): Server {
  // The resources capability is announced only when there is something to serve (the dashboard View needs live
  // telemetry to be on). With telemetry off the server is exactly what it was before the dashboard existed.
  const serveResources = registry.listResources().length > 0;
  const server = new Server(
    { name: "sc-copilot-mcp", version: VERSION },
    {
      capabilities: { tools: {}, prompts: {}, ...(serveResources ? { resources: {} } : {}) },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  /** Does the connected client render MCP App Views? (It says so in `capabilities.extensions` at initialize.) */
  const clientRendersViews = (): boolean => {
    const extensions = (server.getClientCapabilities() as { extensions?: Record<string, unknown> })
      ?.extensions;
    const ui = extensions?.[UI_EXTENSION_ID] as { mimeTypes?: unknown } | undefined;
    return Array.isArray(ui?.mimeTypes) && ui.mimeTypes.includes(UI_MIME_TYPE);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.list({ ui: clientRendersViews() }),
  }));

  if (serveResources) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: registry
        .listResources()
        .map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const resource = registry.readResource(request.params.uri);
      return {
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            text: resource.body,
            ...(resource.contentMeta ? { _meta: resource.contentMeta } : {}),
          },
        ],
      };
    });
  }

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
