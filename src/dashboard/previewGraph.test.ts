import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `scripts/dashboard-preview.mjs` loads the compiled test-support modules of `src/dashboard/testing` straight into a browser,
 * with the modules they import. The browser has no Node module and no bare package (the preview serves `dist/` only): one
 * `node:crypto` in that graph breaks the preview for whoever works on the View. This reads the graph from the sources, so the
 * break is found by the test suite and not by the next person who opens the preview.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(SRC, "..");

function entries(): string[] {
  const script = fs.readFileSync(path.join(ROOT, "scripts", "dashboard-preview.mjs"), "utf8");
  const found = [...script.matchAll(/"\/dist\/dashboard\/testing\/([A-Za-z0-9_]+)\.js"/g)].map(
    (m) => path.join(SRC, "dashboard", "testing", `${m[1]}.ts`),
  );
  return [...new Set(found)];
}

/** The specifiers a module really imports at run time (a `import type` is erased and does not count). */
function runtimeImports(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;"']*?)\s*from\s*"([^"]+)"/g,
  )) {
    if (m[2]) continue;
    out.push(m[4]!);
  }
  for (const m of text.matchAll(/(?:^|\n)\s*import\s*"([^"]+)"/g)) out.push(m[1]!);
  return out;
}

function graph(): { files: Map<string, string[]>; bad: string[] } {
  const files = new Map<string, string[]>();
  const bad: string[] = [];
  const todo = entries();
  while (todo.length) {
    const file = todo.pop()!;
    if (files.has(file)) continue;
    const specs = runtimeImports(file);
    files.set(file, specs);
    for (const spec of specs) {
      if (!spec.startsWith(".")) {
        bad.push(`${path.relative(SRC, file)} imports ${spec}`);
        continue;
      }
      const target = path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts"));
      if (fs.existsSync(target)) todo.push(target);
      else bad.push(`${path.relative(SRC, file)} imports ${spec}, which is not a source file`);
    }
  }
  return { files, bad };
}

describe("Feature: the browser preview can load what it imports", () => {
  it("Given the test-support modules the preview serves, Then they come from the script", () => {
    expect(entries().length).toBeGreaterThanOrEqual(8);
  });

  it("Given their whole import graph, Then it reaches the log parser and uses no Node module and no bare package", () => {
    const { files, bad } = graph();
    const names = [...files.keys()].map((f) => path.relative(SRC, f).replace(/\\/g, "/"));
    // the graph is the one the new code is in: the parser, the ship-loss reader and the commerce model
    expect(names).toContain("providers/gamelog/parser.ts");
    expect(names).toContain("providers/gamelog/shipLossParse.ts");
    expect(names).toContain("dashboard/tradeRun.ts");
    expect(bad).toEqual([]);
  });
});
