import { describe, expect, it } from "vitest";
import { priceRefusalsOf } from "../gamelog/priceRefusals.js";
import { observe, latest, type Observation, type ReduceConfig } from "./reducer.js";
import { aggregate, aggregateWithoutMoney, summarizeSession, withoutMoney } from "./stats.js";
import { emptyState, SessionSchema, SESSIONS_VERSION } from "./types.js";
import { session } from "./fixtures.testing.js";
import { TradeRunTripSource } from "./trips.js";
import {
  cargoBuyLine,
  cargoMismatchLine,
  journalTransactions,
} from "../../dashboard/testing/tradeScenario.js";

/**
 * The session counts the transactions the game refused because the price moved. The count must be idempotent (the reducer
 * runs again and again, under a lock, possibly in two server processes), stay inside the session, and read an older file.
 */

const T0 = Date.UTC(2026, 10, 4, 18, 0, 0);
const MIN = 60_000;
let seq = 0;
const cfg: ReduceConfig = { gapMs: 3 * 3_600_000, newId: () => `s_test_${++seq}` };
const obs = (over: Partial<Observation> & { now: number }): Observation => ({
  running: true,
  balance: null,
  freshStart: false,
  connection: null,
  game: null,
  trips: [],
  context: null,
  ...over,
});
const refusal = (ms: number) => ({ at: new Date(ms).toISOString() });

describe("Feature: refusals are counted once per refusal, whatever the number of looks", () => {
  it("Given a refusal seen on two looks, Then it counts once", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1000 }), cfg);
    const list = [refusal(T0 + MIN)];
    observe(s, obs({ now: T0 + 2 * MIN, priceRefusals: list }), cfg);
    observe(s, obs({ now: T0 + 3 * MIN, priceRefusals: list }), cfg);
    expect(latest(s)!.price_refusals).toBe(1);
    expect(latest(s)!.price_refusal_last_at).toBe(new Date(T0 + MIN).toISOString());
  });

  it("Given a newer refusal later, Then only that one is added", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1000 }), cfg);
    observe(s, obs({ now: T0 + 2 * MIN, priceRefusals: [refusal(T0 + MIN)] }), cfg);
    observe(
      s,
      obs({ now: T0 + 6 * MIN, priceRefusals: [refusal(T0 + MIN), refusal(T0 + 5 * MIN)] }),
      cfg,
    );
    expect(latest(s)!.price_refusals).toBe(2);
  });

  it("Given a journal that rolled over (the old refusal left the list), Then the count does not fall", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1000 }), cfg);
    observe(s, obs({ now: T0 + 2 * MIN, priceRefusals: [refusal(T0 + MIN)] }), cfg);
    observe(s, obs({ now: T0 + 9 * MIN, priceRefusals: [] }), cfg);
    observe(s, obs({ now: T0 + 10 * MIN, priceRefusals: [refusal(T0 + 9 * MIN)] }), cfg);
    expect(latest(s)!.price_refusals).toBe(2);
  });

  it("Given refusals from before the session began or with a bad time, Then they are not counted", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1000 }), cfg);
    observe(
      s,
      obs({
        now: T0 + MIN,
        priceRefusals: [refusal(T0 - 60 * MIN), { at: "not a date" }, { at: "" }],
      }),
      cfg,
    );
    expect(latest(s)!.price_refusals).toBe(0);
  });

  it("Given two refusals in the same instant, Then both are counted in one look and none again on the next", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1000 }), cfg);
    const list = [refusal(T0 + MIN), refusal(T0 + MIN)];
    observe(s, obs({ now: T0 + 2 * MIN, priceRefusals: list }), cfg);
    observe(s, obs({ now: T0 + 3 * MIN, priceRefusals: list }), cfg);
    expect(latest(s)!.price_refusals).toBe(2);
  });

  it("Given a look that brings no refusal, Then the reducer reports no change for it", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1000 }), cfg);
    const r = observe(s, obs({ now: T0 + 5_000, priceRefusals: [] }), cfg);
    expect(r.changed).toBe(false);
  });
});

describe("Feature: the file format stays version 2 and older files still read", () => {
  it("Given a session saved before the field existed, Then it reads with 0 refusals and no watermark", () => {
    const old: Record<string, unknown> = { ...session(1) };
    delete old["price_refusals"];
    delete old["price_refusal_last_at"];
    const parsed = SessionSchema.parse(old);
    expect(parsed.price_refusals).toBe(0);
    expect(parsed.price_refusal_last_at).toBeNull();
    expect(SESSIONS_VERSION).toBe(2);
  });

  it("Given a negative or fractional count in a file, Then the session is refused rather than believed", () => {
    expect(SessionSchema.safeParse({ ...session(1), price_refusals: -1 }).success).toBe(false);
    expect(SessionSchema.safeParse({ ...session(1), price_refusals: 1.5 }).success).toBe(false);
  });
});

describe("Feature: the summary (sc_session_stats, the debrief) carries the count, with or without the balance", () => {
  it("Given a session with refusals, Then the summary lists them outside `money`, and they survive withoutMoney", () => {
    const summary = summarizeSession(session(1, { price_refusals: 3 }));
    expect(summary.price_refusals).toBe(3);
    const bare = withoutMoney(summary);
    expect(bare.price_refusals).toBe(3);
    expect(bare.money).toBe("withheld");
  });

  it("Given a session object from an older build in memory (no field), Then the summary says 0", () => {
    const s: Record<string, unknown> = { ...session(1) };
    delete s["price_refusals"];
    expect(summarizeSession(s as never).price_refusals).toBe(0);
  });
});

describe("Feature: the statistics across sessions total the refusals, with or without the balance", () => {
  const sessions = [
    session(1, { price_refusals: 2, active_ms: 30 * MIN }),
    session(2, { price_refusals: 0, active_ms: 30 * MIN }),
    session(3, { price_refusals: 1, active_ms: 30 * MIN }),
  ];
  it("Given three sessions, Then the total and the per-session counts are given, and the balance is not needed", () => {
    const all = aggregate(sessions);
    expect(all.price_refusals).toBe(3);
    expect(all.per_session.map((s) => s.price_refusals)).toEqual([2, 0, 1]);
    const bare = aggregateWithoutMoney(all);
    expect(bare.money).toBe("withheld");
    expect(bare.price_refusals).toBe(3);
    expect(aggregate(sessions, { last: 1 }).price_refusals).toBe(1);
  });
});

describe("Feature: the trade source hands the refusals to the manager", () => {
  it("Given a journal with a refused purchase, Then the collection lists it, without any amount", async () => {
    const base = Date.UTC(2026, 10, 4, 18, 0, 0);
    const tx = journalTransactions(
      [cargoBuyLine(base, 10, 98_765, 100), cargoMismatchLine(base, 10.2)],
      base + 3_600_000,
    );
    const source = new TradeRunTripSource(
      () => tx,
      async () => [],
      () => undefined,
    );
    const got = await source.collect(base + 3_600_000);
    expect(got.price_refusals).toEqual(priceRefusalsOf(tx));
    expect(got.price_refusals).toHaveLength(1);
    expect(JSON.stringify(got.price_refusals)).not.toContain("98765");
  });

  it("Given no journal at all, Then there is no list (not an empty claim)", async () => {
    const source = new TradeRunTripSource(
      () => undefined,
      async () => [],
      () => undefined,
    );
    expect((await source.collect(Date.now())).price_refusals).toBeUndefined();
  });
});
