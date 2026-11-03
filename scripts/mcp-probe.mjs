// Drives the built MCP server over stdio and exercises each tool.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const server = spawn("node", ["dist/index.js"], {
  cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const pending = new Map();
server.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
server.stderr.on("data", (d) => {
  const s = d.toString().trim();
  if (s && !s.startsWith("[Cache")) process.stderr.write(`  [server] ${s}\n`);
});

let id = 0;
function rpc(method, params, timeoutMs = 120000) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method} ${params?.name ?? ""}`)), timeoutMs);
    pending.set(myId, (m) => { clearTimeout(timer); resolve(m); });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
}

const text = (r) => r?.result?.content?.[0]?.text ?? "";
const isErr = (r) => r?.result?.isError === true || !!r?.error;

async function call(label, name, args, check) {
  process.stdout.write(`\n▶ ${label}\n`);
  let r;
  try {
    r = await rpc("tools/call", { name, arguments: args });
  } catch (e) {
    console.log(`  ✗ ${e.message}`);
    return { ok: false, label, reason: e.message };
  }
  const body = text(r);
  if (isErr(r)) {
    console.log(`  ✗ error: ${(body || JSON.stringify(r.error)).slice(0, 300)}`);
    return { ok: false, label, reason: body.slice(0, 200) };
  }
  const problem = check ? check(body) : null;
  if (problem) {
    console.log(`  ✗ ${problem}\n    got: ${body.slice(0, 300)}`);
    return { ok: false, label, reason: problem };
  }
  console.log(`  ✓ ${body.slice(0, 220).replace(/\s+/g, " ")}`);
  return { ok: true, label };
}

const results = [];
try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "probe", version: "1.0" },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc("tools/list", {});
  const tools = list.result.tools.map((t) => t.name);
  console.log(`tools exposed: ${tools.length}`);
  console.log(tools.join(", "));

  results.push(await call("game versions (LIVE/PTU)", "uex_get_game_versions", {},
    (b) => (b.includes("live") ? null : "expected a live version")));

  results.push(await call("ship prices: Ursa Medivac", "uex_get_ship_prices",
    { vehicle_name: "Ursa Medivac" },
    (b) => (b.includes("Lorville") || b.includes("Levski") ? null : "expected Lorville/Levski")));

  results.push(await call("ship prices scoped to Pyro (expect none)", "uex_get_ship_prices",
    { vehicle_name: "Ursa Medivac", star_system_name: "Pyro" },
    (b) => (b.includes("Lorville") ? "Pyro filter did not apply" : null)));

  results.push(await call("list vehicles: role=Medical", "scw_list_vehicles",
    { role: "Medical", per_page: 5 },
    (b) => (b.includes("Pisces") || b.includes("Terrapin") ? null : "expected a medical ship")));

  results.push(await call("page size honoured (ask 3)", "scw_list_vehicles", { per_page: 3 },
    (b) => { try { const n = (JSON.parse(b).data ?? []).length; return n === 3 ? null : `got ${n} rows, expected 3`; }
             catch (e) { return "unparseable JSON: " + e.message.slice(0, 60); } }));

  results.push(await call("large list stays valid JSON", "scw_list_vehicles", { per_page: 50 },
    (b) => { try { JSON.parse(b); return b.length <= 40000 ? null : `over cap: ${b.length}`; }
             catch (e) { return "unparseable JSON: " + e.message.slice(0, 60); } }));

  results.push(await call("item list parses", "scw_list_items",
    { category: "vehicle-weapons", type: "Weapon Gun", per_page: 25 },
    (b) => { try { JSON.parse(b); return null; } catch (e) { return "unparseable: " + e.message.slice(0,60); } }));

  results.push(await call("list ship components: shields", "scw_list_items",
    { category: "vehicle-items", type: "Shield", per_page: 4 },
    (b) => (b.toLowerCase().includes("shield") ? null : "expected shields")));

  results.push(await call("filters discovery", "scw_get_filters", { dataset: "vehicles" },
    (b) => (b.includes("Medical") ? null : "expected role values")));

  results.push(await call("list builds", "sc_list_builds", { dataset: "ship-items", limit: 6 },
    (b) => (b.includes("4.10") && b.includes("4.9") ? null : "expected 4.9 and 4.10 builds")));

  results.push(await call("diff 4.9→4.10: Mantis", "sc_diff_versions",
    { dataset: "ship-items", from_version: "4.9", to_version: "4.10", item_name: "Mantis GT-220" },
    (b) => (b.includes("853.3") ? null : "expected buffed DPS 853.3")));

  results.push(await call("diff 4.9→4.10: AD5B (expect no change)", "sc_diff_versions",
    { dataset: "ship-items", from_version: "4.9", to_version: "4.10", item_name: "AD5B" },
    (b) => (b.includes('"changed": 0') && b.includes('"unchanged": 1') ? null : "expected changed:0 and unchanged:1")));

  {
    process.stdout.write("\n\u25b6 diff rejects identical versions\n");
    const r = await rpc("tools/call", { name: "sc_diff_versions",
      arguments: { dataset: "ship-items", from_version: "4.10", to_version: "4.10" } });
    const b = text(r);
    const ok = isErr(r) && b.includes("both resolve to build");
    console.log(ok ? `  \u2713 rejected as expected` : `  \u2717 expected rejection, got: ${b.slice(0,160)}`);
    results.push({ ok, label: "diff rejects identical versions", reason: "did not reject" });
  }

  results.push(await call("unknown ship name is handled", "uex_get_ship_prices",
    { vehicle_name: "Zzzz Not A Ship" },
    (b) => (b.toLowerCase().includes("no vehicle matched") ? null : "expected a clear not-found message")));
} catch (e) {
  console.log("\nFATAL:", e.message);
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`passed ${results.length - failed.length}/${results.length}`);
  for (const f of failed) console.log(`  FAILED: ${f.label} — ${f.reason}`);
  server.kill();
  process.exit(failed.length ? 1 : 0);
}
