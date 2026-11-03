/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { parsePlan } from "./plan.js";
import { boundPoll, MAX_POLL_CHARS, summarizeSession, type SessionState } from "./poll.js";
import * as L from "./viewLogic.js";

const NB = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const T0 = Date.parse("2026-11-03T12:00:00Z");

const poll = (over: Record<string, unknown> = {}) => ({
  v: 1,
  state: "live",
  frame_age_ms: 200,
  last_seq: 0,
  events: [],
  ship: null,
  pilot: null,
  ...over,
});

describe("Feature: formatting, in French, never inventing", () => {
  it("Given ages, Then they read naturally and a missing age is a dash", () => {
    expect(NB(L.formatAge(350))).toBe("0,4 s");
    expect(L.formatAge(12_400)).toBe("12 s");
    expect(L.formatAge(65_000)).toBe("1 min 05");
    expect(L.formatAge(3_900_000)).toBe("1 h 05");
    for (const bad of [null, undefined, NaN, -5]) expect(L.formatAge(bad as number)).toBe("\u2014");
  });

  it("Given numbers, Then groups are thin spaces, decimals are commas, NaN is a dash", () => {
    expect(L.fmtNum(1234567)).toBe("1\u202f234\u202f567");
    expect(L.fmtNum(12.345, 1)).toBe("12,3");
    expect(L.fmtNum(-4.2, 1)).toBe("\u22124,2");
    expect(L.fmtNum(-0.01, 1)).toBe("0,0");
    expect(L.fmtNum(NaN)).toBe("\u2014");
    expect(NB(L.fmtAuec(184500, true))).toBe("+184 500");
    expect(NB(L.fmtAuec(-2500, true))).toBe("\u22122 500");
    expect(NB(L.fmtAuec("9007199254740993"))).toBe("9 007 199 254 740 993");
    expect(L.fmtAuec("12abc")).toBe("\u2014");
  });

  it("Given durations and distances, Then the unit follows the size", () => {
    expect(L.formatDuration(45_000)).toBe("45 s");
    expect(L.formatDuration(12 * 60_000 + 3000)).toBe("12 min 03 s");
    expect(L.formatDuration(3_900_000)).toBe("1 h 05 min");
    expect(NB(L.formatDistance(850))).toBe("850 m");
    expect(NB(L.formatDistance(2500))).toBe("2,5 km");
    expect(NB(L.formatDistance(250_000))).toBe("250 km");
  });

  it("Given ship titles, Then the maker leads and the instance id is gone", () => {
    expect(L.shipTitle({ class_name: "DRAK_Cutter", manufacturer_derived: "Drake" })).toBe(
      "Drake Cutter",
    );
    expect(L.shipTitle({ class_name: "ANVL_Hornet_F7C_Mk2", manufacturer_derived: "Anvil" })).toBe(
      "Anvil Hornet F7C Mk2",
    );
    expect(L.shipTitle({ name: "UNKN_Thing_1" })).toBe("UNKN Thing 1");
    expect(L.shipTitle(null)).toBe("\u2014");
  });

  it("Given identifiers, Then only the game's own shape is let through", () => {
    expect(L.isSafeId("DRAK_Cutter_907038284543")).toBe(true);
    for (const bad of ["a b", "<x>", "", "x".repeat(65), 12, null])
      expect(L.isSafeId(bad)).toBe(false);
  });
});

