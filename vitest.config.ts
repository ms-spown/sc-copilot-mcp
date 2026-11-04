import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // A timeout here is a hang detector, not a performance assertion. The vitest default (5 s) is about 30 times what
    // the slowest real-I/O tests (session store, ledger reads) need on an idle machine, which a loaded laptop or a
    // CI runner running other jobs eats. Tests that assert on elapsed time say so in their own bounds.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Refuses any connection to a host that is not this machine: tests never use the network.
    setupFiles: ["./vitest.setup.ts"],
    // Anything a test writes to the default cache location lands in a throwaway folder.
    env: { SCMCP_CACHE_DIR: path.join(os.tmpdir(), "sc-copilot-mcp-vitest") },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
