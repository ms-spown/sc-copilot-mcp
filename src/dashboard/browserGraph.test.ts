import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Feature: nothing Node-only reaches the browser. The View is built from functions serialised with `toString`, so a module
 * that imports anything loses that import in the page; and the preview loads the made-up flight (testing/scenario.ts) in a
 * real browser, so its graph must stay free of `node:` modules too. A `node:` import in either would work under vitest and
 * fail in the page.
 */

const DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => fs.readFileSync(file, "utf8");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

interface Import {
  spec: string;
  typeOnly: boolean;
}

/** Every `import ... from "x"`, `export ... from "x"`, bare `import "x"` and dynamic `import("x")` of a source text. */
function importsOf(src: string): Import[] {
  const text = stripComments(src);
  const out: Import[] = [];
  for (const m of text.matchAll(
    /^\s*(?:import|export)\s+(type\s+)?[^;"']*?\s+from\s+"([^"]+)"/gm,
  )) {
    out.push({ spec: m[2]!, typeOnly: !!m[1] });
  }
  for (const m of text.matchAll(/^\s*import\s+"([^"]+)"/gm))
    out.push({ spec: m[1]!, typeOnly: false });
  for (const m of text.matchAll(/\bimport\(\s*["']([^"']+)["']/g))
    out.push({ spec: m[1]!, typeOnly: false });
  for (const m of text.matchAll(/\brequire\(\s*["']([^"']+)["']/g))
    out.push({ spec: m[1]!, typeOnly: false });
  return out;
}

/** The runtime files reachable from `entry` (type-only imports are erased and cost nothing), and the imports that leave the repo. */
function graph(entry: string): { files: string[]; outside: string[] } {
  const files = new Set<string>();
  const outside: string[] = [];
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const imp of importsOf(read(file))) {
      if (imp.typeOnly) continue;
      if (!imp.spec.startsWith(".")) outside.push(`${path.basename(file)} -> ${imp.spec}`);
      else visit(path.resolve(path.dirname(file), imp.spec.replace(/\.js$/, ".ts")));
    }
  };
  visit(entry);
  return { files: [...files], outside };
}

/** The modules page.ts serialises: every relative import of page.ts except the server-side minifier. */
function browserModules(): string[] {
  const page = read(path.join(DIR, "page.ts"));
  return importsOf(page)
    .filter((i) => i.spec.startsWith(".") && !i.spec.includes("scriptMinify"))
    .map((i) => path.resolve(DIR, i.spec.replace(/\.js$/, ".ts")))
    .filter((f) => !f.endsWith("Styles.ts"));
}

describe("Feature: the code the browser runs has no Node-only import", () => {
  it("Given the modules page.ts serialises, Then they are many and the shortcuts are among them", () => {
    const names = browserModules().map((f) => path.basename(f));
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(names).toContain("viewLogic.ts");
    expect(names).toContain("viewApp.ts");
    expect(names).toContain("shortcutsPanel.ts");
  });

  it("Given each of them, Then it has no import at all (a type import is erased), so nothing from node: can be in the page", () => {
    for (const file of browserModules()) {
      const runtime = importsOf(read(file)).filter((i) => !i.typeOnly);
      expect(runtime, path.basename(file)).toEqual([]);
      expect(stripComments(read(file)), path.basename(file)).not.toMatch(/["']node:/);
    }
  });

  it("Given the style modules, Then they import nothing either", () => {
    const page = read(path.join(DIR, "page.ts"));
    const styles = importsOf(page)
      .filter((i) => /Styles\.js$/.test(i.spec))
      .map((i) => path.resolve(DIR, i.spec.replace(/\.js$/, ".ts")));
    expect(styles.length).toBeGreaterThanOrEqual(10);
    for (const file of styles) expect(importsOf(read(file)), path.basename(file)).toEqual([]);
  });

  it("Given the made-up flight the preview loads in a browser, Then its whole graph is free of node: and of any package", () => {
    const g = graph(path.join(DIR, "testing", "scenario.ts"));
    expect(g.files.length).toBeGreaterThan(3);
    expect(g.outside).toEqual([]);
  });

  it("Given the way imports are read, Then the forms that matter are all caught", () => {
    const sample = [
      'import fs from "node:fs";',
      'import { a } from "./a.js";',
      'import type { T } from "./t.js";',
      'export { b } from "./b.js";',
      'import "node:os";',
      'const x = await import("node:path");',
      '// import y from "node:vm";',
    ].join("\n");
    expect(importsOf(sample)).toEqual([
      { spec: "node:fs", typeOnly: false },
      { spec: "./a.js", typeOnly: false },
      { spec: "./t.js", typeOnly: true },
      { spec: "./b.js", typeOnly: false },
      { spec: "node:os", typeOnly: false },
      { spec: "node:path", typeOnly: false },
    ]);
  });
});