describe("Feature: the view state follows the polls without inventing anything", () => {
  it("Given polls, Then events are de-duplicated by seq and a restarted server resets the list", () => {
    const e = (seq: number, type = "took_off") => ({
      seq,
      type,
      confidence: "confirmed",
      group: "ship",
      at: "x",
      data: {},
    });
    let s = L.reducePoll(L.initialViewState(), poll({ events: [e(1), e(2)], last_seq: 2 }), T0);
    s = L.reducePoll(s, poll({ events: [e(1), e(2), e(3)], last_seq: 3 }), T0 + 1000);
    expect(s.events.map((x: any) => x.seq)).toEqual([1, 2, 3]);
    s = L.reducePoll(s, poll({ events: [e(1, "landed")], last_seq: 1 }), T0 + 2000);
    expect(s.events.map((x: any) => x.seq)).toEqual([1]);
    expect(s.link).toBe("ok");
  });

  it("Given a live ship, Then history grows; given a cut stream, Then it does not draw flat lines of old values", () => {
    const live = (age: number, state = "live") =>
      poll({
        state,
        frame_age_ms: age,
        ship: { instruments: { speed_ms: 100, hydrogen_fuel: 0.5 } },
      });
    let s = L.reducePoll(L.initialViewState(), live(100), T0);
    s = L.reducePoll(s, live(100), T0 + 1000);
    expect(s.series.speed).toHaveLength(2);
    s = L.reducePoll(s, live(9000), T0 + 2000);
    s = L.reducePoll(s, live(100, "connected"), T0 + 3000);
    expect(s.series.speed).toHaveLength(2);
  });

  it("Given a wrong version or a failure, Then the state says the link is down and keeps the last good data", () => {
    let s = L.reducePoll(L.initialViewState(), poll({ ship: { name: "A" } }), T0);
    s = L.reducePoll(s, { v: 99 }, T0 + 1000);
    expect(s.link).toBe("error");
    expect(s.failures).toBe(1);
    expect(s.poll.ship.name).toBe("A");
    s = L.reducePollError(s, "x".repeat(500), T0 + 2000);
    expect(s.lastError.length).toBe(120);
  });

  it("Given the balance is hidden, Then wallet events are not shown", () => {
    const state = { events: [{ type: "uec_changed" }, { type: "landed" }] };
    expect(L.visibleEvents(state, false).map((e: any) => e.type)).toEqual(["landed"]);
    expect(L.visibleEvents(state, true)).toHaveLength(2);
  });

  it("Given an answer, Then the age shown is the server's age plus the time since we received it", () => {
    const s = L.reducePoll(L.initialViewState(), poll({ frame_age_ms: 300 }), T0);
    expect(L.frameAge(s, T0 + 700)).toBe(1000);
    expect(L.frameAge(L.initialViewState(), T0)).toBeNull();
  });
});

describe("Feature: what to say about the stream", () => {
  const view = (p: any, now = T0) => L.streamInfo(L.reducePoll(L.initialViewState(), p, T0), now);

  it("Given each stream state, Then the label, the help and the greying are right", () => {
    expect(view(poll())).toMatchObject({ id: "live", grey: false });
    expect(view(poll({ state: "off" }))).toMatchObject({
      id: "off",
      grey: true,
      help: "npm run telemetry -- enable",
    });
    expect(view(poll({ state: "waiting" })).label).toBe("En attente du jeu");
    expect(view(poll({ state: "game_without_telemetry" })).detail).toContain(
      "Quitte complètement le launcher",
    );
    expect(view(poll({ state: "incompatible" })).grey).toBe(true);
    expect(view(poll({ state: "connected" })).grey).toBe(true);
  });

  it("Given a live state whose last frame is old, Then it is stale and greyed", () => {
    expect(view(poll({ frame_age_ms: 100 }), T0 + 8000)).toMatchObject({ id: "stale", grey: true });
  });

  it("Given no answer yet or a failing link, Then it is greyed too", () => {
    expect(L.streamInfo(L.initialViewState(), T0)).toMatchObject({ id: "init", grey: true });
    const s = L.reducePollError(L.initialViewState(), "boom", T0);
    expect(L.streamInfo(s, T0)).toMatchObject({ id: "error", grey: true });
  });
});

describe("Feature: the decision to poll", () => {
  const base = {
    tornDown: false,
    retired: false,
    hidden: false,
    offscreen: false,
    awaySince: null,
    now: T0,
    state: "live",
    failures: 0,
  };
  const d = (over: Record<string, unknown>) => L.pollingDecision({ ...base, ...over });

  it("Given a visible live stream, Then 1 Hz; connected 0.5 Hz; anything else every 5 s", () => {
    expect(d({})).toMatchObject({ run: true, delayMs: 1000 });
    expect(d({ state: "connected" })).toMatchObject({ run: true, delayMs: 2000 });
    for (const state of ["off", "waiting", "game_without_telemetry", "incompatible"]) {
      expect(d({ state }), state).toMatchObject({ run: true, delayMs: 5000 });
    }
  });

  it("Given hidden, off screen, torn down or retired, Then it does not poll", () => {
    expect(d({ hidden: true })).toMatchObject({ run: false, reason: "hidden" });
    expect(d({ offscreen: true })).toMatchObject({ run: false, reason: "offscreen" });
    expect(d({ tornDown: true })).toMatchObject({ run: false, reason: "teardown" });
    expect(d({ retired: true })).toMatchObject({ run: false, reason: "retired" });
  });

  it("Given a View away for 30 minutes, Then it is told to retire", () => {
    expect(d({ hidden: true, awaySince: T0 - 29 * 60_000 }).retire).toBe(false);
    expect(d({ hidden: true, awaySince: T0 - 30 * 60_000 }).retire).toBe(true);
  });

  it("Given failures, Then it backs off up to 30 s and never goes below 500 ms", () => {
    expect(d({ failures: 1 }).delayMs).toBe(2000);
    expect(d({ failures: 3 }).delayMs).toBe(8000);
    expect(d({ failures: 12 }).delayMs).toBe(30_000);
    expect(L.viewConfig().minPollMs).toBeGreaterThanOrEqual(500);
    expect(L.viewConfig().pollMs).toBeGreaterThanOrEqual(L.viewConfig().minPollMs);
  });
});

