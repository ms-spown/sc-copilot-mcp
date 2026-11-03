// SPIKE (milestone 4), not part of the product: a minimal stdio MCP server with one MCP App View.
// It answers one question: does Claude Desktop render a View from a server in this install mode, and what does
// the View get (polling, display modes, ui/message, ui/update-model-context, hidden/teardown behaviour)?
//
//   node scripts/spike-mcp-app/server.mjs        (stdio; configure it as a SEPARATE entry, never as sc-copilot)
//
// Tools:  spike_hello  (model-visible, opens the View)
//         spike_poll   (visibility ["app"]: a counter, called by the View every second)
//         spike_report (visibility ["app"]: the View writes what it observed to the log file below)
// Log:    <tmp>/sc-spike-mcp-app.jsonl  (nothing personal; deleted by the next run)
// No network, no game, no secret. The View is a single hand-written page: no CDN, no package.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(os.tmpdir(), "sc-spike-mcp-app.jsonl");
const URI = "ui://spike/hello.html";
const MIME = "text/html;profile=mcp-app";
const html = fs.readFileSync(path.join(here, "view.html"), "utf8");

try {
  fs.writeFileSync(LOG, "");
} catch {
  // best effort
}
const log = (entry) => {
  try {
    fs.appendFileSync(LOG, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // best effort
  }
};

let counter = 0;
let polls = 0;
const server = new Server(
  { name: "sc-spike-mcp-app", version: "0.0.1" },
  { capabilities: { tools: {}, resources: {} } },
);

server.oninitialized = () => {
  const caps = server.getClientCapabilities() ?? {};
  log({
    event: "server_initialized",
    client: server.getClientVersion() ?? null,
    client_extensions: caps.extensions ?? null,
    client_capability_keys: Object.keys(caps),
  });
};

const ui = { resourceUri: URI };
const TOOLS = [
  {
    name: "spike_hello",
    description:
      "Spike: opens a tiny live view that counts once per second. Call it when the user asks to test the MCP App.",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui, "ui/resourceUri": URI },
  },
  {
    name: "spike_poll",
    description: "Spike, internal: called by the view every second. Not for the model.",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { ...ui, visibility: ["app"] } },
  },
  {
    name: "spike_report",
    description: "Spike, internal: the view reports what it observed. Not for the model.",
    inputSchema: { type: "object", properties: { note: { type: "object" } } },
    _meta: { ui: { ...ui, visibility: ["app"] } },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: URI, name: "Spike hello view", mimeType: MIME }],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri !== URI) throw new Error(`Unknown resource: ${request.params.uri}`);
  log({ event: "resource_read" });
  return {
    contents: [{ uri: URI, mimeType: MIME, text: html, _meta: { ui: { prefersBorder: false } } }],
  };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "spike_hello") {
    log({ event: "hello_called" });
    return {
      content: [{ type: "text", text: "The spike view was opened. It counts once per second." }],
      structuredContent: { counter, opened_at: new Date().toISOString() },
    };
  }
  if (name === "spike_poll") {
    counter += 1;
    polls += 1;
    if (polls <= 5 || polls % 30 === 0) log({ event: "poll", counter });
    return {
      content: [{ type: "text", text: `counter=${counter}` }],
      structuredContent: { counter, at: new Date().toISOString() },
    };
  }
  if (name === "spike_report") {
    log({ event: "view_report", ...(args?.note ?? {}) });
    return { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } };
  }
  throw new Error(`Unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
console.error("sc-spike-mcp-app running on stdio; log:", LOG);
