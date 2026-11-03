import { describe, expect, it } from "vitest";
import { decodeFrame } from "./decode.js";
import { TelemetryHandler } from "./handler.js";
import { normalizeFrame } from "./normalize.js";
import {
  actorField,
  frame,
  vehicleField,
  weaponsField,
  type PilotSpec,
  type ShipSpec,
} from "./testing/encode.js";

/**
 * Conditions are what is true NOW, computed from the smoothed state. The sequences below are the ones measured on a
 * real Aegis Harbinger (4.10.2): in quantum mode the SHLD light goes off, the power flags of the shield generators
 * and emitters go false, the QDRV light is nominal and the altitude disappears; on arrival everything comes back.
 */

const NO_PLANET = 3.4028235e38;
const ALL_ON = {
  powerplants: true,
  engines: true,
  weapons: true,
  coolers: true,
  life_support: true,
  gravity_generators: true,
  sensors: true,
  shield_generators: true,
  shield_emitters: true,
};
const SHIELDS_OFF = { ...ALL_ON, shield_generators: false, shield_emitters: false };

const flying: ShipSpec = {
  altitude: 2500,
  g: 1,
  hydrogen: 0.8,
  power: ALL_ON,
  lights: { thr: "nominal", shld: "nominal", qdrv: "off" },
};
/** Quantum mode: flags off, SHLD off, QDRV nominal, no planet altitude. */
const quantum: ShipSpec = {
  altitude: NO_PLANET,
  g: 1,
  hydrogen: 0.8,
  power: SHIELDS_OFF,
  lights: { thr: "nominal", shld: "off", qdrv: "nominal" },
};

function world() {
  const handler = new TelemetryHandler();
  const feed = (t: number, ...fields: Buffer[]) => {
    handler.update(normalizeFrame(decodeFrame(frame(...fields)).frame), t);
    return handler.latest!;
  };
  const ship = (spec: ShipSpec) => vehicleField(spec);
  const pilot = (spec: PilotSpec = {}) => actorField({ locomotion: 3, ...spec });
  const ids = (t: number, ...fields: Buffer[]) => feed(t, ...fields).conditions.map((c) => c.id);
  const events = () => handler.events.since(0, 200);
  const types = () => events().map((e) => e.type);
  /** Feeds the same frame every 100 ms from `from` to `to` (inclusive); returns what each frame said. */
  const hold = (from: number, to: number, ...fields: Buffer[]) => {
    const seen: ReturnType<typeof feed>[] = [];
    for (let t = from; t <= to; t += 100) seen.push(feed(t, ...fields));
    return seen;
  };
  return { handler, feed, ship, pilot, ids, events, types, hold };
}