describe("Feature: what goes to the model is rare, compact and never the balance", () => {
  const live = (over: Record<string, unknown> = {}) =>
    poll({
      ship: {
        name: "DRAK_Cutter_1",
        class_name: "DRAK_Cutter",
        manufacturer_derived: "Drake",
        landed: false,
      },
      pilot: { health: { current: 100, max: 100, percent: 1 } },
      derived: {},
      balance: { uec: 424242, delta: 99, since: "x" },
      ...over,
    });
  const sum = (p: any, events: any[] = []) => L.contextSummary(p, events);

  it("Given a summary, Then it has no balance, no event text, and points to sc_live_state", () => {
    const s = sum(live(), [
      { seq: 1, confidence: "confirmed", group: "wallet", text: "balance 424242" },
    ]);
    expect(s.text).not.toContain("424242");
    expect(s.text).toContain("sc_live_state");
    expect(s.seq).toBe(0); // a wallet event is not a trigger
    expect(sum(poll({ state: "off" }))).toBeNull();
  });

  it("Given the first summary, Then it is only a baseline; a change sends once; the next change waits 30 s", () => {
    let gate = L.initialContextGate();
    let r = L.contextDecision(gate, sum(live()), T0);
    expect(r.send).toBe(false);
    gate = r.gate;
    r = L.contextDecision(gate, sum(live()), T0 + 5000);
    expect(r.send).toBe(false); // nothing changed
    const hurt = live({ pilot: { health: { current: 20, max: 100, percent: 0.2 } } });
    r = L.contextDecision(gate, sum(hurt), T0 + 6000);
    expect(r.send).toBe(true);
    expect(r.text).toContain("santé basse");
    gate = r.gate;
    const down = live({ pilot: { health: { current: 0, max: 100, percent: 0 } } });
    r = L.contextDecision(gate, sum(down), T0 + 10_000);
    expect(r.send).toBe(false); // too early...
    gate = r.gate;
    r = L.contextDecision(gate, sum(down), T0 + 37_000);
    expect(r.send).toBe(true); // ...but not lost
    expect(r.text).toContain("à terre ou mort");
  });

  it("Given a new confirmed event, Then it counts as significant; an unverified one does not", () => {
    let gate = L.initialContextGate();
    gate = L.contextDecision(gate, sum(live()), T0).gate;
    const unverified = [{ seq: 5, confidence: "unverified", group: "ship" }];
    expect(L.contextDecision(gate, sum(live(), unverified), T0 + 60_000).send).toBe(false);
    const confirmed = [{ seq: 6, confidence: "confirmed", group: "ship" }];
    expect(L.contextDecision(gate, sum(live(), confirmed), T0 + 60_000).send).toBe(true);
  });

  it("Given a vehicle name that is not an identifier, Then it is not forwarded", () => {
    const s = sum(live({ ship: { name: "<b>x</b>", class_name: "x" } }));
    expect(s.text).toContain("vaisseau aucun");
    expect(s.text).not.toContain("<");
  });

  it("Given the fixed actions, Then they say to use sc_live_state/sc_live_events and only 'route' carries the balance", () => {
    expect(L.actionMessage("analyse", {})).toContain("sc_live_state");
    expect(L.actionMessage("bilan", {})).toContain("sc_live_events");
    for (const kind of ["analyse", "bilan"])
      expect(L.actionMessage(kind, { balance: 424242 })).not.toContain("424242");
    expect(L.actionMessage("route", {})).toBeNull();
    const route = NB(L.actionMessage("route", { balance: 424242, vehicle: "DRAK_Cutter_1" })!);
    expect(route).toContain("424 242 aUEC");
    expect(route).toContain("volontairement");
    expect(L.actionMessage("route", { balance: "oops" })).toBeNull();
    expect(L.actionMessage("route", { balance: 5, vehicle: "<script>" })).toContain(
      "Mon vaisseau : inconnu",
    );
    expect(L.actionMessage("unknown", {})).toBeNull();
  });
});

