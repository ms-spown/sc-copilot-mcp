import { describe, expect, it, vi } from "vitest";
import { ConfigError, planMerge, type ServerEntry } from "./mergeConfig.js";

/**
 * Feature: when the text edit cannot be proven to mean what the merge means, nothing is written and
 * the line to add by hand is shown. The editor is made to misbehave on purpose.
 */

vi.mock("./jsonEdit.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./jsonEdit.js")>();
  return {
    ...real,
    // Looks plausible, parses, but drops the user's other server.
    editServerEntryText: vi.fn(() => '{"mcpServers":{"sc-copilot":{"command":"node"}}}'),
  };
});

const entry: ServerEntry = {
  command: "node",
  args: ["C:/x/dist/index.js"],
  env: { SCMCP_PROFILES: "core" },
};
const FAKE = "FAKE-TOKEN-VALUE-9876543210";
const raw = JSON.stringify({
  mcpServers: { other: { command: "npx", env: { API_KEY: FAKE } } },
});

describe("planMerge when the edited text is not what was expected", () => {
  it("refuses, says what to add by hand, and carries no value from the user's file", () => {
    let error: unknown;
    try {
      planMerge(raw, "sc-copilot", entry);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toMatch(/not touched/);
    expect(message).toContain('"sc-copilot"');
    expect(message).toContain("SCMCP_PROFILES");
    expect(message).not.toContain(FAKE);
    expect(message).not.toContain("other");
  });

  it("does not trip on a brand new file (nothing to edit, nothing to lose)", () => {
    expect(planMerge(null, "sc-copilot", entry).text).toContain('"sc-copilot"');
  });
});
