// Protocol-level smoke test of the spike server (no Claude Desktop needed): lists tools and resources, reads the
// View, calls the poll tool. Run:  node scripts/spike-mcp-app/smoke.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: "smoke", version: "1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "server.mjs")],
    stderr: "ignore",
  }),
);
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

const { tools } = await client.listTools();
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
console.log("tools:", tools.map((t) => `${t.name} ${JSON.stringify(t._meta)}`).join("\n       "));
if (byName.spike_hello?._meta?.ui?.resourceUri !== "ui://spike/hello.html") fail("hello has no resourceUri");
if (JSON.stringify(byName.spike_poll?._meta?.ui?.visibility) !== '["app"]') fail("poll is not app-only");

const { resources } = await client.listResources();
console.log("resources:", JSON.stringify(resources));
const read = await client.readResource({ uri: "ui://spike/hello.html" });
const item = read.contents[0];
console.log("view:", item.mimeType, `${item.text.length} bytes`, JSON.stringify(item._meta));
if (item.mimeType !== "text/html;profile=mcp-app") fail("wrong MIME type");
if (/https?:\/\/(?!www\.w3\.org)/i.test(item.text.replace(/<!--[\s\S]*?-->/g, ""))) fail("the view mentions a URL");

const a = await client.callTool({ name: "spike_poll", arguments: {} });
const b = await client.callTool({ name: "spike_poll", arguments: {} });
console.log("poll:", JSON.stringify(a.structuredContent), JSON.stringify(b.structuredContent));
if (b.structuredContent.counter !== a.structuredContent.counter + 1) fail("counter did not advance");
await client.close();
if (!process.exitCode) console.log("OK");