describe("Feature: the shields are powered off", () => {
  it("Given a quantum jump measured on a real ship, Then it is an info condition 'in quantum mode', and it clears on arrival", () => {
    const { feed, ship, hold, events, types } = world();
    feed(0, ship(flying));
    hold(100, 2000, ship(flying));
    expect(types()).toEqual([]);

    // Entry: all four things change in the same frame.
    const entered = hold(2100, 4000, ship(quantum));
    const last = entered.at(-1)!;
    const off = last.conditions.find((c) => c.id === "shields_off");
    expect(off).toMatchObject({ level: "info", confidence: "confirmed", data: { quantum: true } });
    expect(last.conditions.map((c) => c.id)).toContain("in_quantum");
    // Never a warning on the way in: the level is info from the first moment the condition exists.
    for (const s of entered) {
      for (const c of s.conditions.filter((x) => x.id === "shields_off")) {
        expect(c.level).toBe("info");
      }
    }
    expect(types()).toContain("shields_powered_off");
    const event = events().find((e) => e.type === "shields_powered_off")!;
    expect(event.data).toEqual({ quantum: 1 });
    expect(event.text).toBe("The shields were powered off (quantum mode).");
    expect(event.confidence).toBe("confirmed");

    // Arrival: QDRV off, SHLD nominal, flags back to true.
    const arrived = hold(4100, 6000, ship(flying));
    expect(arrived.at(-1)!.conditions.map((c) => c.id)).not.toContain("shields_off");
    expect(types()).toContain("shields_powered_on");
    expect(events().find((e) => e.type === "shields_powered_on")!.text).toBe(
      "The shields are powered on again.",
    );
  });

  it("Given the power flags falling before the drive light, Then the level is never 'warning' at any frame", () => {
    const { feed, ship, hold, events } = world();
    feed(0, ship(flying));
    hold(100, 1500, ship(flying));
    const seen = [
      ...hold(
        1600,
        1900,
        ship({ ...quantum, lights: { thr: "nominal", shld: "off", qdrv: "off" } }),
      ),
      ...hold(2000, 4000, ship(quantum)),
    ];
    const levels = seen.flatMap((s) => s.conditions.filter((c) => c.id === "shields_off"));
    expect(levels.length).toBeGreaterThan(0);
    expect(levels.every((c) => c.level === "info" && c.data?.["quantum"] === true)).toBe(true);
    expect(events().find((e) => e.type === "shields_powered_off")!.data).toEqual({ quantum: 1 });
  });

  it("Given the drive light going off before the flags come back, Then the level stays 'info' (no flash on arrival)", () => {
    const { feed, ship, hold } = world();
    feed(0, ship(flying));
    hold(100, 1500, ship(flying));
    hold(1600, 4000, ship(quantum));
    // QDRV off first (SHLD already nominal), flags still false for 300 ms.
    const lagging: ShipSpec = {
      ...quantum,
      lights: { thr: "nominal", shld: "nominal", qdrv: "off" },
    };
    const seen = [...hold(4100, 4300, ship(lagging)), ...hold(4400, 6000, ship(flying))];
    for (const s of seen) {
      for (const c of s.conditions.filter((x) => x.id === "shields_off")) {
        expect(c.level, "no warning while the quantum hold is still on").toBe("info");
      }
    }
    expect(seen.at(-1)!.conditions.map((c) => c.id)).not.toContain("shields_off");
  });

  it("Given the player cutting the shield power outside quantum mode, Then it is a warning without the quantum context", () => {
    const { feed, ship, hold, events } = world();
    feed(0, ship(flying));
    hold(100, 1500, ship(flying));
    const seen = hold(1600, 3500, ship({ ...flying, power: SHIELDS_OFF }));
    expect(seen.at(-1)!.conditions.find((c) => c.id === "shields_off")).toMatchObject({
      level: "warning",
      data: { quantum: false },
    });
    const event = events().find((e) => e.type === "shields_powered_off")!;
    expect(event.text).toBe("The shields were powered off.");
    expect(event.data).toEqual({ quantum: 0 });
  });

  it("Given only the emitters off, Then the shields are reported off too (either flag is enough)", () => {
    const { feed, ship, hold } = world();
    feed(0, ship(flying));
    hold(100, 1500, ship(flying));
    const seen = hold(
      1600,
      3500,
      ship({ ...flying, power: { ...ALL_ON, shield_emitters: false } }),
    );
    expect(seen.at(-1)!.conditions.map((c) => c.id)).toContain("shields_off");
  });

  it("Given a blip shorter than the hold, Then there is no event and no condition", () => {
    const { feed, ship, hold, types } = world();
    feed(0, ship(flying));
    hold(100, 1500, ship(flying));
    const blip = hold(1600, 2000, ship({ ...flying, power: SHIELDS_OFF }));
    hold(2100, 3500, ship(flying));
    expect(blip.flatMap((s) => s.conditions.map((c) => c.id))).not.toContain("shields_off");
    expect(types()).toEqual([]);
  });

  it("Given a ship on the ground, Then no shields_off condition", () => {
    const { feed, ship, hold } = world();
    feed(0, ship({ ...flying, landed: true }));
    hold(100, 1500, ship({ ...flying, landed: true }));
    const seen = hold(1600, 3500, ship({ ...flying, landed: true, power: SHIELDS_OFF }));
    expect(seen.at(-1)!.conditions.map((c) => c.id)).not.toContain("shields_off");
  });

  it("Given a ship that never reported its shields on, Then it never raises the alarm (no shields: the flags stay false)", () => {
    const { feed, ship, hold, types } = world();
    const noShields = { ...flying, power: SHIELDS_OFF, lights: { thr: "nominal" as const } };
    feed(0, ship(noShields));
    const seen = hold(100, 6000, ship(noShields));
    expect(seen.flatMap((s) => s.conditions.map((c) => c.id))).not.toContain("shields_off");
    expect(types()).toEqual([]);
  });

  it("Given the dashboard opened while already in quantum mode, Then nothing is raised until the shields have been seen on (documented trade-off)", () => {
    const { feed, ship, hold, types } = world();
    feed(0, ship(quantum));
    const seen = hold(100, 3000, ship(quantum));
    expect(seen.at(-1)!.conditions.map((c) => c.id)).toEqual(["in_quantum"]);
    expect(types()).toEqual([]);
    // After the arrival the ship is known to have shields: a later cut is reported.
    hold(3100, 4500, ship(flying));
    const later = hold(4600, 6500, ship({ ...flying, power: SHIELDS_OFF }));
    expect(later.at(-1)!.conditions.map((c) => c.id)).toContain("shields_off");
  });

  it("Given a new vehicle, Then the first frame is a silent baseline (no event for shields already off)", () => {
    const { feed, ship, hold, types } = world();
    feed(0, ship(flying));
    hold(100, 1500, ship(flying));
    const other = { ...flying, name: "AEGS_Harbinger_1", power: SHIELDS_OFF };
    feed(2000, ship(other));
    hold(2100, 4000, ship(other));
    expect(types()).toEqual(["vehicle_changed"]);
  });
});

