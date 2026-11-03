import { describe, expect, it } from "vitest";
import {
  ConfigError,
  describeEnvKeyPlan,
  planEnvKey,
  planMerge,
  type ServerEntry,
} from "./mergeConfig.js";

const raw = JSON.stringify({
  keep: 1,
  mcpServers: {
    other: { command: "npx", env: { API_KEY: "SUPER-SECRET-VALUE" } },
    "sc-copilot": { command: "node", args: ["a"], env: { SCMCP_PROFILES: "core" }, extra: true },
  },
});

describe("planEnvKey", () => {
  it("adds one key to the entry's env and keeps everything else", () => {
    const plan = planEnvKey(raw, "sc-copilot", "SC_TELEMETRY", "on");
    expect(plan.action).toBe("add");
    expect(plan.merged).toEqual({
      keep: 1,
      mcpServers: {
        other: { command: "npx", env: { API_KEY: "SUPER-SECRET-VALUE" } },
        "sc-copilot": {
          command: "node",
          args: ["a"],
          env: { SCMCP_PROFILES: "core", SC_TELEMETRY: "on" },
          extra: true,
        },
      },
    });
  });

  it("creates the env object of an entry that has none", () => {
    const r = JSON.stringify({ mcpServers: { s: { command: "node" } } });
    expect(planEnvKey(r, "s", "SC_TELEMETRY", "on").merged).toEqual({
      mcpServers: { s: { command: "node", env: { SC_TELEMETRY: "on" } } },
    });
  });

  it("is unchanged when the key already has the value, and when removing an absent key", () => {
    const on = JSON.stringify(planEnvKey(raw, "sc-copilot", "SC_TELEMETRY", "on").merged);
    expect(planEnvKey(on, "sc-copilot", "SC_TELEMETRY", "on")).toMatchObject({
      action: "unchanged",
      merged: null,
    });
    expect(planEnvKey(raw, "sc-copilot", "SC_TELEMETRY", null).action).toBe("unchanged");
  });

  it("removes the key and gives back the original content", () => {
    const on = JSON.stringify(planEnvKey(raw, "sc-copilot", "SC_TELEMETRY", "on").merged);
    const off = planEnvKey(on, "sc-copilot", "SC_TELEMETRY", null);
    expect(off.action).toBe("remove");
    expect(off.merged).toEqual(JSON.parse(raw));
  });

  it("never invents an entry", () => {
    expect(planEnvKey(raw, "nope", "SC_TELEMETRY", "on")).toMatchObject({
      action: "no_entry",
      merged: null,
    });
    expect(planEnvKey(null, "nope", "SC_TELEMETRY", "on").action).toBe("no_entry");
  });

  it("refuses odd shapes and secret-looking keys", () => {
    expect(() => planEnvKey("{ nope", "x", "SC_TELEMETRY", "on")).toThrow(ConfigError);
    expect(() => planEnvKey('{"mcpServers":{"x":[]}}', "x", "SC_TELEMETRY", "on")).toThrow(
      ConfigError,
    );
    expect(() => planEnvKey('{"mcpServers":{"x":{"env":[]}}}', "x", "SC_TELEMETRY", "on")).toThrow(
      /not an object/,
    );
    expect(() => planEnvKey(raw, "sc-copilot", "UEXTOKEN", "x")).toThrow(/keep secrets/);
  });

  it("describes only the key, its state and a count of the other servers", () => {
    const shown = describeEnvKeyPlan(
      planEnvKey(raw, "sc-copilot", "SC_TELEMETRY", "on"),
      "sc-copilot",
      "on",
    );
    expect(shown).toContain('env.SC_TELEMETRY: (absent) -> "on"');
    expect(shown).toContain("1 other server(s)");
    for (const leak of ["SUPER-SECRET-VALUE", "SCMCP_PROFILES", "npx", "API_KEY"])
      expect(shown).not.toContain(leak);
  });
});

describe("planMerge and SC_TELEMETRY", () => {
  const entry: ServerEntry = { command: "node", args: ["a"], env: { SCMCP_PROFILES: "core" } };
  const installed = JSON.stringify({
    mcpServers: { "sc-copilot": { ...entry, env: { SCMCP_PROFILES: "old", SC_TELEMETRY: "on" } } },
  });

  it("keeps the user's SC_TELEMETRY when the installer rewrites the entry", () => {
    const plan = planMerge(installed, "sc-copilot", entry);
    expect(plan.action).toBe("update");
    expect(plan.entry.env).toEqual({ SCMCP_PROFILES: "core", SC_TELEMETRY: "on" });
  });

  it("is still unchanged when nothing else differs", () => {
    const again = JSON.stringify(planMerge(installed, "sc-copilot", entry).merged);
    expect(planMerge(again, "sc-copilot", entry).action).toBe("unchanged");
  });

  it("adds nothing when there was no SC_TELEMETRY", () => {
    expect(planMerge(null, "sc-copilot", entry).entry.env).toEqual({ SCMCP_PROFILES: "core" });
  });
});
