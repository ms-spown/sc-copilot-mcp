import { describe, expect, it, vi } from "vitest";
import { GameLog } from "../providers/gamelog/reader.js";
import type { SessionManager } from "../providers/sessions/manager.js";
import type { Telemetry } from "../providers/telemetry/index.js";
import type { GameLogHint, TelemetryStateName } from "../providers/telemetry/service.js";
import { buildHealth, healthLogLabel, logConfigFacts, type HealthStatic } from "./health.js";
import { hashSections, tailorPoll } from "./poll.js";
import { DashboardService } from "./service.js";
import { healthFacts, healthSection, type HealthVariant } from "./testing/healthScenario.js";

/**
 * Feature: the health section of the poll. Pure first (every combination that matters), then through the service with
 * made-up facts. It carries codes and one fixed label; never a path, a value of a setting or an amount.
 */

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

describe("Feature: the log label never holds a path", () => {
  it.each([
    ["C:\\Program Files\\Roberts Space Industries\\StarCitizen\\LIVE\\Game.log", "LIVE/Game.log"],
    ["D:/Games/StarCitizen/ptu/Game.log", "PTU/Game.log"],
    ["C:\\Users\\jdoe-secret\\Desktop\\Game.log", "Game.log"],
    ["C:\\Users\\jdoe-secret\\Game.log", "Game.log"],
    ["C:\\Users\\jdoe-secret\\Desktop\\jdoe-secret.log", "custom"],
    ["/home/jdoe-secret/LIVE/other.log", "custom"],
    ["", "custom"],
  ])("Given %s, Then the label is %s", (file, label) => {
    expect(healthLogLabel(file)).toBe(label);
    expect(healthLogLabel(file)).not.toContain("jdoe-secret");
  });

  it("Given a log configured by file or by folder, Then only the NAME of the setting comes out", () => {
    const byFile = new GameLog({ logPath: "C:\\Users\\jdoe-secret\\Desktop\\Game.log" });
    const byDir = new GameLog({ installDir: "C:\\Users\\jdoe-secret\\StarCitizen\\LIVE" });
    expect(logConfigFacts(byFile)).toEqual({
      configured: true,
      via: "log_path",
      label: "Game.log",
    });
    expect(logConfigFacts(byDir)).toEqual({
      configured: true,
      via: "install_dir",
      label: "LIVE/Game.log",
    });
    expect(logConfigFacts(new GameLog({}))).toEqual({ configured: false, via: null, label: null });
    expect(logConfigFacts(undefined)).toEqual({ configured: false, via: null, label: null });
    // A name that is not a .log is refused by the reader: the label degrades to "custom", it does not throw.
    expect(logConfigFacts(new GameLog({ logPath: "C:\\Users\\jdoe-secret\\x.txt" })).label).toBe(
      "custom",
    );
  });
});

