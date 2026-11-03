// Regenerates the "Coverage" section of docs/TELEMETRY.md and docs/TELEMETRY.fr.md from the coverage table
// (src/providers/telemetry/coverage.ts). Run after changing the table or the schema.
//   npm run build && npm run docs:coverage
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { withCoverage } = await import(pathToFileURL(path.join(root, "dist", "docs", "coverageDoc.js")).href);

const targets = [
  ["docs/TELEMETRY.md", "en", "## What the tools do with it"],
  ["docs/TELEMETRY.fr.md", "fr", "## Ce que les outils en font"],
];
for (const [rel, lang, before] of targets) {
  const file = path.join(root, rel);
  const current = fs.readFileSync(file, "utf8");
  const crlf = current.includes("\r\n");
  const next = withCoverage(current, lang, before);
  fs.writeFileSync(file, crlf ? next.replace(/\n/g, "\r\n") : next);
  console.log(`updated ${rel}`);
}
