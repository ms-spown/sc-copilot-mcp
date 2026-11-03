import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TELEMETRY_PORT } from "../core/telemetryNotice.js";
import { GAME_ENDPOINT } from "../providers/telemetry/reader.js";
import type { PortState } from "./portProbe.js";
import { parseArgs, runTelemetry } from "./telemetryCli.js";
import {
  MARKER_FILE,
  SESSION_SCRIPT,
  gatherTelemetryFacts,
  launcherCandidatesFromEnv,
  type SwitchDeps,
} from "./telemetrySwitch.js";
import { MemoryEnvStore } from "./testing/memoryEnvStore.js";

/**
 * Feature: switching the live telemetry on and off without touching anything by surprise.
 * Every test uses a temp folder, a fake path for the Claude config and an in-memory environment store: the real
 * Claude Desktop config and the real user variables are out of reach by construction.
 */

const SECRET_OTHER = "SUPER-SECRET-OTHER-SERVER";
const SECRET_OWN = "SUPER-SECRET-OWN-ENTRY";
const original = {
  globalShortcut: "Ctrl+Space",
  mcpServers: {
    other: { command: "npx", args: ["-y", "thing"], env: { API_KEY: SECRET_OTHER } },
    "sc-copilot": {
      command: "node",
      args: ["C:/x/dist/index.js"],
      env: { SCMCP_PROFILES: "core", SOME_TOKEN: SECRET_OWN },
    },
  },
};

let dir: string;
let configPath: string;
let markerDir: string;
let launcherExe: string;
let store: MemoryEnvStore;
let probed: number[];
let portState: PortState;
let clock: number;

const readConfig = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
const configBytes = () => fs.readFileSync(configPath);
const backups = () => fs.readdirSync(path.dirname(configPath)).filter((f) => f.includes(".bak-"));
const markerPath = () => path.join(markerDir, MARKER_FILE);

function deps(over: Partial<SwitchDeps> = {}): SwitchDeps {
  return {
    platform: "win32",
    store,
    probe: async (port) => {
      probed.push(port);
      return portState;
    },
    configPath,
    serverName: "sc-copilot",
    markerDir,
    now: () => new Date((clock += 1000)),
    launcherCandidates: [launcherExe],
    fileExists: (f) => fs.existsSync(f),
    ...over,
  };
}
const run = async (argv: string[], over: Partial<SwitchDeps> = {}) => {
  const args = parseArgs(argv);
  if ("error" in args) throw new Error(args.error);
  const r = await runTelemetry(args, deps(over));
  return { code: r.code, text: r.lines.join("\n") };
};
const writeConfig = (content: unknown) =>
  fs.writeFileSync(
    configPath,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
  );

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-telemetry-switch-"));
  configPath = path.join(dir, "claude", "claude_desktop_config.json");
  markerDir = path.join(dir, "appconfig");
  launcherExe = path.join(dir, "RSI Launcher", "RSI Launcher.exe");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(launcherExe), { recursive: true });
  fs.writeFileSync(launcherExe, "");
  writeConfig(original);
  store = new MemoryEnvStore();
  probed = [];
  portState = "closed";
  clock = Date.parse("2026-11-03T10:00:00Z");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const noSecret = (text: string) => {
  expect(text).not.toContain(SECRET_OTHER);
  expect(text).not.toContain(SECRET_OWN);
  expect(text).not.toContain("SCMCP_PROFILES");
};

