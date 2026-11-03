import { toErrorResult } from "../core/errors.js";
import type { HttpClient } from "../core/http.js";
import { dumpTools } from "./dumps.js";
import { localTools } from "./local.js";
import { sctTools } from "./sctools.js";
import type { ToolDefinition, ToolResult } from "./types.js";
import { uexTools } from "./uex.js";
import { vocabularyTools } from "./vocabulary.js";
import { wikiTools } from "./wiki.js";

export interface ToolClients {
  uexClient: HttpClient;
  scwClient: HttpClient;
  sctClient: HttpClient;
}

/** Every tool this server implements, before any SCMCP_TOOLS filtering. */
export function allTools(clients: ToolClients): ToolDefinition[] {
  return [
    ...uexTools(clients),
    ...wikiTools(clients),
    ...sctTools(clients),
    ...localTools(),
    ...vocabularyTools(clients),
    ...dumpTools(),
  ];
}

export interface ToolRegistry {
  /** What `tools/list` advertises: name, description and schema, never the handler. */
  list(): { name: string; description: string; inputSchema: ToolDefinition["inputSchema"] }[];
  call(name: string, args: unknown): Promise<ToolResult>;
}

/**
 * @param enabled when set, only these tools are advertised. Calls are not filtered:
 *   SCMCP_TOOLS scopes the listing for latency, it is not an access control.
 */
export function createRegistry(tools: ToolDefinition[], enabled: Set<string> | null): ToolRegistry {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    byName.set(tool.name, tool);
  }

  return {
    list() {
      return tools
        .filter((t) => !enabled || enabled.has(t.name))
        .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    },
    async call(name, args) {
      try {
        const tool = byName.get(name);
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        return await tool.handler(args);
      } catch (error: unknown) {
        return toErrorResult(error);
      }
    },
  };
}
