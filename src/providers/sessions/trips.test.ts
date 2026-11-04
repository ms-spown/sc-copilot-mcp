import { describe, expect, it } from "vitest";
import { buildContracts, type LedgerBase } from "../../dashboard/ledger.js";
import { transportLogText } from "../../dashboard/testing/ledgerScenario.js";
import { parseLog } from "../gamelog/parser.js";
import type { BalancePoint } from "../telemetry/service.js";
import { LedgerTripSource } from "./trips.js";

/** Feature: a completed contract of the transport ledger becomes a trip, settled and frozen, with a measured result. */

const BASE = Date.UTC(2026, 10, 3, 18, 0, 0);
const base = (until: number): LedgerBase => ({
  status: "ok",
  asOf: until,
  partial: false,
  contracts: buildContracts(
    parseLog(transportLogText(BASE)).events.filter((e) => Date.parse(e.time as string) <= until),
  ),
});
const history = (end: number): BalancePoint[] => [
  { at: BASE + 6000, uec: 250_000, until: BASE + 90_000 },
  { at: BASE + 90_250, uec: 434_500, until: end },
];

describe("Feature: trips from the transport ledger", () => {
  it("Given a completed hauling contract with a measured balance, Then it is a settled trip with its result", async () => {
    const now = BASE + 120_000;
    const src = new LedgerTripSource({ state: () => base(now) }, async () => history(now));
    const { trips } = await src.collect(now);
    expect(trips).toHaveLength(1); // the abandoned and the running contracts are not trips
    expect(trips[0]).toMatchObject({
      kind: "hauling",
      source: "contract_ledger",
      label: "Waste Disposal | Easy",
      net_auec: 184_500,
      net_kind: "balance_delta",
    });
    expect(trips[0].buy_terminal).toBeTruthy();
    expect(trips[0].sell_terminal).toBeTruthy();
    expect(trips[0].key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("Given the result is still pending (the settle delay has not passed), Then the trip is not returned yet", async () => {
    const now = BASE + 95_000;
    const src = new LedgerTripSource({ state: () => base(now) }, async () => history(now));
    expect((await src.collect(now)).trips).toEqual([]);
  });

  it("Given the telemetry did not see the balance, Then the trip is kept with an UNKNOWN result, never zero", async () => {
    const now = BASE + 120_000;
    const src = new LedgerTripSource({ state: () => base(now) }, async () => []);
    const { trips } = await src.collect(now);
    expect(trips).toHaveLength(1);
    expect(trips[0].net_auec).toBeNull();
    expect(trips[0].net_kind).toBeNull();
  });

  it("Given the same contract on every look, Then the key never changes; the key holds no mission id", async () => {
    const now = BASE + 120_000;
    const src = new LedgerTripSource({ state: () => base(now) }, async () => history(now));
    const a = (await src.collect(now)).trips[0].key;
    const b = (await src.collect(now + 60_000)).trips[0].key;
    expect(a).toBe(b);
    expect(a).not.toContain("aaaaaaaa");
  });

  it("Given a ledger that is off or unreadable, Then there is nothing and nothing fails", async () => {
    for (const status of ["off", "loading", "unreadable"] as const) {
      const src = new LedgerTripSource(
        { state: () => ({ status, asOf: null, partial: false, contracts: [] }) },
        async () => {
          throw new Error("no history");
        },
      );
      expect(await src.collect(BASE)).toEqual({ trips: [], context: null });
    }
  });

  it("Given the balance history fails, Then the trips are still returned with an unknown result", async () => {
    const now = BASE + 120_000;
    const src = new LedgerTripSource({ state: () => base(now) }, async () => {
      throw new Error("boom");
    });
    expect((await src.collect(now)).trips[0].net_auec).toBeNull();
  });

  it("Given steps counted as done, Then the context names the last such place and goods (an estimate)", async () => {
    const now = BASE + 120_000;
    const src = new LedgerTripSource({ state: () => base(now) }, async () => history(now));
    const { context } = await src.collect(now);
    expect(context?.location).toBeTruthy();
    expect(context?.at).toBeTruthy();
  });
});
