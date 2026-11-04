/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { configureDiskCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { SessionManager } from "../providers/sessions/manager.js";
import { createTelemetry } from "../providers/telemetry/index.js";
import { dashboardTools } from "../tools/dashboard.js";
import { createRegistry } from "../tools/registry.js";
import { suggestInputSchema, TradeSuggestService } from "./tradeSuggest.js";
import { buildKnownHolds, HOLDS_MAX, HOLDS_MAX_AGE_MS, HOLDS_MAX_TRIPS } from "./holds.js";

/**
 * The hold sizes the server knows for the player: invented ships and trips (no real game data, no network). What matters:
 * a size is a QUANTITY of recent trade runs, a name next to it appears only for the fleet list or a unique size, and
 * nothing is made up.
 */

// The tool's UEX read leaves nothing on disk.
beforeAll(() => configureDiskCache(null));

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const DAY = 24 * 3_600_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

// Invented ships. Two share 100 SCU on purpose: that size names none of them.
const VEHICLES = [
  { name: "Alpha Hauler", name_full: "Testco Alpha Hauler", scu: 696, is_spaceship: 1 },
  { name: "Beta Runner", name_full: "Testco Beta Runner", scu: 100, is_spaceship: 1 },
  { name: "Gamma Runner", name_full: "Other Gamma Runner", scu: 100, is_spaceship: 1 },
  { name: "Delta Scout", name_full: "Testco Delta Scout", scu: 0, is_spaceship: 1 },
  { name: "Eps Barge", name_full: "Testco Eps Barge", scu: 3200, is_spaceship: 1 },
];

describe("Feature: sizes come from the recent trade trips", () => {
  it("Given trips of two sizes, Then each size is counted with its latest time, newest first", () => {
    const holds = buildKnownHolds({
      trips: [
        { scu: 696, ended_at: ago(2) },
        { scu: 120, ended_at: ago(9) },
        { scu: 120, ended_at: ago(5) },
        { scu: 696, ended_at: ago(30) },
        { scu: 120, ended_at: ago(12) },
      ],
      fleet: [],
      vehicles: null,
      nowMs: NOW,
    });
    expect(holds.map((h) => [h.scu, h.trips, h.last_at])).toEqual([
      [696, 2, ago(2)],
      [120, 3, ago(5)],
    ]);
    // No UEX list: no name, whatever the size.
    expect(holds.every((h) => h.ship === null && h.basis === null)).toBe(true);
  });

  it("Given fractional, empty, absurd, future or too old trips, Then they do not count", () => {
    const holds = buildKnownHolds({
      trips: [
        { scu: 24.4, ended_at: ago(1) },
        { scu: null, ended_at: ago(1) },
        { scu: 0, ended_at: ago(1) },
        { scu: 0.2, ended_at: ago(1) },
        { scu: 999_999, ended_at: ago(1) },
        { scu: 50, ended_at: "not a date" },
        { scu: 60, ended_at: new Date(NOW + 5 * DAY).toISOString() },
        { scu: 70, ended_at: new Date(NOW - HOLDS_MAX_AGE_MS - DAY).toISOString() },
      ],
      fleet: [],
      vehicles: null,
      nowMs: NOW,
    });
    expect(holds.map((h) => h.scu)).toEqual([24]);
  });

  it("Given more trips than the bound, Then only the newest are read and the list is capped", () => {
    const trips = Array.from({ length: HOLDS_MAX_TRIPS + 40 }, (_, i) => ({
      // The oldest 40 trips have a size of their own: they must not appear.
      scu: i < HOLDS_MAX_TRIPS ? 10 + (i % 30) : 500,
      ended_at: new Date(NOW - (i + 1) * 3_600_000).toISOString(),
    }));
    const holds = buildKnownHolds({ trips, fleet: [], vehicles: null, nowMs: NOW });
    expect(holds.length).toBeLessThanOrEqual(HOLDS_MAX);
    expect(holds.some((h) => h.scu === 500)).toBe(false);
  });

  it("Given nothing at all, Then the list is empty: no size is ever made up", () => {
    expect(buildKnownHolds({ trips: [], fleet: [], vehicles: [...VEHICLES], nowMs: NOW })).toEqual(
      [],
    );
  });
});

describe("Feature: a ship name next to a size says why it is there", () => {
  it("Given a size that exactly one ship has, Then the name is given as the size's (basis taille)", () => {
    const holds = buildKnownHolds({
      trips: [{ scu: 696, ended_at: ago(1) }],
      fleet: [],
      vehicles: VEHICLES,
      nowMs: NOW,
    });
    expect(holds[0]).toMatchObject({ scu: 696, ship: "Testco Alpha Hauler", basis: "taille" });
  });

  it("Given a size two ships share, Then no name is given", () => {
    const holds = buildKnownHolds({
      trips: [{ scu: 100, ended_at: ago(1) }],
      fleet: [],
      vehicles: VEHICLES,
      nowMs: NOW,
    });
    expect(holds[0]).toMatchObject({ scu: 100, ship: null, basis: null });
  });

  it("Given a ship of the fleet list, Then it names its size even when two ships share it (basis flotte)", () => {
    const holds = buildKnownHolds({
      trips: [{ scu: 100, ended_at: ago(1) }],
      fleet: ["Testco Beta Runner"],
      vehicles: VEHICLES,
      nowMs: NOW,
    });
    expect(holds[0]).toMatchObject({ scu: 100, ship: "Testco Beta Runner", basis: "flotte" });
  });

  it("Given a fleet ship no trip has used, Then its hold is listed with no trips and no time", () => {
    const holds = buildKnownHolds({
      trips: [{ scu: 696, ended_at: ago(1) }],
      fleet: ["Testco Eps Barge", "Testco Delta Scout", "A ship UEX does not know"],
      vehicles: VEHICLES,
      nowMs: NOW,
    });
    expect(holds.map((h) => [h.scu, h.trips, h.last_at === null])).toEqual([
      [696, 1, false],
      // Delta has no hold in UEX (0 = not provided) and the unknown ship has none: neither is listed.
      [3200, 0, true],
    ]);
    expect(holds[1]).toMatchObject({ ship: "Testco Eps Barge", basis: "flotte" });
  });

  it("Given the fleet list but no UEX list, Then nothing is invented", () => {
    expect(
      buildKnownHolds({ trips: [], fleet: ["Testco Eps Barge"], vehicles: null, nowMs: NOW }),
    ).toEqual([]);
  });

  it("Given a ship name with control characters, Then the name that comes out is cleaned text", () => {
    const holds = buildKnownHolds({
      trips: [{ scu: 40, ended_at: ago(1) }],
      fleet: [],
      vehicles: [{ name: "Zed\u202eRunner", name_full: "Testco\u0007 Zed Runner", scu: 40 }],
      nowMs: NOW,
    });
    expect(holds[0]?.ship).toBe("Testco Zed Runner");
  });
});

describe("Feature: the server action lists the sizes without touching the planner", () => {
  const service = (holds?: () => Promise<unknown[]>) => {
    let planned = 0;
    const svc = new TradeSuggestService({
      plan: async () => {
        planned++;
        throw new Error("the planner must not run");
      },
      ship: async () => null,
      resolveOrigin: async (text) => ({ terminalName: text }),
      applyPlan: () => undefined,
      ...(holds ? { holds: holds as never } : {}),
      now: () => 1_000_000,
    });
    return { svc, planned: () => planned };
  };

  it("Given the action, Then the schema accepts it with no argument and refuses any other field", () => {
    expect(suggestInputSchema.safeParse({ action: "holds" }).success).toBe(true);
    expect(suggestInputSchema.safeParse({ action: "holds", cargo_scu: 5 }).success).toBe(false);
  });

  it("Given a list, Then it is answered as is, as often as asked, with no planner run and no throttle", async () => {
    const list = [{ scu: 696, trips: 2, last_at: ago(1), ship: null, basis: null }];
    const { svc, planned } = service(async () => list);
    for (let i = 0; i < 4; i++) {
      expect(await svc.handle({ action: "holds" })).toEqual({ v: 1, state: "holds", holds: list });
    }
    expect(planned()).toBe(0);
  });

  it("Given a source that fails or is absent, Then the answer is an empty list, never an error", async () => {
    const failing = service(async () => {
      throw new Error("disk");
    });
    expect(await failing.svc.handle({ action: "holds" })).toEqual({
      v: 1,
      state: "holds",
      holds: [],
    });
    expect(await service().svc.handle({ action: "holds" })).toEqual({
      v: 1,
      state: "holds",
      holds: [],
    });
  });
});

describe("Feature: the tool wires the sessions, the fleet file and UEX's ship list", () => {
  const telemetry = { ...createTelemetry({ enabled: false }), enabled: true };
  const asView = (r: ReturnType<typeof createRegistry>) => (args: unknown) =>
    r.call("sc_trade_suggest", args, { ui: true });

  it("Given saved trips, a fleet file and UEX, Then the answer lists the sizes with their names and reads each source once", async () => {
    const get = vi.fn(async () => ({ data: { status: "ok", data: VEHICLES } }));
    const tradeTripSizes = vi.fn(async () => [{ scu: 696, ended_at: ago(1) }]);
    const list = vi.fn(async () => [{ name: "Testco Eps Barge" }]);
    const tools = dashboardTools(
      {
        telemetry,
        uexClient: {
          defaults: { baseURL: "https://holds-tool.test" },
          get,
        } as unknown as HttpClient,
        sessions: { tradeTripSizes } as never,
        fleet: { list } as never,
      },
      { now: () => NOW },
    );
    const call = asView(createRegistry(tools));
    const first: any = await call({ action: "holds" });
    expect(first.structuredContent).toEqual({
      v: 1,
      state: "holds",
      holds: [
        { scu: 696, trips: 1, last_at: ago(1), ship: "Testco Alpha Hauler", basis: "taille" },
        { scu: 3200, trips: 0, last_at: null, ship: "Testco Eps Barge", basis: "flotte" },
      ],
    });
    expect(first.content[0].text).toContain("trade suggestion: holds");
    // Asked again at once (several Views): remembered for a few seconds, one read of each source.
    await call({ action: "holds" });
    expect(tradeTripSizes).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("Given sources that fail, Then the answer is an empty list and the tool does not fail", async () => {
    const tools = dashboardTools(
      {
        telemetry,
        uexClient: {
          defaults: { baseURL: "https://holds-tool-2.test" },
          get: async () => {
            throw new Error("down");
          },
        } as unknown as HttpClient,
        sessions: {
          tradeTripSizes: async () => {
            throw new Error("disk");
          },
        } as never,
        fleet: {
          list: async () => {
            throw new Error("invalid file");
          },
        } as never,
      },
      { now: () => NOW },
    );
    const out: any = await asView(createRegistry(tools))({ action: "holds" });
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toEqual({ v: 1, state: "holds", holds: [] });
  });

  it("Given nothing known and no UEX read needed, Then UEX is not asked at all", async () => {
    const get = vi.fn();
    const tools = dashboardTools(
      {
        telemetry,
        uexClient: {
          defaults: { baseURL: "https://holds-tool-3.test" },
          get,
        } as unknown as HttpClient,
        sessions: { tradeTripSizes: async () => [] } as never,
        fleet: { list: async () => [] } as never,
      },
      { now: () => NOW },
    );
    const out: any = await asView(createRegistry(tools))({ action: "holds" });
    expect(out.structuredContent.holds).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("Feature: the session manager hands over sizes and times, nothing else", () => {
  const trip = (kind: string, scu: number | null, ended: string, extra: object = {}) => ({
    key: "abcdef0123456789",
    kind,
    source: "trade_journal",
    ended_at: ended,
    scu,
    net_auec: 123_456,
    cost_auec: 99_999,
    commodity: "Laranite",
    ...extra,
  });
  const manager = (sessions: unknown[], enabled = true) =>
    new SessionManager({
      telemetry: { enabled: true } as never,
      store: { read: async () => ({ sessions }) } as never,
      config: { enabled, file: "unused", gapMs: 1000 },
      now: () => NOW,
    });

  it("Given sessions with trade, hauling and contract trips, Then only the trade trips come out, newest first, as {scu, ended_at}", async () => {
    const out = await manager([
      { trips: [trip("trade", 100, ago(9)), trip("hauling", 30, ago(8))] },
      {
        trips: [
          trip("trade", 696, ago(2)),
          trip("contract", null, ago(1)),
          trip("trade", 40, ago(3)),
        ],
      },
    ]).tradeTripSizes(10);
    expect(out).toEqual([
      { scu: 40, ended_at: ago(3) },
      { scu: 696, ended_at: ago(2) },
      { scu: 100, ended_at: ago(9) },
    ]);
    // Not one amount, goods name or key leaves.
    expect(JSON.stringify(out)).not.toMatch(/123456|99999|Laranite|abcdef/);
  });

  it("Given a limit, Then it stops there; given sessions off, Then nothing is read", async () => {
    const sessions = [{ trips: [trip("trade", 1, ago(3)), trip("trade", 2, ago(2))] }];
    expect(await manager(sessions).tradeTripSizes(1)).toHaveLength(1);
    expect(await manager(sessions, false).tradeTripSizes(10)).toEqual([]);
  });
});
