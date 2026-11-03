import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
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