describe("Feature: the telemetry status", () => {
  describe("Scenario: nothing is enabled", () => {
    it("Then it reports both switches off, tests the port, and writes nothing", async () => {
      const before = configBytes();
      const { code, text } = await run(["status"]);
      expect(code).toBe(0);
      expect(text).toMatch(/"sc-copilot" entry:\s+present/);
      expect(text).toMatch(/SC_TELEMETRY:\s+not set/);
      expect(text).toMatch(/GRPC_CLIENT_SERVER_ENABLED\s+not set/);
      expect(text).toMatch(/Port 127\.0\.0\.1:2942: closed/);
      expect(text).toMatch(/quit the launcher COMPLETELY/);
      expect(probed).toEqual([2942]);
      expect(store.writes).toEqual([]);
      expect(configBytes().equals(before)).toBe(true);
      expect(fs.existsSync(markerDir)).toBe(false);
      noSecret(text);
    });
  });

  describe("Scenario: a variable set by hand versus by the tool", () => {
    it("Given a hand-set variable, Then it says it is not ours", async () => {
      store.values.set("GRPC_CLIENT_SERVER_ENABLED", "true");
      expect((await run(["status"])).text).toMatch(/set by hand, or before this tool/);
    });
    it("Given a variable set by enable --apply, Then it says it was set by the tool", async () => {
      await run(["enable", "--apply"]);
      const { text } = await run(["status"]);
      expect(text).toMatch(/set by this tool/);
      expect(text).toMatch(/SC_TELEMETRY:\s+set \(on\)/);
    });
  });

  describe("Scenario: the config is missing or broken", () => {
    it("Given no config file, Then status still works and says so", async () => {
      fs.rmSync(configPath);
      const { code, text } = await run(["status"]);
      expect(code).toBe(0);
      expect(text).toMatch(/config file:\s+not found/);
    });
    it("Given invalid JSON, Then status says it cannot read it and shows no content", async () => {
      writeConfig(`{ nope ${SECRET_OWN}`);
      const { text } = await run(["status"]);
      expect(text).toMatch(/not valid JSON/);
      noSecret(text);
    });
  });
});

describe("Feature: enabling the telemetry", () => {
  describe("Scenario: a dry run (the default)", () => {
    it("Then it shows the plan and the warning, and changes nothing anywhere", async () => {
      const before = configBytes();
      const { code, text } = await run(["enable"]);
      expect(code).toBe(0);
      expect(text).toMatch(/Dry run: nothing was written/);
      expect(text).toContain('env.SC_TELEMETRY: (absent) -> "on"');
      expect(text).toMatch(/set the USER environment variable GRPC_CLIENT_SERVER_ENABLED=true/);
      expect(text).toMatch(/undocumented feature/);
      expect(text).toContain("docs/TELEMETRY.md");
      expect(configBytes().equals(before)).toBe(true);
      expect(backups()).toEqual([]);
      expect(store.writes).toEqual([]);
      expect(fs.existsSync(markerDir)).toBe(false);
      noSecret(text);
    });
  });

  describe("Scenario: --apply", () => {
    it("Then it sets the user variable, adds only SC_TELEMETRY, backs up the config and records what it did", async () => {
      const before = configBytes();
      const { code, text } = await run(["enable", "--apply"]);
      expect(code).toBe(0);

      expect(store.values.get("GRPC_CLIENT_SERVER_ENABLED")).toBe("true");
      expect(store.writes).toEqual(["set GRPC_CLIENT_SERVER_ENABLED"]);

      const expected = structuredClone(original) as typeof original & {
        mcpServers: { "sc-copilot": { env: Record<string, string> } };
      };
      expected.mcpServers["sc-copilot"].env.SC_TELEMETRY = "on";
      expect(readConfig()).toEqual(expected);

      const [bak] = backups();
      expect(backups()).toHaveLength(1);
      expect(fs.readFileSync(path.join(path.dirname(configPath), bak)).equals(before)).toBe(true);

      const marker = JSON.parse(fs.readFileSync(markerPath(), "utf8"));
      expect(marker.gameVar).toEqual({ origin: "tool" });
      expect(marker.config.path).toBe(configPath);
      expect(marker.config.backup).toBe(path.join(path.dirname(configPath), bak));

      expect(text).toMatch(/undocumented feature/);
      expect(text).toMatch(/quit the launcher COMPLETELY/);
      noSecret(text);
      noSecret(JSON.stringify(marker));
    });

    it("Given it is run twice, Then the second run changes nothing and takes no new backup", async () => {
      await run(["enable", "--apply"]);
      const bytes = configBytes();
      store.calls.length = 0;
      const second = await run(["enable", "--apply"]);
      expect(second.code).toBe(0);
      expect(backups()).toHaveLength(1);
      expect(configBytes().equals(bytes)).toBe(true);
      expect(store.writes).toEqual([]);
      // The variable is still recorded as ours, so disable will remove it.
      expect(JSON.parse(fs.readFileSync(markerPath(), "utf8")).gameVar).toEqual({ origin: "tool" });
    });
  });

  describe("Scenario: the sc-copilot entry does not exist", () => {
    it("Then it says so, invents no entry and writes nothing at all (not even the variable)", async () => {
      writeConfig({ mcpServers: { other: original.mcpServers.other } });
      const before = configBytes();
      const { code, text } = await run(["enable", "--apply"]);
      expect(code).toBe(1);
      expect(text).toMatch(/not in the Claude Desktop config/);
      expect(text).toMatch(/npm run install:claude/);
      expect(configBytes().equals(before)).toBe(true);
      expect(store.writes).toEqual([]);
      expect(backups()).toEqual([]);
    });
    it("Given no config file at all, Then it creates none", async () => {
      fs.rmSync(configPath);
      const { code, text } = await run(["enable", "--apply"]);
      expect(code).toBe(1);
      expect(text).toMatch(/does not exist/);
      expect(fs.existsSync(configPath)).toBe(false);
      expect(store.writes).toEqual([]);
    });
  });

  describe("Scenario: the config is not valid JSON", () => {
    it("Then the file and the environment are left alone", async () => {
      writeConfig("{ nope");
      const before = configBytes();
      const { code } = await run(["enable", "--apply"]);
      expect(code).toBe(1);
      expect(configBytes().equals(before)).toBe(true);
      expect(store.writes).toEqual([]);
    });
  });

  describe("Scenario: the variable already exists", () => {
    it("Given it was set by hand, Then enable keeps it as manual and does not set it again", async () => {
      store.values.set("GRPC_CLIENT_SERVER_ENABLED", "true");
      await run(["enable", "--apply"]);
      expect(store.writes).toEqual([]);
      expect(JSON.parse(fs.readFileSync(markerPath(), "utf8")).gameVar).toEqual({
        origin: "manual",
      });
    });
    it("Given it holds another value, Then it is not overwritten and the user is told", async () => {
      store.values.set("GRPC_CLIENT_SERVER_ENABLED", "false");
      const { text } = await run(["enable", "--apply"]);
      expect(store.values.get("GRPC_CLIENT_SERVER_ENABLED")).toBe("false");
      expect(text).toMatch(/another value/);
      expect(readConfig().mcpServers["sc-copilot"].env.SC_TELEMETRY).toBe("on");
    });
  });
});