describe("Feature: conditions from the state", () => {
  it("Given the powerplant off, Then only 'powerplant_off' stands for the power conditions", () => {
    const { feed, ship, hold } = world();
    feed(0, ship(flying));
    hold(100, 1500, ship(flying));
    const dead = {
      ...flying,
      hydrogen: 0,
      power: { shield_generators: false, shield_emitters: false },
      lights: { thr: "off" as const, shld: "major_on" as const, wpn: "major_on" as const },
    };
    const seen = hold(1600, 6000, ship(dead));
    expect(seen.at(-1)!.conditions.map((c) => c.id)).toEqual(["powerplant_off"]);
    expect(seen.at(-1)!.conditions[0]).toMatchObject({ level: "critical" });
  });

  it("Given engines off with the plant on, Then 'engines_off' (warning in flight)", () => {
    const { feed, ship, hold } = world();
    feed(0, ship(flying));
    hold(100, 1500, ship(flying));
    const seen = hold(1600, 3500, ship({ ...flying, power: { ...ALL_ON, engines: false } }));
    expect(seen.at(-1)!.conditions.find((c) => c.id === "engines_off")?.level).toBe("warning");
  });

  it("Given the SHLD light major, THR minor, WPN major, RADR major, HIT and PROX, Then each condition appears, critical first", () => {
    const { feed, ship, hold } = world();
    feed(0, ship(flying));
    hold(100, 1500, ship(flying));
    const bad = {
      ...flying,
      lights: {
        thr: "minor_on" as const,
        shld: "major_on" as const,
        wpn: "major_on" as const,
        radr: "major_on" as const,
        hit: "major_on" as const,
        prox: "major_on" as const,
        qdrv: "off" as const,
      },
    };
    const ids = hold(1600, 4500, ship(bad))
      .at(-1)!
      .conditions.map((c) => c.id);
    expect(ids).toEqual([
      "shields_down",
      "hostile_lock",
      "under_fire",
      "proximity",
      "engines_damaged",
      "weapons_unpowered",
    ]);
  });

  it("Given hydrogen below the threshold, Then 'hydrogen_low' is flagged unverified; at zero it is not raised", () => {
    const { feed, ship, ids } = world();
    feed(0, ship(flying));
    const c = feed(100, ship({ ...flying, hydrogen: 0.1 })).conditions.find(
      (x) => x.id === "hydrogen_low",
    );
    expect(c).toMatchObject({ level: "warning", confidence: "unverified", data: { percent: 10 } });
    expect(ids(200, ship({ ...flying, hydrogen: 0 }))).not.toContain("hydrogen_low");
  });

  it("Given a critical boost, Then 'boost_critical'", () => {
    const { feed, ship, hold } = world();
    feed(0, ship(flying));
    const seen = hold(100, 1000, ship({ ...flying, boostCritical: true }));
    expect(seen.at(-1)!.conditions.map((c) => c.id)).toContain("boost_critical");
  });

  it("Given the pilot's state, Then health, hunger, thirst and 'down or dead' follow the gauges", () => {
    const { feed, pilot, hold } = world();
    feed(0, pilot({ health: 90, hunger: 90, thirst: 90 }));
    const low = hold(100, 500, pilot({ health: 20, hunger: 10, thirst: 15 })).at(-1)!;
    expect(low.conditions.map((c) => c.id)).toEqual(["health_low", "hunger_low", "thirst_low"]);
    expect(low.conditions[0]).toMatchObject({ level: "warning", data: { percent: 20 } });
    const down = hold(600, 2000, pilot({ health: 0, hunger: 90, thirst: 90 })).at(-1)!;
    expect(down.conditions.map((c) => c.id)).toEqual(["down_or_dead"]);
    expect(down.conditions[0]).toMatchObject({ level: "critical" });
  });

  it("Given a breath-less atmosphere, Then 'not_breathable' is critical but unverified", () => {
    const { feed, pilot, hold } = world();
    feed(0, pilot({ breathable: true }));
    const last = hold(100, 3000, pilot({ breathable: false })).at(-1)!;
    expect(last.conditions.find((c) => c.id === "not_breathable")).toMatchObject({
      level: "critical",
      confidence: "unverified",
    });
  });

  it("Given decoys spent, Then 'countermeasures_low' then 'countermeasures_empty' with the kind; a ship that never had noise stays quiet", () => {
    const { feed, ship, hold } = world();
    const frameAt = (t: number, decoy: number) =>
      feed(t, ship(flying), weaponsField({ decoy, noise: 0, guns: ["KLWE_Gun_1"] }));
    frameAt(0, 8);
    let state = frameAt(100, 8);
    for (let n = 7, t = 200; n >= 3; n--, t += 100) state = frameAt(t, n);
    const low = state.conditions.find((c) => c.id === "countermeasures_low");
    expect(low).toMatchObject({ level: "warning", data: { kind: "decoy", count: 3 } });
    for (let n = 2, t = 800; n >= 0; n--, t += 100) state = frameAt(t, n);
    const empty = state.conditions.find((c) => c.id === "countermeasures_empty");
    expect(empty).toMatchObject({ level: "critical", data: { kind: "decoy" } });
    expect(state.conditions.filter((c) => c.data?.["kind"] === "noise")).toEqual([]);
    void hold;
  });

  it("Given a condition that holds, Then 'since' stays fixed; once it clears and returns it starts again", () => {
    const { feed, ship, hold } = world();
    feed(0, ship(flying));
    hold(100, 1500, ship(flying));
    const bad = { ...flying, boostCritical: true };
    const first = hold(1600, 3000, ship(bad))
      .at(-1)!
      .conditions.find((c) => c.id === "boost_critical")!;
    const again = hold(3100, 4000, ship(bad))
      .at(-1)!
      .conditions.find((c) => c.id === "boost_critical")!;
    expect(again.since).toBe(first.since);
    hold(4100, 6000, ship(flying));
    const back = hold(6100, 7500, ship(bad))
      .at(-1)!
      .conditions.find((c) => c.id === "boost_critical")!;
    expect(back.since).toBeGreaterThan(first.since);
  });

  it("Given no ship and no pilot in the frames, Then there is no condition at all", () => {
    const { feed } = world();
    expect(feed(0, frame()).conditions).toEqual([]);
  });
});
