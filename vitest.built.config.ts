import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// `npm run test:built` (after `npm run build`): the dashboard tests, run against the page AS IT SHIPS.
//
// The usual run imports `src/dashboard/page.ts`, so the page is assembled from vitest's own transform of the sources.
// The host receives the page assembled from the compiled `dist/dashboard/page.js` (tsc output, functions without their
// blanks by `minifyScript`). This config points every import of `page.js` made from the dashboard sources at that
// compiled file, so the same tests (the fake host, the fake DOM, the page harness) exercise the shipped script.
const built = path.resolve("dist", "dashboard", "page.js");

export default defineConfig({
  plugins: [
    {
      name: "built-page",
      enforce: "pre",
      resolveId(source: string, importer?: string) {
        if (importer && /src[\\/]dashboard/.test(importer) && /(^|[\\/])page\.js$/.test(source))
          return built;
        return null;
      },
    },
  ],
  test: {
    globals: true,
    environment: "node",
    include: ["src/dashboard/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // Same hang detectors as vitest.config.ts (a timeout is not a performance assertion).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { SCMCP_CACHE_DIR: path.join(os.tmpdir(), "sc-copilot-mcp-vitest") },
  },
});
