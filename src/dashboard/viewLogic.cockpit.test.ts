/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import * as L from "./viewLogic.js";

const NB = (s: string) => s.replace(/[\s]/g, " ");
const live = (over: Record<string, unknown> = {}) => ({
  v: 1,
  state: "live",
  at: 1000,
  frame_age_ms: 100,
  derived: {},
  conditions: [],
  ...over,
});
const ship = (over: Record<string, unknown> = {}, instruments: Record<string, unknown> = {}) => ({
  name: "DRAK_Cutter_1",
  class_name: "DRAK_Cutter",
  manufacturer_derived: "Drake",
  landed: false,
  instruments: {
    speed_ms: 150,
    vertical_speed_ms: 2,
    hydrogen_fuel: 0.6,
    boost: { engaged: false, output: 0, reserves: 0.9, critical: false },
    g: { current: 1.2, max: 9 },
    ...instruments,
  },
  ...over,
});
const view = (scales = { speed: 150, vspeed: 10 }) => ({ scales, peaks: {} });

describe("Feature: units and winds", () => {
  it("Given speeds from walking pace to quantum travel, Then the unit follows and nothing is invented", () => {
    expect(L.formatSpeed(201)).toEqual({ value: "201", unit: "m/s" });
    expect(NB(L.formatSpeed(12_000).value)).toBe("12,0");
    expect(L.formatSpeed(12_000).unit).toBe("km/s");
    expect(L.formatSpeed(60_000_000).unit).toBe("Mm/s");
    expect(L.formatSpeed(NaN)).toEqual({ value: "—", unit: "" });
  });

  it("Given a heading, Then eight winds with the French west", () => {
    expect([0, 45, 90, 180, 270, 300, 359].map(L.cardinal)).toEqual([
      "N",
      "NE",
      "E",
      "S",
      "O",
      "NO",
      "N",
    ]);
    expect(L.cardinal(-90)).toBe("O");
    expect(L.cardinal(NaN)).toBe("");
  });

  it("Given a largest value seen, Then the dial scale is a readable ceiling, never below the minimum", () => {
    expect(L.niceScale(0, 100)).toBe(100);
    expect(L.niceScale(150, 100)).toBe(200);
    expect(L.niceScale(290, 100)).toBe(500);
    expect(L.niceScale(1300, 100)).toBe(1500);
    expect(L.niceScale(NaN, 20)).toBe(20);
  });
});

describe("Feature: the ship banner and the verdict at a glance", () => {
  it("Given a ship in flight near a planet, Then the banner names it, the maker, where it is and the gear", () => {
    const ctx = L.shipContext(
      live({
        ship: ship({ gear: "retracted", vtol: "deployed", lights_on: true }),
        derived: { in_planet_frame: true },
      }),
    );
    expect(ctx).toMatchObject({ title: "Cutter", maker: "Drake", state: { id: "planet" } });
    expect(ctx.chips.map((c: any) => c.label)).toEqual([
      "Train rentré",
      "VTOL sorti",
      "Phares allumés",
    ]);
    // The lights field is not in the verified list: the chip is marked.
    expect(ctx.chips.find((c: any) => c.id === "lights").unverified).toBe(true);
  });

  it("Given quantum mode, a jump, the ground and the powerplant off, Then each state is named, the strongest first", () => {
    const id = (over: any) => L.shipContext(live({ ship: ship(), ...over })).state.id;
    expect(id({ derived: { in_quantum_mode: true } })).toBe("quantum");
    expect(id({ derived: { in_quantum_mode: true, in_jump: true } })).toBe("jump");
    expect(id({ ship: ship({ landed: true }) })).toBe("landed");
    expect(id({})).toBe("space");
    expect(
      id({ derived: { in_jump: true }, conditions: [{ id: "powerplant_off", level: "critical" }] }),
    ).toBe("off");
  });

  it("Given conditions, Then the verdict is all well, watch this, or alert, with the first label and the others counted", () => {
    const p = live({ ship: ship() });
    expect(L.summaryInfo(p, [])).toMatchObject({ id: "ok", label: "Tout va bien" });
    expect(L.summaryInfo(p, [{ tone: "info", label: "Mode quantique" }])).toMatchObject({
      id: "ok",
    });
    expect(
      L.summaryInfo(p, [
        { tone: "warn", label: "Touché" },
        { tone: "warn", label: "Proximité" },
      ]),
    ).toMatchObject({
      id: "watch",
      label: "À surveiller : Touché (+1)",
    });
    expect(
      L.summaryInfo(p, [
        { tone: "bad", label: "Boucliers tombés" },
        { tone: "warn", label: "Touché" },
      ]),
    ).toMatchObject({ id: "alert", label: "Alerte : Boucliers tombés (+1)" });
  });

  it("Given no data, a stream that is not live, or a ship that is off, Then there is no cheerful verdict", () => {
    expect(L.summaryInfo(null, [])).toBeNull();
    expect(L.summaryInfo(live({ state: "connected" }), [])).toBeNull();
    expect(L.summaryInfo(live(), [])).toBeNull(); // neither ship nor pilot
    expect(
      L.summaryInfo(
        live({ ship: ship(), conditions: [{ id: "powerplant_off", level: "critical" }] }),
        [],
      ),
    ).toMatchObject({ id: "off", label: "Vaisseau éteint" });
  });
});

