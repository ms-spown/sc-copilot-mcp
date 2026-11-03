import { describe, expect, it } from "vitest";
import { diagnose, nodeSupported, summarize, type DoctorFacts } from "./doctor.js";

/** Feature: telling a new user what is wrong with their installation, and how to fix it. */

const ENTRY = "C:\\tools\\sc-copilot-mcp\\dist\\index.js";
const healthy: DoctorFacts = {
  nodeVersion: "v22.14.0",
  distBuilt: true,
  envFile: { exists: true, hasToken: true },
  claudeConfig: JSON.stringify({
    mcpServers: {
      "sc-copilot": { command: "node", args: [ENTRY], env: { SCMCP_PROFILES: "core,trade" } },
    },
  }),
  serverName: "sc-copilot",
  expectedEntry: ENTRY,
  fleet: { exists: true, count: 5 },
  cacheWritable: true,
  gameLog: { configured: false, readable: false },
};
const status = (facts: Partial<DoctorFacts>, id: string) =>
  diagnose({ ...healthy, ...facts }).find((c) => c.id === id);

describe("Feature: the installation doctor", () => {
  describe("Scenario: everything is set up", () => {
    it("Then every check is ok and nothing needs fixing", () => {
      const checks = diagnose(healthy);
      expect(checks.every((c) => c.status === "ok")).toBe(true);
      expect(summarize(checks)).toEqual({ failed: 0, warned: 0 });
    });
  });

  describe("Scenario: Node is too old", () => {
    it.each([
      ["v18.20.0", false],
      ["v20.18.0", false],
      ["v20.19.0", true],
      ["v22.12.0", false],
      ["v22.13.1", true],
      ["v23.5.0", false],
      ["v24.8.0", true],
      ["v26.0.0", true],
      ["garbage", false],
    ])("Given %s, Then supported is %s", (version, expected) => {
      expect(nodeSupported(version)).toBe(expected);
    });

    it("Then it is a failure with the fix named", () => {
      expect(status({ nodeVersion: "v18.0.0" }, "node")).toMatchObject({
        status: "fail",
        fix: expect.stringContaining("Node 20.19"),
      });
    });
  });

  describe("Scenario: the project was not built", () => {
    it("Then it says exactly which command to run", () => {
      expect(status({ distBuilt: false }, "build")).toMatchObject({
        status: "fail",
        fix: expect.stringContaining("npm run build"),
      });
    });
  });

  describe("Scenario: the UEX token", () => {
    it("Given no .env, Then it is a warning that explains public endpoints still work", () => {
      expect(status({ envFile: { exists: false, hasToken: false } }, "uex-token")).toMatchObject({
        status: "warn",
      });
    });
    it("Given an empty UEXTOKEN, Then it says so", () => {
      expect(status({ envFile: { exists: true, hasToken: false } }, "uex-token")?.message).toMatch(
        /empty/,
      );
    });
    it("Given a token, Then it is reported as set, without any value or length", () => {
      const c = status({}, "uex-token");
      expect(c).toEqual({ id: "uex-token", status: "ok", message: "UEX token is set in .env" });
    });
  });

  describe("Scenario: the Claude Desktop config", () => {
    it("Given no file, Then it points at the installer", () => {
      expect(status({ claudeConfig: null }, "claude")?.fix).toMatch(/install:claude/);
    });
    it("Given our server missing from it, Then it says to run the installer and restart", () => {
      expect(
        status({ claudeConfig: JSON.stringify({ mcpServers: { other: {} } }) }, "claude"),
      ).toMatchObject({
        status: "warn",
        fix: expect.stringContaining("restart Claude Desktop"),
      });
    });
    it("Given an entry pointing at another checkout, Then it says so", () => {
      const other = JSON.stringify({
        mcpServers: { "sc-copilot": { args: ["D:\\old\\dist\\index.js"] } },
      });
      expect(status({ claudeConfig: other }, "claude")?.message).toMatch(/different checkout/);
    });
    it("Given the same path written with other slashes and case, Then it still counts as ours", () => {
      const cfg = JSON.stringify({
        mcpServers: { "sc-copilot": { args: ["c:/TOOLS/sc-copilot-mcp/dist/index.js"] } },
      });
      expect(status({ claudeConfig: cfg }, "claude")?.status).toBe("ok");
    });
    it("Given invalid JSON, Then it fails and tells the user to fix it by hand", () => {
      expect(status({ claudeConfig: "{ nope" }, "claude")).toMatchObject({ status: "fail" });
    });
    it("Given other servers with secrets, Then nothing of them appears in any message", () => {
      const cfg = JSON.stringify({
        mcpServers: {
          other: { env: { API_KEY: "TOP-SECRET-VALUE" } },
          "sc-copilot": { args: [ENTRY] },
        },
      });
      expect(JSON.stringify(diagnose({ ...healthy, claudeConfig: cfg }))).not.toContain(
        "TOP-SECRET-VALUE",
      );
    });
  });

  describe("Scenario: the game log", () => {
    it("Given it is off, Then that is fine and the way to enable it is named", () => {
      expect(status({}, "game-log")).toMatchObject({
        status: "ok",
        message: expect.stringContaining("SC_INSTALL_DIR"),
      });
    });
    it("Given it is configured but unreadable, Then it warns with the reason", () => {
      expect(
        status(
          { gameLog: { configured: true, readable: false, error: "No log at …/LIVE/Game.log" } },
          "game-log",
        ),
      ).toMatchObject({
        status: "warn",
        message: expect.stringContaining("No log at"),
      });
    });
    it("Given it is readable, Then it is ok and shows only the short path", () => {
      expect(
        status(
          { gameLog: { configured: true, readable: true, file: "…/StarCitizen/LIVE/Game.log" } },
          "game-log",
        )?.message,
      ).toContain("…/StarCitizen/LIVE/Game.log");
    });
  });

  describe("Scenario: live telemetry", () => {
    const tele = (t: NonNullable<DoctorFacts["telemetry"]>) =>
      diagnose({ ...healthy, telemetry: t }).filter((c) => c.id.startsWith("telemetry"));

    it("Given both switches off, Then it is ok, the port is untested and nothing is a problem", () => {
      const checks = tele({ serverSwitch: "absent", gameVar: "unset", port: "not_tested" });
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ status: "ok" });
      expect(checks[0].message).toMatch(/Port not tested/);
    });
    it("Given only the server side on, Then it warns and names the command", () => {
      const [c] = tele({ serverSwitch: "on", gameVar: "unset", port: "closed" });
      expect(c).toMatchObject({
        status: "warn",
        fix: expect.stringContaining("telemetry -- enable"),
      });
    });
    it("Given only the game variable set, Then it warns that the server will not read the stream", () => {
      const [c] = tele({ serverSwitch: "absent", gameVar: "true", port: "not_tested" });
      expect(c.status).toBe("warn");
      expect(c.message).toMatch(/server will not read/);
    });
    it("Given both on and the port closed, Then the launcher is to be restarted", () => {
      const checks = tele({ serverSwitch: "on", gameVar: "true", port: "closed" });
      const port = checks.find((c) => c.id === "telemetry-port");
      expect(port).toMatchObject({ status: "warn", fix: expect.stringContaining("tray icon") });
      expect(port?.message).toMatch(/launcher has to be restarted/);
      expect(checks.find((c) => c.id === "telemetry-stream")?.message).toMatch(/not verified/);
    });
    it("Given both on and the port open, Then it is ok and the stream is not verified", () => {
      const checks = tele({ serverSwitch: "on", gameVar: "true", port: "open" });
      expect(checks.every((c) => c.status === "ok")).toBe(true);
      expect(checks.find((c) => c.id === "telemetry-stream")?.message).toMatch(/not verified/);
    });
  });

  describe("Scenario: the fleet file is broken", () => {
    it("Then it warns and says the file is never overwritten while invalid", () => {
      expect(
        status({ fleet: { exists: true, count: 0, error: "not valid" } }, "fleet"),
      ).toMatchObject({
        status: "warn",
        fix: expect.stringContaining("never overwritten"),
      });
    });
  });
});