describe("Feature: the section says what is wired, for every combination that matters", () => {
  const section = (variant: HealthVariant) => healthSection(variant, NOW);

  it("Given everything wired, Then the log is read, the game registered and the sessions saved", () => {
    expect(section("ok")).toEqual({
      v: 1,
      log: "ok",
      via: "install_dir",
      label: "LIVE/Game.log",
      registration: "seen",
      sessions: "on",
      saved_at: new Date(NOW - 4 * 60_000).toISOString(),
    });
  });

  it("Given telemetry off, Then nothing is claimed about the log or the game and the sessions need telemetry", () => {
    expect(section("off")).toMatchObject({
      log: "unchecked",
      registration: "unknown",
      sessions: "needs_telemetry",
    });
    expect(section("off")).not.toHaveProperty("saved_at");
  });

  it("Given no log configured, Then log is off and carries no label", () => {
    const s = section("nolog");
    expect(s.log).toBe("off");
    expect(s).not.toHaveProperty("label");
    expect(s).not.toHaveProperty("via");
  });

  it("Given a log configured that cannot be followed, Then it is unreadable (and still named)", () => {
    expect(section("unreadable")).toMatchObject({ log: "unreadable", label: "LIVE/Game.log" });
  });

  it("Given the custom file, Then the label is custom and the setting is the file one", () => {
    expect(section("custom")).toMatchObject({ via: "log_path", label: "custom" });
  });

  it.each<[TelemetryStateName, GameLogHint | null, string]>([
    ["live", null, "seen"],
    ["connected", null, "seen"],
    ["game_without_telemetry", { running: true, telemetryRegistered: false }, "not_seen"],
    ["waiting", { running: true, telemetryRegistered: true }, "seen"],
    ["waiting", { running: true, telemetryRegistered: false }, "unknown"],
    ["waiting", { running: false, telemetryRegistered: true }, "unknown"],
    ["waiting", null, "unknown"],
    ["incompatible", null, "unknown"],
  ])("Given the state %s and the hint %j, Then the registration is %s", (state, hint, expected) => {
    const facts = { ...healthFacts("ok", NOW), state, hint };
    expect(buildHealth(facts).registration).toBe(expected);
  });

  it.each<[HealthVariant, string]>([
    ["ok", "on"],
    ["sessionsoff", "off"],
    ["degraded", "degraded"],
    ["readonly", "readonly"],
    ["off", "needs_telemetry"],
  ])("Given the situation %s, Then the sessions are %s", (variant, expected) => {
    expect(section(variant).sessions).toBe(expected);
  });

  it("Given a manager that is not there or did not answer, Then the sessions are unavailable, never said to be switched off", () => {
    for (const sessionStatus of ["off", null] as const) {
      expect(buildHealth({ ...healthFacts("ok", NOW), sessionStatus }).sessions).toBe(
        "unavailable",
      );
    }
  });

  it("Given SC_SESSIONS off, Then the sessions are off whatever the manager says", () => {
    for (const sessionStatus of ["off", null, "ok"] as const) {
      expect(
        buildHealth({ ...healthFacts("ok", NOW), sessionsOff: true, sessionStatus }).sessions,
      ).toBe("off");
    }
  });

  it("Given a section, Then it is tiny and holds no amount, no path and no free text", () => {
    for (const variant of [
      "ok",
      "nolog",
      "unreadable",
      "unregistered",
      "sessionsoff",
      "degraded",
      "readonly",
      "off",
      "custom",
      "everything",
    ] as const) {
      const text = JSON.stringify(section(variant));
      expect(text.length).toBeLessThan(260);
      expect(text).not.toMatch(/[\\]|C:|Users|aUEC|balance|uec/i);
    }
  });
});

// ------------------------------------------------------------------------------------------------ through the service

const status = (state: TelemetryStateName) =>
  ({
    state,
    cause: "made-up",
    frames_received: 0,
    frames_rejected: 0,
    reconnects: 0,
    unknown_fields: [],
    anomalies: [],
    not_in_stream: [],
    idle_stop_ms: 0,
  }) as never;

function telemetry(state: TelemetryStateName, hint: GameLogHint | null = null): Telemetry {
  return {
    enabled: true,
    status: vi.fn(async () => status(state)),
    snapshot: vi.fn(async () => null),
    events: vi.fn(async () => ({ events: [], last_seq: 0 })),
    resetUecDelta: vi.fn(async () => undefined),
    balanceHistory: vi.fn(async () => []),
    gameHint: vi.fn(async () => hint),
    stop: vi.fn(async () => undefined),
  };
}

const STATIC: HealthStatic = {
  log: { configured: true, via: "install_dir", label: "LIVE/Game.log" },
  sessionsOff: false,
};

const followed = {
  current: async () => ({ state: "online" as const, since: null, code: null, reason: null }),
};
const notFollowed = { current: async () => null };

function sessionsStub(status: string, savedAtMs: number | null = null): SessionManager {
  return {
    enabled: true,
    lastSavedAtMs: savedAtMs,
    bar: async () => ({
      v: 1,
      status,
      notice: null,
      gap_hours: 3,
      current: null,
      stale: false,
    }),
  } as unknown as SessionManager;
}

function service(
  tele: Telemetry,
  opts: {
    connection?: { current(): Promise<never | null> };
    sessions?: SessionManager;
    health?: HealthStatic | undefined;
  } = {},
) {
  return new DashboardService(
    tele,
    () => NOW,
    undefined,
    opts.connection as never,
    undefined,
    undefined,
    opts.sessions,
    "health" in opts ? opts.health : STATIC,
  );
}

