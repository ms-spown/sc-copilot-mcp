import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunMoney, TradePlan } from "../../dashboard/tradeRun.js";
import {
  buildCalibration,
  CALIBRATION_MIN_PLANNED_AUEC,
  expectedNet,
  calibrationForPoll,
} from "./calibration.js";
import { NOW, session, stamp } from "./fixtures.testing.js";
import { SessionManager } from "./manager.js";
import { summarizeSession, aggregate } from "./stats.js";
import { SessionStore } from "./store.js";
import { planLinkOf } from "./trips.js";
import type { TripCollection } from "./trips.js";
import type { Telemetry } from "../telemetry/index.js";
import type { TelemetrySnapshot, TelemetryStatusReport } from "../telemetry/service.js";
import type { Trip, TripInput } from "./types.js";

/**
 * Feature (audit of the first version): a plan is tied to a run by prices only when the run really resembles it, goods tied
 * that way are always reported as unverified, a net polluted by spending elsewhere is left out, a tiny plan is ignored,
 * and the file keeps a copy of the older format before its first rewrite. Invented figures.
 */

const DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------
// 1. The price link is strict
// ---------------------------------------------------------------------------------------------

const PLAN: TradePlan = {
  commodity: "Laranite",
  scu: 100,
  expected_profit_auec: 3000,
  buy_unit_price: 100,
  sell_unit_price: 130,
};
const money = (
  buy: number | null,
  sell: number | null,
): Pick<RunMoney, "plan_match" | "avg_buy_per_scu" | "avg_sell_per_scu"> => ({
  plan_match: "non_verifie",
  avg_buy_per_scu: buy,
  avg_sell_per_scu: sell,
});
const link = (buy: number | null, sell: number | null, scu: number | null = 100, plan = PLAN) =>
  planLinkOf(plan, { scu_bought: scu }, money(buy, sell));

