import { describe, expect, it } from "vitest";
import { Scenario } from "./testing/scenario.js";

describe("Feature: the poll answer carries the conditions of the moment", () => {
  it("Given a quantum jump in the story, Then conditions say shields off with the quantum context, with a start time", () => {
    const s = new Scenario();
    s.advanceTo(53_000);
    const p = s.poll(false);
    const off = p.conditions.find((c) => c.id === "shields_off");
    expect(off).toMatchObject({ level: "info", data: { quantum: true } });
    expect(off!.since).toBeLessThanOrEqual(p.at);
    expect(off!.since).toBeGreaterThan(p.at - 10_000);
    expect(p.conditions.map((c) => c.id)).toContain("in_quantum");
  });

  it("Given the arrival, Then the condition is gone and the power events are in the ring", () => {
    const s = new Scenario();
    s.advanceTo(63_000);
    const p = s.poll(false);
    expect(p.conditions.map((c) => c.id)).not.toContain("shields_off");
    const types = p.events.map((e) => e.type);
    expect(types).toContain("shields_powered_off");
    expect(types).toContain("shields_powered_on");
    const off = p.events.find((e) => e.type === "shields_powered_off")!;
    expect(off.text).toBe("The shields were powered off (quantum mode).");
  });

  it("Given unverified values, Then the poll labels them under `unverified` and leaves out the defaults of fields never filled", () => {
    const s = new Scenario();
    s.advanceTo(30_000);
    const p = s.poll(false);
    // The scenario sends no oxygen, intoxication or radiation: nothing is invented for the pilot.
    expect(p.unverified.pilot).toBeUndefined();
    // The ship lights, the atmospheric density and the boost flight settings are not in the verified list.
    expect(p.unverified.ship).toEqual({
      flight_settings: { spacebreak_enables_boost: false, g_safe_disabled_by_boost: false },
      lights_on: true,
      atmospheric_density: 0.8,
    });
    expect(p.pilot).not.toHaveProperty("unverified");
    expect(p.ship).not.toHaveProperty("unverified");
  });

  it("Given the stream is cut, Then no stale condition is offered as current", () => {
    const s = new Scenario();
    s.advanceTo(53_000);
    expect(s.poll(false).conditions.length).toBeGreaterThan(0);
    s.cut = true;
    s.advanceTo(65_000);
    const p = s.poll(false);
    expect(p.state).not.toBe("live");
    expect(p.conditions).toEqual([]);
  });

  it("Given Game.log says the player was disconnected, Then conditions are empty and the connection is reported, even with fresh frames", () => {
    const s = new Scenario();
    s.advanceTo(53_000);
    expect(s.poll(false).conditions.length).toBeGreaterThan(0);
    s.connection = {
      state: "disconnected",
      since: new Date(s.now - 4000).toISOString(),
      code: 30028,
      reason: "Remote Disconnect - player inactive",
    };
    const p = s.poll(false);
    expect(p.state).toBe("live");
    expect(p.frame_age_ms).toBeLessThan(1500);
    expect(p.conditions).toEqual([]);
    expect(p.connection).toEqual(s.connection);
  });

  it("Given the player is online or the log cannot say, Then conditions stay and no connection is invented", () => {
    const s = new Scenario();
    s.advanceTo(53_000);
    const none = s.poll(false);
    expect(none.connection).toBeUndefined();
    s.connection = {
      state: "online",
      since: new Date(s.now).toISOString(),
      code: null,
      reason: null,
    };
    const online = s.poll(false);
    expect(online.connection?.state).toBe("online");
    expect(online.conditions).toEqual(none.conditions);
  });

  it("Given a connection state, Then it never changes the hash of a section (it travels outside the sections)", () => {
    const s = new Scenario();
    s.advanceTo(30_000);
    const before = s.poll(false).hash;
    s.connection = { state: "menu", since: null, code: null, reason: null };
    expect(s.poll(false).hash).toEqual(before);
  });
});