describe("Feature: the service builds the section from facts it already holds", () => {
  it("Given telemetry off, Then the health says so and the telemetry service is never consulted", async () => {
    const off = { enabled: false, status: vi.fn(), gameHint: vi.fn() } as unknown as Telemetry;
    const poll = await service(off).poll({ includeBalance: false });
    expect(poll.health).toMatchObject({ log: "unchecked", sessions: "needs_telemetry" });
    expect(off.status).not.toHaveBeenCalled();
    expect(off.gameHint).not.toHaveBeenCalled();
  });

  it("Given no facts were passed (an older wiring), Then the answer has no health at all", async () => {
    const poll = await service(telemetry("live"), { health: undefined }).poll({
      includeBalance: false,
    });
    expect(poll).not.toHaveProperty("health");
  });

  it("Given the log is followed, Then it is ok; given it is not, Then unreadable", async () => {
    const ok = await service(telemetry("live"), { connection: followed as never }).poll({
      includeBalance: false,
    });
    const bad = await service(telemetry("waiting"), { connection: notFollowed as never }).poll({
      includeBalance: false,
    });
    expect(ok.health?.log).toBe("ok");
    expect(bad.health?.log).toBe("unreadable");
  });

  it("Given no log configured, Then log is off whatever else", async () => {
    const poll = await service(telemetry("live"), {
      health: { log: { configured: false, via: null, label: null }, sessionsOff: false },
    }).poll({ includeBalance: false });
    expect(poll.health).toMatchObject({ log: "off" });
    expect(poll.health).not.toHaveProperty("label");
  });

  it("Given the game started without the variable, Then the registration is not seen, from the hint the service already holds", async () => {
    const tele = telemetry("game_without_telemetry", { running: true, telemetryRegistered: false });
    const poll = await service(tele, { connection: followed as never }).poll({
      includeBalance: false,
    });
    expect(poll.health?.registration).toBe("not_seen");
    expect(tele.gameHint).toHaveBeenCalledTimes(1);
  });

  it("Given a session manager, Then its status and its last save time reach the section", async () => {
    const poll = await service(telemetry("live"), {
      connection: followed as never,
      sessions: sessionsStub("degraded", NOW - 90_000),
    }).poll({ includeBalance: false });
    expect(poll.health).toMatchObject({
      sessions: "degraded",
      saved_at: new Date(NOW - 90_000).toISOString(),
    });
  });

  it("Given SC_SESSIONS off, Then the sessions are off even though telemetry is on", async () => {
    const poll = await service(telemetry("live"), {
      health: { ...STATIC, sessionsOff: true },
    }).poll({ includeBalance: false });
    expect(poll.health?.sessions).toBe("off");
  });

  it("Given a hostile path and values in the environment, Then none of them is in the answer", async () => {
    const gameLog = new GameLog({ logPath: "C:\\Users\\jdoe-secret\\Desktop\\Game.log" });
    const poll = await service(telemetry("live"), {
      connection: followed as never,
      health: { log: logConfigFacts(gameLog), sessionsOff: false },
    }).poll({ includeBalance: true });
    expect(JSON.stringify(poll)).not.toContain("jdoe-secret");
    expect(JSON.stringify(poll.health)).not.toContain("Desktop");
  });

  it("Given the balance asked or not, Then the health is the same (it is not derived from it)", async () => {
    const s = service(telemetry("live"), { connection: followed as never });
    const a = await s.poll({ includeBalance: false });
    const b = await s.poll({ includeBalance: true });
    expect(a.health).toEqual(b.health);
  });
});

describe("Feature: the delta protocol leaves the health alone", () => {
  it("Given a health section, Then the hashes are those of the same answer without it, and it survives tailoring", async () => {
    const s = service(telemetry("live"), { connection: followed as never });
    const without = await service(telemetry("live"), { health: undefined }).poll({
      includeBalance: false,
    });
    const full = await s.poll({ includeBalance: false });
    expect(full.hash).toEqual(without.hash);
    expect(hashSections(full)).toEqual(full.hash);
    const tailored = tailorPoll(full, { includeBalance: false, have: full.hash! });
    expect(tailored.health).toEqual(full.health);
  });
});