describe("Feature: the dials say only what the stream says", () => {
  it("Given the ship in flight, Then the speed dial has its deduced, labelled scale and a mark for the highest speed seen", () => {
    const i = L.instrumentInfo(live({ ship: ship() }), view({ speed: 260, vspeed: 10 }));
    expect(i.speed).toMatchObject({ text: "150", unit: "m/s", level: "ok" });
    expect(i.speed.fraction).toBeCloseTo(150 / 300);
    expect(i.speed.peak).toBeCloseTo(260 / 300);
    expect(i.speed.sub).toBe("échelle 0–300 m/s, déduite des vitesses vues");
  });

  it("Given quantum mode, Then the dial is full and says so instead of a scale that would flatten everything", () => {
    const i = L.instrumentInfo(
      live({ ship: ship({}, { speed_ms: 12_000 }), derived: { in_quantum_mode: true } }),
      view(),
    );
    expect(i.speed).toMatchObject({
      fraction: 1,
      unit: "km/s",
      sub: "mode quantique",
      level: "info",
    });
  });

  it("Given the G meter, Then it is the current value against the game's own maximum", () => {
    const i = L.instrumentInfo(live({ ship: ship({}, { g: { current: 6.5, max: 9 } }) }), view());
    expect(i.g.fraction).toBeCloseTo(6.5 / 9);
    expect(i.g).toMatchObject({ level: "warn", sub: "max du jeu 9 G" });
    expect(L.instrumentInfo(live({ ship: ship({}, { g: undefined }) }), view()).g.known).toBe(
      false,
    );
  });

  it("Given the vertical speed, Then it is a signed fraction of a scale that says what it is", () => {
    const i = L.instrumentInfo(
      live({ ship: ship({}, { vertical_speed_ms: -25 }) }),
      view({ speed: 0, vspeed: 40 }),
    );
    expect(i.vspeed.signed).toBeCloseTo(-25 / 50);
    expect(i.vspeed.sub).toBe("échelle ±50 m/s");
  });

  it("Given no planet frame, Then altitude and heading are absent with the reason, and a jump explains the frozen heading", () => {
    const i = L.instrumentInfo(live({ ship: ship() }), view());
    expect(i.altitude).toMatchObject({
      known: false,
      text: "—",
      sub: "hors du champ d’une planète",
    });
    expect(i.heading).toMatchObject({ valid: false, text: "—" });
    const j = L.instrumentInfo(live({ ship: ship(), derived: { in_jump: true } }), view());
    expect(j.heading.sub).toBe("figé pendant le saut");
    const k = L.instrumentInfo(
      live({
        ship: ship({}, { altitude_m: 2500, radar_altitude_m: 40, heading_deg: 725 }),
        derived: { in_planet_frame: true },
      }),
      view(),
    );
    expect(NB(k.altitude.text)).toBe("2,5 km");
    expect(k.altitude.radar).toBe("radar 40 m");
    expect(k.heading).toMatchObject({ valid: true, deg: 5, cardinal: "N" });
  });

  it("Given the powerplant off, Then there are no zeros: every instrument is a dash saying the ship is off", () => {
    const i = L.instrumentInfo(
      live({
        ship: ship({}, { speed_ms: 0, hydrogen_fuel: 0, g: { current: 0, max: 9 } }),
        conditions: [{ id: "powerplant_off", level: "critical" }],
      }),
      view(),
    );
    expect(i.off).toBe(true);
    for (const key of ["speed", "g", "hydrogen"]) {
      expect(i[key], key).toMatchObject({ known: false, text: "—", sub: "éteint" });
    }
    expect(i.boost.known).toBe(false);
    expect(i.heading.valid).toBe(false);
  });

  it("Given no ship at all, Then everything is unknown, never zero", () => {
    const i = L.instrumentInfo(live({ pilot: {} }), view());
    expect(i.speed.known).toBe(false);
    expect(i.hydrogen.known).toBe(false);
    expect(i.boost.known).toBe(false);
  });

  it("Given a critical boost, Then the level is critical whatever the reserve", () => {
    const i = L.instrumentInfo(
      live({
        ship: ship({}, { boost: { engaged: false, output: 0, reserves: 0.9, critical: true } }),
      }),
      view(),
    );
    expect(i.boost.level).toBe("bad");
  });
});

