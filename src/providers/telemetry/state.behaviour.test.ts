import { describe, expect, it } from "vitest";
import { decodeFrame } from "./decode.js";
import { EventBuffer } from "./events.js";
import { TelemetryHandler } from "./handler.js";
import { normalizeFrame } from "./normalize.js";
import {
  actorField,
  ff,
  frame,
  lf,
  vehicleField,
  weaponsField,
  type PilotSpec,
  type ShipSpec,
} from "./testing/encode.js";

const NO_PLANET = 3.4028235e38;

function world() {
  const handler = new TelemetryHandler();
  const feed = (t: number, ...fields: Buffer[]) => {
    handler.update(normalizeFrame(decodeFrame(frame(...fields)).frame), t);
    return handler.latest!;
  };
  const types = () => handler.events.since(0, 200).map((e) => e.type);
  return { handler, feed, types };
}

const ship = (spec: ShipSpec = {}) => vehicleField(spec);
const pilot = (spec: PilotSpec = {}) => actorField({ locomotion: 3, ...spec });

describe("Feature: a frame becomes an honest state", () => {
  describe("Scenario: what the stream leaves out", () => {
    it("Given a landed ship that sends no speed, Then the speed is a real 0 (proto3 default inside a present section)", () => {
      const { feed } = world();
      const state = feed(0, ship({ landed: true, altitude: 12, radar: 5 }));
      expect(state.ship?.instruments?.speed_ms).toBe(0);
      expect(state.ship?.landed).toBe(true);
    });

    it("Given a frame with only the pilot, Then the ship and weapons are absent, not zeroed", () => {
      const { feed } = world();
      const state = feed(0, pilot({ health: 80 }));
      expect(state.ship).toBeNull();
      expect(state.weapons).toBeNull();
      expect(state.pilot?.health?.percent).toBeCloseTo(0.8);
    });

    it("Given a ship frame without flight data, Then no instrument is invented and the gap is listed", () => {
      const { feed } = world();
      const state = feed(0, ship({ withFlight: false }));
      expect(state.ship?.instruments).toBeUndefined();
      expect(state.ship?.parts_missing).toContain("flight");
    });

    it("Given an empty health gauge, Then there is no health value (not a dead pilot)", () => {
      const { feed, types } = world();
      const state = feed(0, actorField({ locomotion: 1 }));
      expect(state.pilot?.health).toBeUndefined();
      expect(state.derived.health_zero).toBe(false);
      expect(types()).not.toContain("player_down");
    });

    it("Given a countermeasure type the frame does not list, Then it is absent, not 0", () => {
      const { feed } = world();
      const state = feed(0, weaponsField({ decoy: 6 }));
      expect(state.weapons?.countermeasures).toEqual({ decoy: 6 });
    });

    it("Given quantum fuel, which the game never fills, Then it only shows under 'unverified', and only when sent", () => {
      const { feed } = world();
      expect(feed(0, ship({ altitude: 10 })).ship?.unverified).toEqual({});
      expect(feed(100, ship({ altitude: 10, quantumFuel: 0.5 })).ship?.unverified).toEqual({
        quantum_fuel: 0.5,
      });
    });

    it("Given the manufacturer, Then it is derived from the class prefix and labelled as derived", () => {
      const { feed } = world();
      expect(feed(0, ship({ name: "DRAK_Cutter_1" })).ship?.manufacturer_derived).toBe("Drake");
    });
  });

  describe("Scenario: the quirks of the field test", () => {
    it("Given an altitude of 3.4e38, Then there is no planet frame: no altitude and no heading", () => {
      const { feed } = world();
      const state = feed(0, ship({ altitude: NO_PLANET, heading: 90, speed: 200 }));
      expect(state.derived.in_planet_frame).toBe(false);
      expect(state.ship?.instruments?.altitude_m).toBeUndefined();
      expect(state.ship?.instruments?.heading_deg).toBeUndefined();
      expect(state.ship?.instruments?.speed_ms).toBeCloseTo(200);
    });

    it("Given an altitude inside a planet frame, Then altitude and heading are given; a radar reading equal to altitude is not", () => {
      const { feed } = world();
      const state = feed(0, ship({ altitude: 1000, radar: 1000, heading: 90 }));
      expect(state.ship?.instruments?.altitude_m).toBe(1000);
      expect(state.ship?.instruments?.heading_deg).toBeCloseTo(90);
      expect(state.derived.radar_valid).toBe(false);
      expect(state.ship?.instruments?.radar_altitude_m).toBeUndefined();
    });

    it("Given a quantum jump (THR major, weightless, not landed), Then it is 'in a jump' and the frozen heading is dropped", () => {
      const { feed, types } = world();
      const base: ShipSpec = { altitude: 60_000, heading: 120, g: 1, lights: { thr: "nominal" } };
      feed(0, ship(base));
      const jumping: ShipSpec = { ...base, g: 0, lights: { thr: "major_on" } };
      feed(100, ship(jumping));
      feed(1700, ship(jumping));
      const state = feed(1800, ship(jumping));
      expect(state.derived.in_jump).toBe(true);
      expect(state.ship?.instruments?.heading_deg).toBeUndefined();
      expect(types()).toContain("jump_started");
    });

    it("Given the pilot's health at 0, Then 'health_zero' is set and the event says down OR dead", () => {
      const { feed, handler } = world();
      feed(0, pilot({ health: 100 }));
      feed(100, pilot({ health: 0 }));
      const state = feed(1200, pilot({ health: 0 }));
      expect(state.derived.health_zero).toBe(true);
      expect(handler.events.since(0)[0]?.text).toMatch(/down or dead/);
    });

    it("Given health back to full after 0, Then the pilot 'respawned' event fires and health_zero clears", () => {
      const { feed, types } = world();
      feed(0, pilot({ health: 100 }));
      feed(100, pilot({ health: 0 }));
      feed(1200, pilot({ health: 0 }));
      const state = feed(1300, pilot({ health: 100 }));
      expect(state.derived.health_zero).toBe(false);
      expect(types()).toEqual(["player_down", "respawned"]);
    });
  });
});