describe("Feature: a foreign run does not take the plan", () => {
  it("Given a plan 100 to 130 per SCU, Then a loss, a flat run, a wild one and other prices are not tied to it", () => {
    expect(link(130, 90)).toBeNull(); // a loss
    expect(link(100, 100)).toBeNull(); // flat
    expect(link(140, 78)).toBeNull(); // negative margin and far prices
    expect(link(60, 182)).toBeNull(); // another goods, a fat margin
    expect(link(100, 160)).toBeNull(); // the selling price is 23 % off
  });

  it("Given a run that drifted by 10 % from the plan, Then it is tied by prices", () => {
    const hit = link(110, 130)!;
    expect(hit.link).toBe("prices");
    expect(link(100, 130)!.distance).toBeLessThan(hit.distance);
    expect(link(105, 136)!.link).toBe("prices");
  });

  it("Given the quantity is not known on either side, Then nothing is tied (never 5 000 SCU for a plan of none)", () => {
    expect(link(100, 130, null)).toBeNull();
    expect(link(100, 130, 5000)).toBeNull();
    expect(link(100, 130, 100, { ...PLAN, scu: undefined as never })).toBeNull();
    expect(link(100, 130, 100, { ...PLAN, scu: 0 })).toBeNull();
    expect(link(100, 130, 30)).toBeNull(); // more than 2.5 times less
    expect(link(100, 130, 200)!.link).toBe("prices");
  });

  it("Given the realised unit margin is far from the plan's, Then it is not tied", () => {
    // plan margin 30: 10 is a third, 70 is more than twice (prices within 15 % of 100 and 130 both)
    expect(link(115, 125)).toBeNull();
    expect(link(87, 149.5)).toBeNull();
    expect(link(100, 130)!.link).toBe("prices");
  });

  it("Given a plan with no margin or no prices, or a name that matches, Then the rules hold", () => {
    expect(link(100, 100, 100, { ...PLAN, sell_unit_price: 100 })).toBeNull();
    expect(link(100, 130, 100, { ...PLAN, buy_unit_price: undefined as never })).toBeNull();
    expect(
      planLinkOf(
        { ...PLAN, expected_profit_auec: undefined as never },
        { scu_bought: 100 },
        money(100, 130),
      ),
    ).toBeNull();
    expect(
      planLinkOf(PLAN, { scu_bought: null }, { ...money(null, null), plan_match: "ok" }),
    ).toEqual({ link: "name", distance: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// the manager: the closest candidate takes the plan
// ---------------------------------------------------------------------------------------------

const T0 = Date.UTC(2026, 10, 4, 18, 0, 0);
const MIN = 60_000;
let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-sessions-audit-"));
  file = path.join(dir, "data", "sessions.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function rig() {
  const clock = { t: T0 };
  const trips = { list: [] as TripInput[], distance: {} as Record<string, number> };
  const telemetry: Telemetry = {
    enabled: true,
    status: async () => ({ state: "live" }) as TelemetryStatusReport,
    snapshot: async () =>
      ({ state: { pilot: { uec_balance: 5_000_000 } } }) as unknown as TelemetrySnapshot,
    events: async () => ({ events: [], last_seq: 0 }),
    resetUecDelta: async () => undefined,
    stop: async () => undefined,
  };
  const store = new SessionStore(file, { now: () => clock.t });
  const manager = new SessionManager({
    telemetry,
    store,
    config: { enabled: true, file, gapMs: 3 * 60 * MIN },
    gameHint: async () => ({ running: true, telemetryRegistered: true }),
    trips: {
      collect: async (): Promise<TripCollection> => ({
        trips: trips.list,
        context: null,
        plan_distance: trips.distance,
      }),
    },
    now: () => clock.t,
    newId: () => `s_audit_${clock.t}`,
  });
  const play = async (minutes: number) => {
    for (let m = 0; m < minutes; m++) {
      clock.t += MIN;
      await manager.tick();
    }
  };
  return { clock, trips, manager, store, play };
}

const candidate = (id: number, end: number): TripInput => ({
  key: `00000000000000${id.toString(16).padStart(2, "0")}`,
  kind: "trade",
  source: "trade_journal",
  started_at: new Date(end - 8 * MIN).toISOString(),
  ended_at: new Date(end).toISOString(),
  commodity: null,
  label: null,
  scu: 100,
  gross_margin_auec: 2500,
  net_auec: 2400,
  revenue_auec: 12_500,
  fees_auec: 100,
  fees_method: "mesure",
  planned_profit_auec: 3000,
  plan_link: "prices",
});

describe("Feature: when two runs could take the plan, the closer one does", () => {
  it("Given two candidates in one look, Then the closer takes the plan even if it is the later one", async () => {
    const r = rig();
    r.manager.setPlan({ ...PLAN, buy_terminal: "A", sell_terminal: "B" });
    r.trips.list = [candidate(1, T0 + 3 * MIN), candidate(2, T0 + 5 * MIN)];
    r.trips.distance = { [candidate(1, 0).key]: 0.4, [candidate(2, 0).key]: 0.05 };
    await r.play(8);
    const [a, b] = (await r.store.read()).sessions[0].trips;
    expect(a.planned_profit_auec).toBeNull();
    expect(a.plan_link).toBeNull();
    expect(a.commodity).toBeNull();
    expect(b).toMatchObject({
      planned_profit_auec: 3000,
      plan_link: "prices",
      commodity: "Laranite",
      label: "Cargo Laranite (lien par prix)",
    });
  });

  it("Given equal distances, Then the earliest takes it", async () => {
    const r = rig();
    r.manager.setPlan(PLAN);
    r.trips.list = [candidate(1, T0 + 3 * MIN), candidate(2, T0 + 5 * MIN)];
    await r.play(8);
    const [a, b] = (await r.store.read()).sessions[0].trips;
    expect(a.planned_profit_auec).toBe(3000);
    expect(b.planned_profit_auec).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Unverified goods are visible everywhere
// ---------------------------------------------------------------------------------------------

let k = 0;
const run = (
  over: Partial<Trip> & { ageDays?: number } = {},
  planned = 100_000,
  gross: number | null = 80_000,
): Trip => {
  const { ageDays = 1, ...rest } = over;
  const jitter = ++k * 1000;
  return {
    key: `ac${k.toString(16).padStart(8, "0")}`,
    kind: "trade",
    source: "trade_journal",
    started_at: new Date(NOW - ageDays * DAY - 600_000 - jitter).toISOString(),
    ended_at: new Date(NOW - ageDays * DAY - jitter).toISOString(),
    label: null,
    commodity: "Laranite",
    buy_terminal: null,
    sell_terminal: null,
    scu: 100,
    cost_auec: 200_000,
    revenue_auec: 200_000 + (gross ?? 0),
    fees_auec: 4_000,
    gross_margin_auec: gross,
    net_auec: gross === null ? null : gross - 4_000,
    net_kind: "balance_delta",
    planned_profit_auec: planned,
    planned_scu: 100,
    plan_buy_terminal: "Port Tressler",
    plan_sell_terminal: "Area18 TDD",
    fees_method: "mesure",
    plan_link: "name",
    unexplained_auec: null,
    net_doubtful: null,
    ...rest,
  };
};
const sess = (trips: Trip[]) => session(1, { trips, game_version: "4.10.197.2878 (build 1)" });
const cal = (trips: Trip[]) =>
  buildCalibration([sess(trips)], { nowMs: NOW, gameVersion: "4.10.1" });
const goods = (trips: Trip[]) => cal(trips).groups.find((g) => g.kind === "commodity")!;

describe("Feature: goods tied by prices are reported as unverified, on every surface", () => {
  const priced = Array.from({ length: 5 }, (_, i) => run({ plan_link: "prices", ageDays: 1 + i }));

  it("Given price-linked runs, Then the group, the poll form and the tool answer carry the flag; name-linked ones do not", () => {
    expect(goods(priced).goods_unverified).toBe(true);
    expect(goods(priced).linked_by_prices).toBe(5);
    expect(goods(priced).confidence).toBe("medium");
    const named = Array.from({ length: 5 }, (_, i) => run({ ageDays: 1 + i }));
    expect(goods(named).goods_unverified).toBe(false);
    const poll = calibrationForPoll(cal(priced));
    expect(poll.groups[0]).toMatchObject({ goods_unverified: true });
    expect(buildCalibration([sess(priced)], { nowMs: NOW }).note).toMatch(/goods_unverified/);
    expect(expectedNet(goods(priced), 100_000, 300_000)).toMatchObject({ goods_unverified: true });
  });

  it("Given price-linked trips, Then the session figures count them (efficiency, best goods and routes)", () => {
    const s = session(1, {
      active_ms: 3_600_000,
      trips: [
        run({ plan_link: "prices" }),
        run({ plan_link: "name" }),
        run({ plan_link: "prices" }),
      ],
    });
    expect(summarizeSession(s).money.plan).toMatchObject({ trips: 3, price_linked_trips: 2 });
    const agg = aggregate([s]);
    expect(agg.money.plan).toMatchObject({ trips: 3, price_linked_trips: 2 });
    expect(agg.money.best_commodities[0]).toMatchObject({
      commodity: "Laranite",
      price_linked_trips: 2,
    });
    expect(agg.money.best_routes[0]).toBeUndefined(); // these trips have no observed places
  });
});

// ---------------------------------------------------------------------------------------------
// 3. A net polluted by spending elsewhere is left out
// ---------------------------------------------------------------------------------------------

describe("Feature: a net that holds a purchase made elsewhere is not the run's net", () => {
  it("Given four clean runs at 80 % and one with 500 000 spent outside the run, Then the net ratio stays 0.76 and the exclusion is counted", () => {
    const clean = Array.from({ length: 4 }, () => run({}, 100_000, 80_000));
    const polluted = run({ net_auec: -420_000 }, 100_000, 80_000);
    const g = goods([...clean, polluted]);
    expect(g.n).toBe(5);
    expect(g.net_n).toBe(4);
    expect(g.net_excluded).toBe(1);
    expect(g.net_ratio).toBe(0.76);
    expect(expectedNet(g, 100_000, 500_000)!.auec).toBe(76_000);
  });

  it("Given the model's own verdict or an unexplained part, Then the net is left out too; a small one is kept", () => {
    const base = () => Array.from({ length: 2 }, () => run({}, 100_000, 80_000));
    // deduced fees make net = margin - fees by construction: only the model's measure can tell
    expect(
      goods([...base(), run({ fees_method: "estime", unexplained_auec: 90_000 })]).net_excluded,
    ).toBe(1);
    expect(goods([...base(), run({ net_doubtful: true })]).net_excluded).toBe(1);
    expect(
      goods([...base(), run({ fees_method: "estime", unexplained_auec: 2_000 })]).net_excluded,
    ).toBe(0);
    // an older trip with deduced fees and no measure: unknown, so left out
    expect(goods([...base(), run({ fees_method: null })]).net_excluded).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. A tiny plan is ignored
// ---------------------------------------------------------------------------------------------

describe("Feature: a plan below a floor is not compared", () => {
  it("Given a plan of 50 aUEC against a margin of 50 000, Then the run is ignored and counted", () => {
    expect(CALIBRATION_MIN_PLANNED_AUEC).toBe(1000);
    const g = goods([run({}, 50, 50_000), run({}, 100_000, 80_000), run({}, 100_000, 80_000)]);
    expect(g.n).toBe(2);
    expect(g.excluded.small_plan).toBe(1);
    expect(g.gross_ratio).toBe(0.8);
    // a plan smaller than the run's own fees is no plan either
    expect(
      goods([run({ fees_auec: 5_000 }, 3_000, 80_000), run(), run()]).excluded.small_plan,
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. The first write in the new format keeps the old file
// ---------------------------------------------------------------------------------------------

describe("Feature: the first rewrite of a version 1 file keeps a copy of it", () => {
  const v1 = () =>
    JSON.stringify({
      version: 1,
      revision: 3,
      saved_at: null,
      next_number: 2,
      sessions: [session(1)],
    });

  it("Given a version 1 file, When the first change is written, Then sessions.json.v1.bak holds the old file; a second change leaves it alone", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, v1());
    const store = new SessionStore(file);
    const touch = (label: string) => (d: { sessions: Session[] }) => {
      d.sessions[0].note = label;
      return { changed: true, result: null };
    };
    await store.transact(touch("first"));
    expect(JSON.parse(fs.readFileSync(file, "utf8")).version).toBe(2);
    const bak = `${file}.v1.bak`;
    expect(fs.readFileSync(bak, "utf8")).toBe(v1());
    await store.transact(touch("second"));
    expect(fs.readFileSync(bak, "utf8")).toBe(v1());
    // a copy that already exists is never overwritten, even by another store reading another v1 file
    fs.writeFileSync(file, v1().replace('"revision":3', '"revision":9'));
    await new SessionStore(file).transact(touch("third"));
    expect(fs.readFileSync(bak, "utf8")).toBe(v1());
  });

  it("Given a version 2 file or no file, Then no copy is made; given a file from version 3, Then it is untouched and read-only", async () => {
    const store = new SessionStore(file);
    await store.transact((d) => {
      d.sessions.push(session(1));
      return { changed: true, result: null };
    });
    await store.transact((d) => {
      d.sessions[0].note = "again";
      return { changed: true, result: null };
    });
    expect(fs.existsSync(`${file}.v1.bak`)).toBe(false);
    const future = JSON.stringify({ version: 3, sessions: [] });
    fs.writeFileSync(file, future);
    const old = new SessionStore(file);
    await old.read();
    await old.transact(() => ({ changed: true, result: null }));
    expect(old.readOnly).toBe(true);
    expect(old.notice).toMatch(/newer version/);
    expect(fs.readFileSync(file, "utf8")).toBe(future);
    expect(stamp(0)).toBeTruthy();
  });
});

import type { Session } from "./types.js";