describe("Feature: the pilot, the weapons and the countermeasures", () => {
  it("Given a pilot, Then each value is formatted, and the pressure carries no invented unit", () => {
    const pilot = {
      health: { current: 50, max: 100 },
      heart_rate_bpm: 72,
      gravity_g: 1,
      pressure: 101.3,
      outside_temperature_c: 21,
      breathable_atmosphere: true,
      locomotion: "seated",
      crew_role: "pilot",
      seat: "seat_pilot",
    };
    const v = L.vitalsInfo({ pilot });
    expect(v).toMatchObject({
      heart: "72",
      air: "respirable",
      locomotion: "assis",
      crew: "pilote",
      seat: "seat pilot",
    });
    expect(NB(v.temperature)).toBe("21");
    expect(NB(v.pressure)).toBe("101,3");
    expect(L.vitalsInfo(live()).heart).toBe("—");
    expect(L.vitalsInfo(live({ pilot: { pressure: 0 } })).pressure).toBe("—");
  });

  it("Given several weapons without power, Then one sentence says so (no red row per weapon)", () => {
    const w = (powered: boolean, ready: boolean) => ({ name: "KLWE_Gun_S3", powered, ready });
    const none = L.weaponsInfo(
      { weapons: [w(false, false), w(false, false), w(false, false)] },
      false,
    );
    expect(none.summary).toBe("3 armes sans énergie");
    expect(none.rows.every((r: any) => r.state === "off")).toBe(true);
    const mixed = L.weaponsInfo(
      { weapons: [w(true, true), w(true, false), w(false, false)], gimbals_locked: true },
      false,
    );
    expect(mixed.summary).toBe("1 prête sur 3 · 1 sans énergie");
    expect(mixed.gimbals).toBe("Cardans verrouillés");
    expect(L.weaponsInfo({ weapons: [w(false, false)] }, true).summary).toBe(
      "1 arme · vaisseau éteint",
    );
    expect(L.weaponsInfo(null, false).summary).toContain("Pas de trame d’armes");
    expect(L.weaponsInfo({ weapons: [] }, false).summary).toBe("Aucune arme dans la trame.");
  });

  it("Given countermeasures, Then the bar is the share of the highest count seen, and an absent kind is not zero", () => {
    const cm = L.cmInfo({ countermeasures: { decoy: 2 } }, { decoy: 8 });
    expect(cm[0]).toMatchObject({ kind: "decoy", text: "2", peak: 8, known: true });
    expect(cm[0].fraction).toBeCloseTo(0.25);
    expect(cm[0].level).toBe("warn");
    expect(cm[1]).toMatchObject({ kind: "noise", known: false, text: "—", fraction: null });
    expect(L.cmInfo({ countermeasures: { decoy: 5 } }, {})[0].fraction).toBe(1);
  });
});