describe("Feature: events with debouncing", () => {
  describe("Scenario: getting into a ship", () => {
    it("Given the first frames of a ship that already has its shields down, Then no event is raised (silent baseline)", () => {
      const { feed, types } = world();
      feed(0, ship({ lights: { shld: "major_on" }, power: { powerplants: false } }));
      feed(5000, ship({ lights: { shld: "major_on" }, power: { powerplants: false } }));
      expect(types()).toEqual([]);
    });

    it("Given a ship that is replaced by another (Command Module), Then 'vehicle_changed' fires once", () => {
      const { feed, types } = world();
      feed(0, ship({ name: "DRAK_Ironclad_1" }));
      feed(100, ship({ name: "DRAK_Ironclad_Command_Module_2" }));
      expect(types()).toEqual(["vehicle_changed"]);
    });
  });

  describe("Scenario: combat and power", () => {
    it("Given shields down for 1.5 s, Then 'shields_down' fires once; a one-frame flicker does not", () => {
      const { feed, types } = world();
      feed(0, ship({ lights: { shld: "nominal" } }));
      feed(100, ship({ lights: { shld: "major_on" } }));
      feed(200, ship({ lights: { shld: "nominal" } }));
      expect(types()).toEqual([]);
      feed(300, ship({ lights: { shld: "major_on" } }));
      feed(2000, ship({ lights: { shld: "major_on" } }));
      expect(types()).toEqual(["shields_down"]);
    });

    it("Given a hostile lock (RADR major) held 1 s, Then 'locked_on' fires, flagged confirmed", () => {
      const { feed, handler } = world();
      feed(0, ship({ lights: { radr: "nominal" } }));
      feed(100, ship({ lights: { radr: "major_on" } }));
      feed(1200, ship({ lights: { radr: "major_on" } }));
      expect(handler.events.since(0)[0]).toMatchObject({
        type: "locked_on",
        confidence: "confirmed",
      });
    });

    it("Given the powerplant going off, Then one 'powerplant_offline' and no extra 'engines_offline'", () => {
      const { feed, types } = world();
      const on = { powerplants: true, engines: true };
      feed(0, ship({ power: on }));
      const off = { powerplants: false, engines: false };
      feed(100, ship({ power: off }));
      feed(1200, ship({ power: off }));
      expect(types()).toEqual(["powerplant_offline"]);
    });

    it("Given a ship frame with no power section, Then it does not read as 'powerplant off'", () => {
      const { feed, types } = world();
      feed(0, ship({ power: { powerplants: true } }));
      feed(100, ship({}));
      feed(3000, ship({}));
      expect(types()).toEqual([]);
    });

    it("Given the landing gear going down and the ship touching down, Then both events fire", () => {
      const { feed, types } = world();
      feed(0, ship({ gear: 1 }));
      feed(100, ship({ gear: 3 }));
      feed(200, ship({ gear: 3, landed: true }));
      feed(1300, ship({ gear: 3, landed: true }));
      expect(types()).toEqual(["gear_deployed", "landed"]);
    });
  });

  describe("Scenario: countermeasures", () => {
    it("Given decoys falling 10 -> 8 -> 6 -> 2 -> 0 (bursts of 2), Then 'low' fires once, then 'empty'", () => {
      const { feed, types } = world();
      for (const [i, n] of [10, 8, 6, 4, 2, 0].entries()) feed(i * 100, weaponsField({ decoy: n }));
      expect(types()).toEqual(["countermeasures_low", "countermeasures_empty"]);
    });
  });

  describe("Scenario: the wallet", () => {
    it("Given purchases arriving two seconds apart, Then one 'uec_changed' is raised once the balance settles", () => {
      const { feed, handler } = world();
      feed(0, pilot({ uec: 1000 }));
      feed(2000, pilot({ uec: 990 }));
      feed(4000, pilot({ uec: 975 }));
      feed(6000, pilot({ uec: 975 }));
      expect(handler.events.since(0)).toEqual([]);
      feed(9500, pilot({ uec: 975 }));
      const events = handler.events.since(0);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "uec_changed",
        data: { delta: "-25", balance: 975 },
      });
    });
  });

  describe("Scenario: the pilot", () => {
    it("Given hunger dropping under 25 %, Then 'hunger_low' fires once until it rises again", () => {
      const { feed, types } = world();
      feed(0, pilot({ hunger: 40 }));
      feed(100, pilot({ hunger: 20 }));
      feed(200, pilot({ hunger: 19 }));
      expect(types()).toEqual(["hunger_low"]);
    });

    it("Given an unverified signal (oxygen or intoxication), Then its event is marked unverified", () => {
      const { feed, handler } = world();
      feed(0, pilot({ intoxication: 0 }));
      feed(100, pilot({ intoxication: 2 }));
      expect(handler.events.since(0)[0]).toMatchObject({
        type: "intoxicated",
        confidence: "unverified",
      });
    });
  });

  describe("Scenario: ground vehicles (no vehicle frame)", () => {
    it("Given a pilot seated 12 s with a '_SCItem' seat and no vehicle frame, Then 'ground_vehicle_entered' fires, unverified", () => {
      const { feed, handler } = world();
      feed(0, pilot({ locomotion: 1 }));
      const seated = pilot({ seat: "RSI_Ursa_Rover_SCItem_Seat_Pilot_001" });
      feed(1000, seated);
      feed(14_000, seated);
      const state = feed(14_100, seated);
      expect(handler.events.since(0)[0]).toMatchObject({
        type: "ground_vehicle_entered",
        confidence: "unverified",
      });
      expect(state.derived.ground_vehicle).toBe("RSI_Ursa_Rover");
    });
  });
});