describe("Feature: estimates are labelled estimates", () => {
  const series = (f: (i: number) => number, n = 40, stepMs = 5000) =>
    Array.from({ length: n }, (_, i) => [T0 + i * stepMs, f(i)]);

  it("Given a falling gauge, Then the remaining time is extrapolated from the window and says over which window", () => {
    const s = series((i) => 0.9 - i * 0.002); // -0.002 per 5 s = -0.024 per minute
    const e = L.trendEstimate(s, T0 + 39 * 5000);
    expect(e.kind).toBe("estimate");
    expect(e.perMin).toBeCloseTo(-0.024, 3);
    expect(e.remainingMs / 60_000).toBeCloseTo((0.9 - 39 * 0.002) / 0.024, 0);
    expect(e.windowMs).toBe(39 * 5000);
    expect(L.estimateText(e)).toContain("\u2248");
  });

  it("Given a flat or rising gauge, Then it says stable or rising, not a time", () => {
    expect(
      L.trendEstimate(
        series(() => 0.7),
        T0 + 195_000,
      ).kind,
    ).toBe("stable");
    expect(
      L.trendEstimate(
        series((i) => 0.2 + i * 0.01),
        T0 + 195_000,
      ).kind,
    ).toBe("rising");
  });

  it("Given too little history, Then no estimate at all", () => {
    expect(
      L.trendEstimate(
        series((i) => 0.9 - i * 0.01, 3),
        T0 + 10_000,
      ).kind,
    ).toBe("none");
    expect(
      L.trendEstimate(
        series((i) => 0.9 - i * 0.01, 10, 500),
        T0 + 5000,
      ).kind,
    ).toBe("none");
    expect(L.estimateText({ kind: "none" })).toBe("estimation indisponible");
    expect(L.trendEstimate(undefined, T0).kind).toBe("none");
  });

  it("Given pace and plan, Then the rate needs two minutes and the plan compares expected with measured", () => {
    const since = new Date(T0).toISOString();
    expect(L.sessionRate(1000, since, T0 + 60_000)).toBeNull();
    expect(L.sessionRate(3600, since, T0 + 3_600_000)!.perHour).toBeCloseTo(3600, 5);
    expect(L.sessionRate(null, since, T0 + 3_600_000)).toBeNull();
    expect(L.planProgress({ expected_profit_auec: 1000 }, 250)).toEqual({
      expected: 1000,
      actual: 250,
      ratio: 0.25,
    });
    expect(L.planProgress({}, 250)).toEqual({ expected: null, actual: 250, ratio: null });
    expect(L.planProgress(null, 1)).toBeNull();
  });

  it("Given sparkline points, Then they stay inside their box and a flat line is centred", () => {
    const s = series((i) => i % 5, 12, 1000);
    const { points } = L.sparkPoints(s, T0 + 11_000, 60_000, 120, 28);
    for (const p of points.split(" ")) {
      const [x, y] = p.split(",").map(Number) as [number, number];
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(120);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(28);
    }
    expect(
      L.sparkPoints(
        series(() => 3, 5, 1000),
        T0 + 4000,
        60_000,
        120,
        28,
      ).points,
    ).toContain(",14");
    expect(L.sparkPoints([[T0, 1]], T0, 60_000, 120, 28).points).toBe("");
  });
});

