/** What every tool returns to the MCP client. */
export interface ToolResult {
  // Index signature: the MCP SDK types a tool result as an open object.
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** A tool: its public definition (what `tools/list` shows) and the code that runs it. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: unknown) => Promise<ToolResult>;
}