describe("Feature: the event ring", () => {
  it("Given more events than its capacity, Then the oldest are dropped and seq keeps increasing", () => {
    const ring = new EventBuffer(3);
    for (let i = 0; i < 5; i++) ring.add("landed", i);
    expect(ring.since(0).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(ring.since(4).map((e) => e.seq)).toEqual([5]);
    expect(ring.lastSeq).toBe(5);
  });

  it("Given a limit smaller than what is new, Then the newest events are returned", () => {
    const ring = new EventBuffer();
    for (let i = 0; i < 5; i++) ring.add("took_off", i);
    expect(ring.since(0, 2).map((e) => e.seq)).toEqual([4, 5]);
  });
});

describe("Feature: partial frames and baselines", () => {
  it("Given a full frame then a frame with only force feedback, Then ship and pilot are kept", () => {
    const { feed } = world();
    feed(0, ship({ speed: 100, altitude: 10 }), pilot({ health: 80 }));
    const state = feed(100, lf(7, ff(4, 0.5))); // ForceFeedbackFrame.gunfire: a section we ignore
    expect(state.ship?.instruments?.speed_ms).toBeCloseTo(100);
    expect(state.pilot?.health?.percent).toBeCloseTo(0.8);
  });

  it("Given alternating ship-only and pilot-only frames, Then both stay present and events still fire", () => {
    const { feed, types } = world();
    feed(0, ship({ lights: { shld: "nominal" } }));
    feed(100, pilot({ health: 90 }));
    feed(200, ship({ lights: { shld: "major_on" } }));
    feed(300, pilot({ health: 90 }));
    feed(1000, pilot({ health: 90 }));
    feed(1900, ship({ lights: { shld: "major_on" } }));
    const state = feed(2000, pilot({ health: 90 }));
    expect(state.pilot).not.toBeNull();
    expect(state.ship).not.toBeNull();
    expect(types()).toContain("shields_down");
  });

  it("Given a ship section silent for longer than its time to live, Then it is gone (the pilot left the ship)", () => {
    const { feed } = world();
    feed(0, ship({ speed: 5, altitude: 10 }), pilot({ health: 80 }));
    const state = feed(5000, pilot({ health: 80 }));
    expect(state.ship).toBeNull();
    expect(state.pilot).not.toBeNull();
  });

  it("Given a first ship frame without power, lights or flight, then full frames, Then no ghost events", () => {
    const { feed, types } = world();
    const full: ShipSpec = {
      landed: true,
      gear: 3,
      lights: { qdrv: "nominal", shld: "nominal" },
      power: { powerplants: true, engines: true },
      altitude: 5,
    };
    feed(0, ship({ withFlight: false }));
    feed(100, ship(full));
    feed(3000, ship(full));
    expect(types()).toEqual([]);
  });

  it("Given a pilot already at health 0 and already drunk on the first frame, Then no 'down' and no 'intoxicated' event", () => {
    const { feed, types } = world();
    feed(0, pilot({ health: 0, intoxication: 4 }));
    feed(2000, pilot({ health: 0, intoxication: 4 }));
    expect(types()).toEqual([]);
  });

  it("Given NaN or Infinity in a gauge and an instrument, Then they read as not sent, not as measurements", () => {
    const { feed, types } = world();
    const state = feed(
      0,
      lf(6, lf(1, lf(3, ff(1, 5), ff(2, Number.POSITIVE_INFINITY)))),
      ship({ speed: Number.NaN, altitude: 10 }),
    );
    expect(state.pilot?.hunger).toBeUndefined();
    expect(state.ship?.instruments?.speed_ms).toBe(0);
    expect(types()).toEqual([]);
  });
});