describe("Feature: alerts, lights, health", () => {
  const ev = (
    seq: number,
    type: string,
    ageS: number,
    confidence = "confirmed",
    data: any = {},
  ) => ({
    seq,
    type,
    confidence,
    group: "ship",
    at: new Date(T0 - ageS * 1000).toISOString(),
    data,
  });

  it("Given recent events, Then only important ones show, newest confirmed first, cleared when restored", () => {
    const events = [
      ev(1, "shields_down", 30),
      ev(2, "shields_restored", 20),
      ev(3, "locked_on", 10),
      ev(4, "gear_deployed", 5),
      ev(5, "hydrogen_low", 4, "unverified", { percent: 12 }),
      ev(6, "countermeasures_low", 3, "confirmed", { kind: "decoy", count: 2 }),
    ];
    const a = L.activeAlerts(events, T0, 5);
    expect(a.map((x: any) => x.label)).toEqual([
      expect.stringContaining("Contre-mesures basses"),
      "Verrouillage hostile",
      expect.stringContaining("Hydrogène bas"),
    ]);
    expect(a[2].verified).toBe(false);
    expect(L.activeAlerts(events, T0, 1)).toHaveLength(1);
  });

  it("Given an old alert, Then it fades out of the band", () => {
    expect(L.activeAlerts([ev(1, "shields_down", 400)], T0, 3)).toEqual([]);
  });

  it("Given event data, Then labels use it only when it has the right shape", () => {
    expect(
      L.eventLabel(ev(1, "vehicle_changed", 1, "confirmed", { vehicle: "DRAK_Cutter_1" })),
    ).toContain("DRAK Cutter 1");
    expect(L.eventLabel(ev(1, "vehicle_changed", 1, "confirmed", { vehicle: "<b>" }))).toBe(
      "Nouveau vaisseau : ?",
    );
    expect(L.eventLabel({ type: "something_new" })).toBe("Événement inconnu");
  });

  it("Given warning lights, Then tones follow the state and unverified lights are marked", () => {
    const lights = L.lightsInfo({
      thr: "major_on",
      shld: "off",
      qdrv: "nominal",
      radr: "minor_flashing",
    });
    const by = (k: string) => lights.find((l: any) => l.key === k);
    expect(by("thr")).toMatchObject({ tone: "bad", verified: true });
    expect(by("shld").tone).toBe("off");
    expect(by("qdrv").tone).toBe("info");
    expect(by("radr").tone).toBe("warn");
    expect(by("pwr")).toMatchObject({ verified: false, raw: "unspecified", text: "inconnu" });
    expect(lights).toHaveLength(10);
  });

  it("Given health, Then 0 is 'down or dead', absent is unknown, and neither is shown as a value", () => {
    expect(L.healthInfo({ health: { current: 0, max: 100, percent: 0 } })).toMatchObject({
      zero: true,
      text: "À terre ou mort",
    });
    expect(L.healthInfo({})).toMatchObject({ known: false, text: "\u2014" });
    expect(L.healthInfo(null).known).toBe(false);
    expect(L.healthInfo({ health: { current: 50, max: 0 } }).known).toBe(false);
    expect(L.healthInfo({ health: { current: 30, max: 100 } })).toMatchObject({
      level: "warn",
      fraction: 0.3,
    });
  });

  it("Given power and modes absent, Then they are 'unknown', not 'off'", () => {
    expect(L.powerInfo(undefined).every((p: any) => p.known === false)).toBe(true);
    expect(L.powerInfo({ engines: false }).find((p: any) => p.key === "engines")).toMatchObject({
      known: true,
      on: false,
    });
    expect(L.flightModesInfo(undefined).every((m: any) => m.known === false)).toBe(true);
  });

  it("Given the mode of the player, Then it comes from what the stream says", () => {
    expect(L.modeInfo(poll({ ship: { landed: true } })).id).toBe("landed");
    expect(L.modeInfo(poll({ ship: { landed: false }, derived: { in_jump: true } })).id).toBe(
      "jump",
    );
    expect(L.modeInfo(poll({ pilot: { locomotion: "on_foot" } })).id).toBe("foot");
    expect(
      L.modeInfo(
        poll({ derived: { ground_vehicle: "TMBL_Cyclone" }, pilot: { locomotion: "seated" } }),
      ).id,
    ).toBe("ground");
    expect(L.modeInfo(null).id).toBe("unknown");
  });
});