describe("Feature: disabling the telemetry", () => {
  describe("Scenario: enable then disable", () => {
    it("Then the config is back to its original content, the variable is gone and the marker too", async () => {
      await run(["enable", "--apply"]);
      const { code, text } = await run(["disable", "--apply"]);
      expect(code).toBe(0);
      expect(readConfig()).toEqual(original);
      expect(store.values.has("GRPC_CLIENT_SERVER_ENABLED")).toBe(false);
      expect(fs.existsSync(markerPath())).toBe(false);
      expect(backups()).toHaveLength(2);
      noSecret(text);
    });

    it("Given it is run again, Then it is a no-op: no write, no backup", async () => {
      await run(["enable", "--apply"]);
      await run(["disable", "--apply"]);
      const bytes = configBytes();
      store.calls.length = 0;
      const again = await run(["disable", "--apply"]);
      expect(again.code).toBe(0);
      expect(again.text).toMatch(/Nothing to change/);
      expect(store.writes).toEqual([]);
      expect(backups()).toHaveLength(2);
      expect(configBytes().equals(bytes)).toBe(true);
    });

    it("Given a dry run, Then nothing is removed", async () => {
      await run(["enable", "--apply"]);
      const bytes = configBytes();
      const { text } = await run(["disable"]);
      expect(text).toMatch(/Dry run/);
      expect(configBytes().equals(bytes)).toBe(true);
      expect(store.values.get("GRPC_CLIENT_SERVER_ENABLED")).toBe("true");
      expect(fs.existsSync(markerPath())).toBe(true);
    });
  });

  describe("Scenario: the variable was set by hand", () => {
    it("Given it existed before enable, Then disable keeps it and says how to remove it", async () => {
      store.values.set("GRPC_CLIENT_SERVER_ENABLED", "true");
      await run(["enable", "--apply"]);
      const { text } = await run(["disable", "--apply"]);
      expect(store.values.get("GRPC_CLIENT_SERVER_ENABLED")).toBe("true");
      expect(store.writes).toEqual([]);
      expect(text).toMatch(/KEPT/);
      expect(text).toContain("SetEnvironmentVariable('GRPC_CLIENT_SERVER_ENABLED', $null, 'User')");
      expect(readConfig()).toEqual(original);
    });
    it("Given no marker at all, Then disable keeps it too", async () => {
      store.values.set("GRPC_CLIENT_SERVER_ENABLED", "true");
      const { text } = await run(["disable", "--apply"]);
      expect(store.values.get("GRPC_CLIENT_SERVER_ENABLED")).toBe("true");
      expect(text).toMatch(/KEPT/);
    });
    it("Given a damaged marker, Then nothing is assumed to be ours", async () => {
      store.values.set("GRPC_CLIENT_SERVER_ENABLED", "true");
      fs.mkdirSync(markerDir, { recursive: true });
      fs.writeFileSync(markerPath(), "{ not json");
      await run(["disable", "--apply"]);
      expect(store.values.get("GRPC_CLIENT_SERVER_ENABLED")).toBe("true");
    });
  });

  describe("Scenario: the variable changed value after we set it", () => {
    it("Then it is not removed", async () => {
      await run(["enable", "--apply"]);
      store.values.set("GRPC_CLIENT_SERVER_ENABLED", "something-else");
      const { text } = await run(["disable", "--apply"]);
      expect(store.values.get("GRPC_CLIENT_SERVER_ENABLED")).toBe("something-else");
      expect(text).toMatch(/KEPT/);
    });
  });

  describe("Scenario: a config without our entry", () => {
    it("Then disable succeeds and says there is nothing to remove", async () => {
      writeConfig({ mcpServers: {} });
      const { code, text } = await run(["disable", "--apply"]);
      expect(code).toBe(0);
      expect(text).toMatch(/nothing to remove/);
    });
  });
});

