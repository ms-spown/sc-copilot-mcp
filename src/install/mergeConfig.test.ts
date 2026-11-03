import { describe, expect, it } from "vitest";
import { ConfigError, describePlan, planMerge, type ServerEntry } from "./mergeConfig.js";

const entry: ServerEntry = {
  command: "node",
  args: ["C:/x/dist/index.js"],
  env: { SCMCP_PROFILES: "core" },
};
// Invented content standing in for a user's other servers, including a secret that must never be shown.
const existing = JSON.stringify({
  globalShortcut: "Ctrl+Space",
  mcpServers: {
    other: { command: "npx", args: ["-y", "thing"], env: { API_KEY: "SUPER-SECRET-VALUE" } },
  },
});

describe("planMerge", () => {
  it("adds the server and keeps every other key and server exactly as they were", () => {
    const plan = planMerge(existing, "sc-copilot", entry);
    expect(plan.action).toBe("add");
    expect(plan.otherServers).toBe(1);
    expect(plan.merged).toEqual({
      globalShortcut: "Ctrl+Space",
      mcpServers: {
        other: { command: "npx", args: ["-y", "thing"], env: { API_KEY: "SUPER-SECRET-VALUE" } },
        "sc-copilot": entry,
      },
    });
  });

  it("creates the file content from nothing", () => {
    expect(planMerge(null, "sc-copilot", entry).merged).toEqual({
      mcpServers: { "sc-copilot": entry },
    });
    expect(planMerge("  ", "sc-copilot", entry).action).toBe("add");
  });

  it("recognises an update and an unchanged entry", () => {
    const first = planMerge(existing, "sc-copilot", entry).merged;
    expect(planMerge(JSON.stringify(first), "sc-copilot", entry).action).toBe("unchanged");
    const changed = { ...entry, env: { SCMCP_PROFILES: "core,trade" } };
    const plan = planMerge(JSON.stringify(first), "sc-copilot", changed);
    expect(plan.action).toBe("update");
    expect(plan.previous).toEqual(entry);
  });

  it("never shows another server's name or settings, secrets included", () => {
    const shown = describePlan(planMerge(existing, "sc-copilot", entry), "sc-copilot");
    expect(shown).toContain("Other servers left untouched: 1");
    expect(shown).not.toContain("SUPER-SECRET-VALUE");
    expect(shown).not.toContain("other");
    expect(shown).not.toContain("thing");
  });

  it("refuses to touch a file that is not valid JSON or has an odd shape", () => {
    expect(() => planMerge("{ nope", "x", entry)).toThrow(ConfigError);
    expect(() => planMerge("[]", "x", entry)).toThrow(ConfigError);
    expect(() => planMerge('{"mcpServers": []}', "x", entry)).toThrow(/not an object/);
  });

  it("refuses to write anything that looks like a secret into the config", () => {
    const bad = { ...entry, env: { UEXTOKEN: "abc" } };
    expect(() => planMerge(existing, "x", bad)).toThrow(/keep secrets in .env/);
  });
});
