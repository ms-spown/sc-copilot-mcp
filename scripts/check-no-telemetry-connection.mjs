// Manual check, no network beyond loopback: does the built server touch 127.0.0.1:2942?
//   npm run build && npm run check:telemetry-silence
// It listens on the game's telemetry port itself and counts connections while the server runs.
//  1. Without SC_TELEMETRY: the server must make ZERO connections, whatever tools are called.
//  2. With SC_TELEMETRY=on (positive control): sc_live_status must make at least one, or the check proves nothing.
// If the port is already in use (the game is running with telemetry), the check stops and says so.
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 2942;

function listen() {
  return new Promise((resolve, reject) => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      socket.destroy();
    });
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => {
      resolve({ count: () => connections, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

async function run(label, extraEnv, calls) {
  const listener = await listen();
  // The server reads its own .env too; dotenv never overrides what is already set, so be explicit.
  const env = { ...process.env, SC_TELEMETRY: "", ...extraEnv };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "index.js")],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "silence-check", version: "1" });
  try {
    await client.connect(transport);
    await client.listTools();
    for (const name of calls) {
      await client.callTool({ name, arguments: {} }).catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    await client.close().catch(() => undefined);
  }
  const count = listener.count();
  await listener.close();
  console.log(`${label}: ${count} connection(s) to 127.0.0.1:${PORT}`);
  return count;
}

try {
  const off = await run(
    "without SC_TELEMETRY",
    {},
    ["sc_data_status", "sc_live_status", "sc_live_state", "sc_live_events", "sc_fleet_get"],
  );
  const on = await run("with SC_TELEMETRY=on (control)", { SC_TELEMETRY: "on" }, ["sc_live_status"]);
  if (off !== 0) {
    console.error("FAIL: the server connected to the telemetry port without being enabled.");
    process.exit(1);
  }
  if (on < 1) {
    console.error("INCONCLUSIVE: the positive control made no connection, so a zero proves nothing.");
    process.exit(2);
  }
  console.log("OK: silent when off, connects when on.");
} catch (error) {
  if (error?.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is in use (the game with telemetry running?). Quit it and run again.`);
    process.exit(3);
  }
  throw error;
}