describe("Feature: one chronology, the unverified values and what the stream lacks", () => {
  const ev = (seq: number, type: string, at: string, data: any = {}) => ({
    seq,
    type,
    group: "ship",
    confidence: "confirmed",
    at,
    data,
  });
  const events = [
    ev(1, "took_off", "2026-11-03T12:00:00Z"),
    ev(2, "under_fire", "2026-11-03T12:01:00Z"),
    ev(3, "landed", "2026-11-03T12:02:00Z"),
  ];
  const markers = [{ kind: "start", at: "2026-11-03T11:59:00Z" }];

  it("Given events and markers, Then they sit in one list, newest first, and the filters pick one kind", () => {
    const all = L.chronology(events, markers, "all", 10);
    expect(all.map((i: any) => i.label)).toEqual([
      "Posé",
      "Touché",
      "Décollage",
      "Début de session",
    ]);
    expect(L.chronology(events, markers, "alerts", 10).map((i: any) => i.label)).toEqual([
      "Touché",
    ]);
    expect(L.chronology(events, markers, "markers", 10).map((i: any) => i.label)).toEqual([
      "Début de session",
    ]);
    expect(L.chronology(events, markers, "all", 2)).toHaveLength(2);
  });

  it("Given unverified values, Then each is a labelled line and defaults are not invented", () => {
    const items = L.unverifiedItems({
      unverified: {
        pilot: { oxygen: { current: 0.9, max: 1, percent: 0.9 }, intoxication_level: 3 },
        ship: {
          flight_settings: { spacebreak_enables_boost: true, g_safe_disabled_by_boost: false },
          quantum_fuel: 0.5,
        },
      },
    });
    expect(items.map((i: any) => i.label)).toEqual([
      "Oxygène",
      "Niveau d’intoxication",
      "Réglages de vol",
      "Carburant quantique",
    ]);
    expect(NB(items[0].text)).toContain("90 %");
    expect(items[2].text).toContain("Frein spatial active le boost oui");
    expect(L.unverifiedItems(live())).toEqual([]);
  });

  it("Given the list of what the stream lacks, Then cargo is always said, known ids are French and unknown ids stay readable", () => {
    expect(L.missingItems(["shield_level", "brand_new_thing"])).toEqual([
      "Cargaison",
      "Niveau des boucliers",
      "brand new thing",
    ]);
    expect(L.missingItems(null)).toContain("Position");
  });

  it("Given pins, Then only pinned data are listed, with their formatted value", () => {
    const p = live({ ship: ship(), pilot: { health: { current: 80, max: 100 } } });
    const items = L.pinnedItems(p, view(), { speed: true, health: true, g: false });
    expect(items.map((i: any) => i.key)).toEqual(["speed", "health"]);
    expect(NB(items[0].text)).toBe("150 m/s");
    expect(L.pinnedItems(p, view(), {})).toEqual([]);
  });
});

describe("Feature: references that live with the vehicle", () => {
  const poll = (decoy: number, name = "DRAK_Cutter_1") => ({
    v: 1,
    state: "live",
    frame_age_ms: 10,
    ship: { name, instruments: { speed_ms: 100, vertical_speed_ms: 0 } },
    weapons: { weapons: [], countermeasures: { decoy } },
    derived: {},
    events: [],
    last_seq: 0,
  });

  it("Given countermeasures spent, Then the highest count seen is kept for this vehicle and forgotten for another", () => {
    let v = L.initialViewState();
    for (const [n, t] of [
      [8, 0],
      [5, 1000],
      [2, 2000],
    ] as const)
      v = L.reducePoll(v, poll(n), t);
    expect(v.peaks.decoy).toBe(8);
    v = L.reducePoll(v, poll(6, "AEGS_Gladius_1"), 3000);
    expect(v.peaks.decoy).toBe(6);
  });

  it("Given speeds, Then the scale only grows, and quantum speeds do not count", () => {
    let v = L.initialViewState();
    const at = (speed: number, quantum = false, t = 0) =>
      L.reducePoll(
        v,
        {
          ...poll(1),
          ship: { name: "X", instruments: { speed_ms: speed, vertical_speed_ms: -30 } },
          derived: { in_quantum_mode: quantum },
        },
        t,
      );
    v = at(200);
    v = at(50, false, 1000);
    expect(v.scales.speed).toBe(200);
    v = at(9_000_000, true, 2000);
    expect(v.scales.speed).toBe(200);
    expect(v.scales.vspeed).toBe(30);
  });
});