describe("Feature: session mode", () => {
  describe("Scenario: enable --session --apply", () => {
    it("Then the user environment is untouched, a launcher script is generated outside the repo, and SC_TELEMETRY is set", async () => {
      const { code, text } = await run(["enable", "--session", "--apply"]);
      expect(code).toBe(0);
      expect(store.writes).toEqual([]);
      const script = path.join(markerDir, SESSION_SCRIPT);
      const content = fs.readFileSync(script, "utf8");
      expect(content).toContain('set "GRPC_CLIENT_SERVER_ENABLED=true"');
      expect(content).toContain(`start "" "${launcherExe}"`);
      expect(readConfig().mcpServers["sc-copilot"].env.SC_TELEMETRY).toBe("on");
      expect(text).toMatch(/stays set in the config/);
      expect(text).toMatch(/already open/);
      const marker = JSON.parse(fs.readFileSync(markerPath(), "utf8"));
      expect(marker.gameVar).toBeNull();
      expect(marker.session).toEqual({ script, launcher: launcherExe });
    });

    it("Given a dry run, Then no script is written", async () => {
      const { text } = await run(["enable", "--session"]);
      expect(text).toMatch(/Dry run/);
      expect(fs.existsSync(path.join(markerDir, SESSION_SCRIPT))).toBe(false);
      expect(store.writes).toEqual([]);
    });

    it("Given the permanent variable is already set, Then it says the session launcher adds nothing", async () => {
      store.values.set("GRPC_CLIENT_SERVER_ENABLED", "true");
      const { text } = await run(["enable", "--session"]);
      expect(text).toMatch(/adds nothing/);
    });

    it("Given the launcher is not in a standard place, Then it asks for --launcher and writes nothing", async () => {
      const { code, text } = await run(["enable", "--session", "--apply"], {
        launcherCandidates: [path.join(dir, "nowhere", "RSI Launcher.exe")],
      });
      expect(code).toBe(1);
      expect(text).toMatch(/--launcher/);
      expect(fs.existsSync(markerDir)).toBe(false);
      expect(readConfig()).toEqual(original);
    });

    it("Given --launcher with a path, Then that one is used", async () => {
      const custom = path.join(dir, "elsewhere.exe");
      fs.writeFileSync(custom, "");
      await run(["enable", "--session", "--launcher", custom, "--apply"], {
        launcherCandidates: [],
      });
      expect(fs.readFileSync(path.join(markerDir, SESSION_SCRIPT), "utf8")).toContain(custom);
    });

    it("Given a --launcher path with a percent sign or a quote, Then it is refused", async () => {
      for (const bad of ["C:\\a%PATH%\\x.exe", 'C:\\a"b\\x.exe']) {
        const { code } = await run(["enable", "--session", "--launcher", bad, "--apply"]);
        expect(code).toBe(1);
      }
      expect(fs.existsSync(markerDir)).toBe(false);
    });
  });

  describe("Scenario: disable after a session enable", () => {
    it("Then the generated script and SC_TELEMETRY are removed", async () => {
      await run(["enable", "--session", "--apply"]);
      await run(["disable", "--apply"]);
      expect(fs.existsSync(path.join(markerDir, SESSION_SCRIPT))).toBe(false);
      expect(readConfig()).toEqual(original);
      expect(store.writes).toEqual([]);
    });
  });
});

