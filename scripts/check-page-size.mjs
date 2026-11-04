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
// History: 382.9 kB against a 410 kB budget, then 331.2 kB against 360 kB once the indentation was dropped, then 357.3 kB
// as the features landed (2.7 kB of margin: every new View feature was blocked). The script then lost its blanks
// (scriptMinify.ts), eight copies of the DOM helpers and some dead code: 319.3 kB. 345 kB is that size plus about 8 %
// (25 kB of room for the next features); passing it is a decision to take in a review, and slimming the page again comes first.
// 2026-11-04: 343.6 kB after the shortcuts zone and the balance choice (sticky mask, token, follow-the-server), against a margin of
// 1.4 kB: the budget is now that size plus about 8 % (371 kB). It stays an internal guard; the host's own limit is still unproven.
// 2026-11-04 (UX wave A): 350.7 kB with the trade line of a run under way (plan facts, idle runs, elapsed time, never an id), the
// session pill and notice wording and the health limits; the budget is that size plus about 5 % (368 kB), rounded. Still our own
// guard, not a host limit: no feature is dropped to fit it.
// 2026-11-04 (UX wave C on top of R5): 373.0 kB with the full-screen flight and commerce orders (layoutOrder.ts, the commerce fold,
// the shortcuts limited in flight) next to the route cards of R5; the budget is that size plus about 5 % (392 kB), rounded. Same
// status: our own guard, nothing was removed to fit it, the host's own limit is still unproven.
// 2026-11-04 (hold list of the route form): 391.6 kB with the "Soute" list (the flown ship, the runs, the fleet list, a default
// worked out and labelled, "Autre taille…") in the commerce action bar; the budget is that size plus about 5 % (411 kB), rounded.
// Same status: our own guard, nothing was removed to fit it, the host's own limit is still unproven.
// 2026-11-04 (account balance reminder F4 and the commerce card scoped to the session F3, on top of the hold list): 400.0 kB with
// the header "Solde" zone (live / last known with its age / unknown with the reason), the split of the journal's runs between the
// current play session and the older ones, the folded "Dernier trajet connu, hors session" block, and the session's trade section
// handed to the Debrief button, "Et ensuite ?" and the alert boxes; the budget is that size plus about 5 % (420 kB), rounded. Same
// status: our own guard, nothing was removed to fit it, the host's own limit is still unproven.
const BUDGET_BYTES = 420_000;

const page = await import(pathToFileURL(path.join(root, "dist", "dashboard", "page.js")).href);
const bytes = Buffer.byteLength(page.dashboardHtml(), "utf8");
const kb = (n) => (n / 1000).toFixed(1) + " kB";
if (bytes > BUDGET_BYTES) {
  console.error(`check:page-size FAILED: the dashboard page is ${kb(bytes)}, over its budget of ${kb(BUDGET_BYTES)}.`);
  process.exit(1);
}
console.log(`check:page-size ok: the dashboard page is ${kb(bytes)} (budget ${kb(BUDGET_BYTES)}).`);
