// Anti-injection check of the tracked text files (see src/docs/docsSafety.ts for the rules).
//   npm run build && npm run check:docs
// Only files tracked by git are read, so local scratch files and ignored folders cannot fail it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = path.join(root, "dist", "docs", "docsSafety.js");
if (!fs.existsSync(modulePath)) {
  console.error("dist/ is missing: run `npm run build` first.");
  process.exit(2);
}
const { checkTrackedFiles, formatFindings } = await import(pathToFileURL(modulePath).href);

const listed = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const files = [];
for (const rel of listed) {
  try {
    files.push({ path: rel, bytes: fs.readFileSync(path.join(root, rel)) });
  } catch (err) {
    // Tracked but absent from the working tree (deleted, or a submodule folder): nothing to read.
    if (err.code !== "ENOENT" && err.code !== "EISDIR") throw err;
  }
}

const findings = checkTrackedFiles(files);
if (findings.length > 0) {
  console.error(formatFindings(findings));
  console.error(`\ncheck:docs failed: ${findings.length} finding(s) in ${files.length} tracked files.`);
  console.error("See CONTRIBUTING.md, section 'Security rules for contributions'.");
  process.exit(1);
}
console.log(`check:docs ok: ${files.length} tracked files, no finding.`);