describe("Feature: platforms without a Windows user environment", () => {
  it("Then enable and disable write nothing and print manual steps marked as untested", async () => {
    const before = configBytes();
    for (const command of ["enable", "disable"]) {
      const { code, text } = await run([command, "--apply"], { platform: "linux", store: null });
      expect(code).toBe(0);
      expect(text).toMatch(/NOT TESTED/);
      expect(text).toContain("Lutris");
      if (command === "enable") expect(text).toContain("GRPC_CLIENT_SERVER_ENABLED=true %command%");
    }
    expect(configBytes().equals(before)).toBe(true);
    expect(backups()).toEqual([]);
    expect(fs.existsSync(markerDir)).toBe(false);
  });
  it("Then status still works, reading only", async () => {
    const { code, text } = await run(["status"], { platform: "linux", store: null });
    expect(code).toBe(0);
    expect(text).toMatch(/unknown/);
  });
});

describe("Feature: the command line", () => {
  it.each([
    [[], /No command/],
    [["nope"], /Unknown command/],
    [["status", "--apply"], /never writes/],
    [["disable", "--session"], /no --session/],
    [["enable", "--launcher", "x"], /only makes sense with --session/],
    [["enable", "--bogus"], /Unknown option/],
    [["enable", "--config"], /needs a path/],
  ])("Given %j, Then it is refused", (argv, message) => {
    const r = parseArgs(argv as string[]);
    expect("error" in r && r.error).toMatch(message);
  });
  it("Then --config is carried to the caller", () => {
    expect(parseArgs(["status", "--config", "x.json"])).toMatchObject({ config: "x.json" });
  });
});

describe("Feature: the facts the doctor reads", () => {
  const cfg = (switchValue?: string) =>
    JSON.stringify({
      mcpServers: { "sc-copilot": { env: switchValue ? { SC_TELEMETRY: switchValue } : {} } },
    });
  const probeFn = async (p: number) => {
    probed.push(p);
    return "open" as const;
  };

  it("Given SC_TELEMETRY is not set in the config, Then the port is NOT tested (no connection without activation)", async () => {
    for (const raw of [cfg(), null, cfg("off"), "{ broken"]) {
      const facts = await gatherTelemetryFacts({
        configRaw: raw,
        serverName: "sc-copilot",
        store,
        probe: probeFn,
      });
      expect(facts.port).toBe("not_tested");
    }
    expect(probed).toEqual([]);
  });
  it("Given SC_TELEMETRY=on, Then the port is tested once and the user variable is read", async () => {
    store.values.set("GRPC_CLIENT_SERVER_ENABLED", "true");
    const facts = await gatherTelemetryFacts({
      configRaw: cfg("on"),
      serverName: "sc-copilot",
      store,
      probe: probeFn,
    });
    expect(facts).toEqual({ serverSwitch: "on", gameVar: "true", port: "open" });
    expect(probed).toEqual([2942]);
    expect(store.writes).toEqual([]);
  });
  it("Given a store that fails, Then the game variable is unknown, not an error", async () => {
    const broken = {
      get: async () => {
        throw new Error("boom");
      },
      set: async () => undefined,
      remove: async () => undefined,
    };
    const facts = await gatherTelemetryFacts({
      configRaw: cfg(),
      serverName: "sc-copilot",
      store: broken,
      probe: probeFn,
    });
    expect(facts.gameVar).toBe("unknown");
  });
});

describe("Feature: constants", () => {
  it("Then the port used by the command is the one the reader connects to", () => {
    expect(TELEMETRY_PORT).toBe(GAME_ENDPOINT.port);
  });
  it("Then the standard launcher places come from the Program Files variables", () => {
    expect(
      launcherCandidatesFromEnv({ ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\L" }),
    ).toEqual([
      "C:\\Program Files\\Roberts Space Industries\\RSI Launcher\\RSI Launcher.exe",
      "C:\\L\\Programs\\Roberts Space Industries\\RSI Launcher\\RSI Launcher.exe",
    ]);
  });
});
