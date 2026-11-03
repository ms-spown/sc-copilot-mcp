import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, runTelemetry } from "./telemetryCli.js";
import { MARKER_FILE, type SwitchDeps } from "./telemetrySwitch.js";
import { MemoryEnvStore } from "./testing/memoryEnvStore.js";

/**
 * Feature: the Claude config is edited as text, so a user's file comes back byte for byte except for the one key,
 * and a file that merely looks unusual (BOM, CRLF) is neither refused nor reformatted.
 */

let dir: string;
let configPath: string;
let markerDir: string;
let store: MemoryEnvStore;
let clock: number;

const deps = (over: Partial<SwitchDeps> = {}): SwitchDeps => ({
  platform: "win32",
  store,
  probe: async () => "closed",
  configPath,
  serverName: "sc-copilot",
  markerDir,
  now: () => new Date((clock += 1000)),
  launcherCandidates: [],
  fileExists: (f) => fs.existsSync(f),
  isFile: (f) => fs.existsSync(f) && fs.statSync(f).isFile(),
  ...over,
});
const run = async (argv: string[], over: Partial<SwitchDeps> = {}) => {
  const args = parseArgs(argv);
  if ("error" in args) throw new Error(args.error);
  const r = await runTelemetry(args, deps(over));
  return { code: r.code, text: r.lines.join("\n") };
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-telemetry-fidelity-"));
  configPath = path.join(dir, "claude_desktop_config.json");
  markerDir = path.join(dir, "app");
  store = new MemoryEnvStore();
  clock = Date.parse("2026-11-03T10:00:00Z");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const BOM = "﻿";
const awkward = (nl: string, indent: string, bom = "") =>
  `${bom}{${nl}${indent}"big": 12345678901234567890,${nl}${indent}"pi": 1.0,${nl}${indent}"name": "Rémi — ☃",${nl}${indent}"mcpServers": {${nl}${indent}${indent}"sc-copilot": {${nl}${indent}${indent}${indent}"command": "node",${nl}${indent}${indent}${indent}"env": {${nl}${indent}${indent}${indent}${indent}"2": "b",${nl}${indent}${indent}${indent}${indent}"1": "a",${nl}${indent}${indent}${indent}${indent}"SCMCP_PROFILES": "core"${nl}${indent}${indent}${indent}}${nl}${indent}${indent}}${nl}${indent}}${nl}}${nl}`;

describe("Feature: the config comes back byte for byte", () => {
  describe.each([
    ["CRLF and 2 spaces", awkward("\r\n", "  ")],
    ["LF and 4 spaces", awkward("\n", "    ")],
    ["LF and tabs", awkward("\n", "\t")],
    ["a UTF-8 BOM, CRLF and tabs", awkward("\r\n", "\t", BOM)],
    [
      "no final newline, compact",
      '{"big":12345678901234567890,"mcpServers":{"sc-copilot":{"env":{"A":"1"}}}}',
    ],
  ])("Scenario: %s", (_name, original) => {
    it("Then enable adds only the one line, and disable restores every original byte", async () => {
      fs.writeFileSync(configPath, original);
      const first = await run(["enable", "--apply"]);
      expect(first.code).toBe(0);

      const enabled = fs.readFileSync(configPath, "utf8");
      expect(enabled).toMatch(/"SC_TELEMETRY": ?"on"/);
      expect(enabled.startsWith(BOM)).toBe(original.startsWith(BOM));
      if (original.includes("12345678901234567890"))
        expect(enabled).toContain("12345678901234567890");
      if (original.includes("1.0")) expect(enabled).toContain('"pi": 1.0,');
      if (original.includes("\r\n")) expect(enabled.replace(/\r\n/g, "")).not.toContain("\n");
      // Everything but the inserted pair is the original.
      expect(enabled.replace(/,\s*"SC_TELEMETRY": ?"on"/, "")).toBe(original);

      await run(["disable", "--apply"]);
      expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    });
  });
});

describe("Feature: a file that is unusual but valid", () => {
  it("Given a BOM, Then status reads it instead of calling it invalid JSON", async () => {
    fs.writeFileSync(configPath, awkward("\n", "  ", BOM));
    const { text } = await run(["status"]);
    expect(text).not.toMatch(/not valid JSON/);
    expect(text).toMatch(/"sc-copilot" entry:\s+present/);
  });

  it("Given an entry without env, Then env is added in the entry's style and the rest is untouched", async () => {
    const original =
      '{\r\n  "mcpServers": {\r\n    "sc-copilot": {\r\n      "command": "node"\r\n    }\r\n  }\r\n}\r\n';
    fs.writeFileSync(configPath, original);
    await run(["enable", "--apply"]);
    const after = fs.readFileSync(configPath, "utf8");
    expect(JSON.parse(after).mcpServers["sc-copilot"]).toEqual({
      command: "node",
      env: { SC_TELEMETRY: "on" },
    });
    expect(after).toContain('"command": "node",\r\n      "env"');
    expect(after.startsWith('{\r\n  "mcpServers"')).toBe(true);
    expect(after.endsWith("}\r\n")).toBe(true);
  });
});

describe("Feature: disable when the config cannot be used", () => {
  it("Then the user variable this tool set is still removed, and the problem is said", async () => {
    fs.writeFileSync(configPath, awkward("\n", "  "));
    await run(["enable", "--apply"]);
    expect(store.values.get("GRPC_CLIENT_SERVER_ENABLED")).toBe("true");
    fs.writeFileSync(configPath, "{ broken");
    const { code, text } = await run(["disable", "--apply"]);
    expect(store.values.has("GRPC_CLIENT_SERVER_ENABLED")).toBe(false);
    expect(code).toBe(1);
    expect(text).toMatch(/Config NOT changed/);
    expect(text).toMatch(/NOT removed from the config/);
    expect(fs.readFileSync(configPath, "utf8")).toBe("{ broken");
  });
});

describe("Feature: SC_TELEMETRY added by hand", () => {
  it("Then disable removes it and says why", async () => {
    fs.writeFileSync(
      configPath,
      '{\n  "mcpServers": {\n    "sc-copilot": {\n      "env": {\n        "SC_TELEMETRY": "on"\n      }\n    }\n  }\n}\n',
    );
    const { text } = await run(["disable", "--apply"]);
    expect(text).toMatch(/exists only for this feature/);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers["sc-copilot"].env).toEqual(
      {},
    );
  });
});

describe("Feature: the user variable could not be set", () => {
  it("Given the call fails and the variable is not there, Then no marker claims it", async () => {
    fs.writeFileSync(configPath, awkward("\n", "  "));
    const failing = new MemoryEnvStore();
    failing.set = async () => {
      throw new Error("PowerShell failed: nope");
    };
    await expect(run(["enable", "--apply"], { store: failing })).rejects.toThrow(/nope/);
    expect(fs.existsSync(path.join(markerDir, MARKER_FILE))).toBe(false);
  });

  it("Given the call succeeds but the variable is not visible afterwards, Then it is an error and no marker remains", async () => {
    fs.writeFileSync(configPath, awkward("\n", "  "));
    const lying = new MemoryEnvStore();
    lying.set = async () => undefined;
    await expect(run(["enable", "--apply"], { store: lying })).rejects.toThrow(/not set after/);
    expect(fs.existsSync(path.join(markerDir, MARKER_FILE))).toBe(false);
  });
});
