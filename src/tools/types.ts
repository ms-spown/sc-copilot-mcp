/** What every tool returns to the MCP client. */
export interface ToolResult {
  // Index signature: the MCP SDK types a tool result as an open object.
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  /** Machine-readable result for MCP Apps Views. An object, never an array or a scalar. */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** What the registry knows about the connected client when it lists tools. */
export interface ClientContext {
  /** The client declared the MCP Apps extension with the HTML-app MIME type: it can render a View. */
  ui?: boolean;
}

/** One `tools/list` entry. */
export interface ListedTool {
  name: string;
  description: string;
  inputSchema: ToolDefinition["inputSchema"];
  /** MCP Apps: the View a tool opens and who may call it. Present only on tools that have one. */
  _meta?: Record<string, unknown>;
}

/** A resource the server serves (today only the dashboard View). Listed and readable only while `advertised`. */
export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  advertised: () => boolean;
  /** The `_meta` of the content in `resources/read`. */
  contentMeta?: Record<string, unknown>;
  text: () => string;
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
  /**
   * When present and false, the tool is left out of `tools/list` (it can still be called by name and then
   * explains itself). Used by optional features that are off by default.
   */
  advertised?: () => boolean;
  /**
   * The tool only makes sense in a client that renders MCP App Views (it declared the UI extension). Such a tool is
   * left out of `tools/list` for every other client, so a text-only model never sees it.
   */
  requiresUi?: boolean;
  /** The `_meta` of the tool in `tools/list` (MCP Apps: the View it opens, who may call it). */
  meta?: Record<string, unknown>;
  handler: (args: unknown) => Promise<ToolResult>;
}