describe("Feature: input from outside the View is cleaned again", () => {
  it("Given a plan, Then known fields only, capped, free of control and bidi characters", () => {
    const hostile = `a\u0000b\u202ec${"z".repeat(100)}`;
    const plan = L.cleanPlan({
      commodity: hostile,
      note: 3,
      scu: 12.6,
      expected_profit_auec: Infinity,
      evil: 1,
    });
    expect(Object.keys(plan).sort()).toEqual(["commodity", "scu"]);
    expect(plan.commodity.length).toBe(60);
    expect(plan.commodity.includes(String.fromCharCode(0x202e))).toBe(false);
    expect(plan.scu).toBe(13);
    expect(L.cleanPlan("x")).toBeNull();
    expect(L.cleanPlan({})).toBeNull();
  });

  it("Given host style variables, Then only plain custom properties pass", () => {
    const ok = L.safeStyleVariables({
      "--color-text-primary": "light-dark(#111, #eee)",
      "--font-sans": '"Anthropic Sans", sans-serif',
      color: "red",
      "--bad": "url(https://x)",
      "--bad2": "red; background: blue",
      "--bad3": "a{b}",
    });
    expect(ok.map((kv: any) => kv[0])).toEqual(["--color-text-primary", "--font-sans"]);
  });
});

describe("Feature: the poll answer stays bounded whatever the stream sends", () => {
  it("Given thousands of weapons and long events, Then the answer is cut under the bound and says so", () => {
    const weapons = Array.from({ length: 5000 }, (_, i) => ({
      name: `KLWE_Laser_${i}`.repeat(3),
      powered: true,
      ready: true,
    }));
    const events = Array.from({ length: 30 }, (_, i) => ({
      seq: i,
      type: "took_off",
      group: "ship",
      confidence: "confirmed",
      at: "2026-11-03T12:00:00Z",
      text: "x".repeat(2000),
      data: {},
    }));
    const big = { v: 1, events, weapons: { weapons, countermeasures: {} } } as any;
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_POLL_CHARS);
    const bounded = boundPoll(big);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(MAX_POLL_CHARS);
    expect(bounded.weapons!.weapons.length).toBeLessThanOrEqual(64);
    expect(bounded.truncated).toMatch(/weapons cut to 64/);
    const small = { v: 1, events: [], weapons: null } as any;
    expect(boundPoll(small)).toBe(small);
  });
});

describe("Feature: the server-side plan and session summaries", () => {
  it("Given a plan from the model, Then it is cleaned and capped on the server too", () => {
    const zw = String.fromCharCode(0x200b);
    expect(
      parsePlan({ commodity: `Gold${zw}`, scu: -5, expected_profit_auec: 1e15, x: 1 }),
    ).toEqual({
      commodity: "Gold",
      scu: 0,
      expected_profit_auec: 1_000_000_000_000,
    });
    // The same invisible characters as core/untrusted.ts, on the server and again in the View.
    const hidden = [0x34f, 0x3164, 0xfe0f, 0xe0041, 0xe000, 0x17b4].map((c) =>
      String.fromCodePoint(c),
    );
    const dirty = `La${hidden.join("")}ranite`;
    expect(parsePlan({ commodity: dirty })).toEqual({ commodity: "Laranite" });
    expect(L.cleanPlan({ commodity: dirty })!.commodity.replace(/ /g, "")).toBe("Laranite");
    expect(parsePlan("no")).toBeUndefined();
    expect(parsePlan({ note: "   " })).toBeUndefined();
  });

  const at = (s: number) => new Date(T0 + s * 1000).toISOString();
  const session = (startedAt = T0, endedAt: number | null = null): SessionState => ({
    startedAt,
    endedAt,
    startSeq: 0,
    endSeq: null,
    markers: [],
  });

  it("Given take-offs, landings and jumps, Then the counters and an estimated flight time follow", () => {
    const events = [
      { type: "took_off", at: at(10) },
      { type: "jump_started", at: at(30) },
      { type: "landed", at: at(70) },
      { type: "took_off", at: at(100) },
    ];
    const s = summarizeSession(events as any, session(), T0 + 130_000, true);
    expect(s).toMatchObject({ takeoffs: 2, landings: 1, jumps: 1, flight_ms_is_estimate: true });
    expect(s.flight_ms).toBe(60_000 + 30_000);
  });

  it("Given a session that starts in flight, Then the first landing closes an interval from the start", () => {
    const s = summarizeSession(
      [{ type: "landed", at: at(40) }] as any,
      session(),
      T0 + 100_000,
      false,
    );
    expect(s.flight_ms).toBe(40_000);
    expect(s.landings).toBe(1);
  });

  it("Given no marker, Then there is nothing to count", () => {
    const s = summarizeSession(
      [],
      { startedAt: null, endedAt: null, startSeq: 0, endSeq: null, markers: [] },
      T0,
      false,
    );
    expect(s).toMatchObject({ started_at: null, takeoffs: 0, flight_ms: 0 });
  });
});
