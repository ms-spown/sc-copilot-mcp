import { describe, expect, it } from "vitest";
import { describePlan, planMerge, type ServerEntry } from "./mergeConfig.js";

/**
 * Feature: re-running the installer keeps what the user already set in the server's entry.
 *
 * The entry's env holds choices (telemetry on, sessions off, the game folder, the session gap, the profiles) and
 * possibly a token typed by hand. A rewrite that kept only SC_TELEMETRY switched saved sessions back on for someone who
 * had turned them off. Every name below is invented; the values that look like secrets must never be printed.
 */

const NAME = "sc-copilot";
const TOKEN_VALUE = "FAKE-TOKEN-VALUE-0123456789";
const PATH_VALUE = "C:\\Games\\StarCitizen\\LIVE";

const previousEnv = {
  SCMCP_PROFILES: "core,trade",
  SC_TELEMETRY: "on",
  SC_SESSIONS: "off",
  SC_INSTALL_DIR: PATH_VALUE,
  SC_SESSION_GAP_HOURS: "6",
  SCMCP_SESSIONS_FILE: "D:\\my\\sessions.json",
  UEXTOKEN: TOKEN_VALUE,
};
const installed = JSON.stringify({
  mcpServers: {
    [NAME]: { command: "node", args: ["old/dist/index.js"], env: previousEnv },
    other: { command: "npx", env: { API_KEY: TOKEN_VALUE } },
  },
});
const fresh: ServerEntry = { command: "node", args: ["new/dist/index.js"], env: {} };
const DEFAULTS = { SCMCP_PROFILES: "core,trade,data,local" };

describe("Feature: planMerge keeps every env key of the existing entry", () => {
  it("Given an entry with several choices, When the installer rewrites it, Then all the keys and values are still there", () => {
    const plan = planMerge(installed, NAME, fresh, DEFAULTS);
    expect(plan.action).toBe("update"); // the command's path changed
    expect(plan.entry.env).toEqual(previousEnv);
    expect(plan.entry.args).toEqual(["new/dist/index.js"]); // what the installer owns is replaced
    expect(JSON.parse(plan.text as string).mcpServers[NAME].env).toEqual(previousEnv);
  });

  it("Given SC_SESSIONS=off, When the installer runs again, Then sessions stay off", () => {
    const plan = planMerge(installed, NAME, fresh, DEFAULTS);
    expect(plan.entry.env.SC_SESSIONS).toBe("off");
  });

  it("Given the user's own profiles, When no profile is asked for, Then theirs stay (the default is only for a new entry)", () => {
    expect(planMerge(installed, NAME, fresh, DEFAULTS).entry.env.SCMCP_PROFILES).toBe("core,trade");
    expect(planMerge(null, NAME, fresh, DEFAULTS).entry.env).toEqual(DEFAULTS);
  });

  it("Given a key the installer is asked to set, Then it overwrites the old value and the rest stays", () => {
    const asked: ServerEntry = {
      ...fresh,
      env: { SC_INSTALL_DIR: "E:\\Other", SCMCP_PROFILES: "core" },
    };
    const env = planMerge(installed, NAME, asked, DEFAULTS).entry.env;
    expect(env.SC_INSTALL_DIR).toBe("E:\\Other");
    expect(env.SCMCP_PROFILES).toBe("core");
    expect(env.SC_SESSIONS).toBe("off");
    expect(env.SC_TELEMETRY).toBe("on");
  });

  it("Given a second run with the same arguments, Then nothing changes", () => {
    const first = planMerge(installed, NAME, fresh, DEFAULTS);
    const again = planMerge(JSON.stringify(first.merged), NAME, fresh, DEFAULTS);
    expect(again.action).toBe("unchanged");
    expect(again.text).toBeNull();
  });

  it("Given a key the installer must not write, When the caller asks for it, Then it is still refused", () => {
    const bad: ServerEntry = { ...fresh, env: { UEXTOKEN: "x" } };
    expect(() => planMerge(installed, NAME, bad, DEFAULTS)).toThrow(/keep secrets in .env/);
  });

  it("Given other servers, Then they are untouched, byte for byte", () => {
    const text = planMerge(installed, NAME, fresh, DEFAULTS).text as string;
    expect(JSON.parse(text).mcpServers.other).toEqual({
      command: "npx",
      env: { API_KEY: TOKEN_VALUE },
    });
  });
});

describe("Feature: the preview names the kept keys and never shows their values", () => {
  const shown = describePlan(planMerge(installed, NAME, fresh, DEFAULTS), NAME);

  it("Then it lists the kept keys by name", () => {
    for (const key of Object.keys(previousEnv)) expect(shown).toContain(key);
    expect(shown).toMatch(/kept/i);
  });

  it("Then no value of a kept key appears (a token, a path, a flag)", () => {
    for (const value of [TOKEN_VALUE, PATH_VALUE, "D:\\\\my", "off", "core,trade"]) {
      // "off" is a word the text could contain by itself: look for it as a JSON value or a key=value pair.
      expect(shown).not.toContain(`"${value}"`);
    }
    expect(shown).not.toContain(TOKEN_VALUE);
    expect(shown).not.toContain("StarCitizen");
    expect(shown).not.toContain("sessions.json");
  });

  it("Then the other servers' content stays out of it too", () => {
    expect(shown).toContain("Other servers left untouched: 1");
    expect(shown).not.toContain("npx");
    expect(shown).not.toContain("API_KEY");
  });

  it("Given a brand new entry, Then the preview shows the installer's own values and no kept list", () => {
    const text = describePlan(
      planMerge(null, NAME, { ...fresh, env: { SC_INSTALL_DIR: "C:\\g" } }, DEFAULTS),
      NAME,
    );
    expect(text).toContain("SCMCP_PROFILES");
    expect(text).toContain("core,trade,data,local");
    expect(text).not.toMatch(/kept/i);
  });
});
