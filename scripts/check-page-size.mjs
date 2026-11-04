// Fails when the live dashboard View, as it SHIPS (built into dist/), is larger than its budget.
//   npm run build && npm run check:page-size
//
// The vitest size test measures the page as vitest transforms it (comments and all), which is not what the host
// receives; this one imports `dashboardHtml()` from the built dist, the exact text of the `ui://` resource. It reads
// nothing else, writes nothing, opens no socket.
//
// The budget has headroom over today's size on purpose: passing it is a decision to take in a review, not a surprise.
// What the HOST accepts for the HTML resource of an MCP App (its maximum size) is NOT verified: we know of no documented
// limit and measured none in Claude Desktop. The budget is ours, not the host's.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUDGET_BYTES = 410_000; // the built page was 382.9 kB when set (with removeComments), 331.2 kB since page.ts drops the indentation (health strip included)

const page = await import(pathToFileURL(path.join(root, "dist", "dashboard", "page.js")).href);
const bytes = Buffer.byteLength(page.dashboardHtml(), "utf8");
const kb = (n) => (n / 1000).toFixed(1) + " kB";
if (bytes > BUDGET_BYTES) {
  console.error(`check:page-size FAILED: the dashboard page is ${kb(bytes)}, over its budget of ${kb(BUDGET_BYTES)}.`);
  process.exit(1);
}
console.log(`check:page-size ok: the dashboard page is ${kb(bytes)} (budget ${kb(BUDGET_BYTES)}).`);
