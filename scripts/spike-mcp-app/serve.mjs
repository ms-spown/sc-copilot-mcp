// Serves this folder on 127.0.0.1 only, for the fake host page. Stop it with Ctrl+C.
//   node scripts/spike-mcp-app/serve.mjs [port]     then open http://127.0.0.1:8099/fake-host.html
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 8099);
const types = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript" };

http
  .createServer((req, res) => {
    const name = path.basename(new URL(req.url ?? "/", "http://x").pathname) || "fake-host.html";
    const file = path.join(here, name);
    if (!/\.(html)$/.test(name) || !fs.existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(name)] ?? "text/plain" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, "127.0.0.1", () => console.error(`fake host on http://127.0.0.1:${port}/fake-host.html`));
