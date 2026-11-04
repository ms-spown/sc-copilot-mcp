import { describe, expect, it } from "vitest";
import type { PlaceIndex, TerminalPlace } from "./places.js";
import { resolvePosition } from "./position.js";

/**
 * Where the player is, as UEX can place it: invented terminals (no UEX data). A place is ONE orbit; a name that fits several
 * orbits is ambiguous, one that fits none is unknown, and a log token that names only a star system is not a position.
 */

const term = (id: number, orbit: number, extra: Record<string, unknown> = {}) => ({
  id,
  id_star_system: 68,
  star_system_name: "Teststar",
  id_orbit: orbit,
  name: `Shop ${id}`,
  ...extra,
});

const ROWS = [
  term(1, 10, { city_name: "Testville", orbit_name: "Alpha" }),
  term(2, 10, { space_station_name: "Alpha Dock", orbit_name: "Alpha" }),
  term(3, 20, { space_station_name: "Beta Port", orbit_name: "Beta" }),
  term(4, 30, { space_station_name: "Twin Port", orbit_name: "Gamma" }),
  term(5, 31, { space_station_name: "Twin Port", orbit_name: "Delta" }),
  term(6, 0, { outpost_name: "Orbitless Camp" }),
  // Names as UEX spells them, with the spaces the game's tokens leave out.
  term(7, 40, { city_name: "Area 18", orbit_name: "ArcCorp" }),
  term(8, 50, { city_name: "New Babbage", orbit_name: "microTech" }),
];

const place = (t: ReturnType<typeof term>): TerminalPlace =>
  ({
    terminalId: t.id,
    system: 68,
    orbit: t.id_orbit,
    planetId: 0,
    systemName: "Teststar",
    planetName: null,
    kind: "other",
    armistice: null,
    jurisdiction: null,
  }) as TerminalPlace;
const INDEX: PlaceIndex = {
  byTerminal: new Map(ROWS.map((t) => [t.id, place(t)])),
  armisticeUnavailable: null,
};

describe("Feature: a typed place becomes the terminals of one orbit", () => {
  it("Given a city, Then the player is at ITS terminals, not at every terminal of its orbit (a station of the same orbit is a hop away)", () => {
    const r = resolvePosition(ROWS, INDEX, { text: "Testville" });
    expect(r).toMatchObject({ ok: true, label: "Testville", orbit: 10, basis: "exact" });
    if (r.ok) expect(r.terminalIds.sort()).toEqual([1]);
  });

  it("Given the name of the orbit itself (a moon or a planet), Then the place is the whole orbit", () => {
    const r = resolvePosition(ROWS, INDEX, { text: "Alpha" });
    expect(r).toMatchObject({ ok: true, orbit: 10 });
    if (r.ok) expect(r.terminalIds.sort()).toEqual([1, 2]);
  });

  it("Given the name of a shop, Then the place is the station or city that shop belongs to", () => {
    const r = resolvePosition(ROWS, INDEX, { text: "Shop 2" });
    expect(r).toMatchObject({ ok: true, orbit: 10 });
    if (r.ok) expect(r.terminalIds.sort()).toEqual([2]);
  });

  it("Given a token that names the city, Then it is the city's terminals too", () => {
    const r = resolvePosition(ROWS, INDEX, { token: "Teststar1_Testville" });
    if (r.ok) expect(r.terminalIds.sort()).toEqual([1]);
    else expect.unreachable();
  });

  it("Given a name that fits two orbits, Then it is ambiguous with suggestions, and never guessed", () => {
    const r = resolvePosition(ROWS, INDEX, { text: "Twin Port" });
    expect(r).toMatchObject({ ok: false, reason: "ambiguous" });
  });

  it("Given an unknown name or a place with no orbit, Then it is not a position", () => {
    expect(resolvePosition(ROWS, INDEX, { text: "Nowhereville" })).toMatchObject({
      ok: false,
      reason: "unknown",
    });
    expect(resolvePosition(ROWS, INDEX, { text: "Orbitless Camp" })).toMatchObject({
      ok: false,
      reason: "no_orbit",
    });
    expect(resolvePosition(ROWS, INDEX, { text: "   " })).toMatchObject({ ok: false });
  });
});

describe("Feature: a game-log place token is a position only when a segment names a place exactly", () => {
  it("Given 'Teststar1_Testville', Then the city segment gives the orbit and the star-system segment is ignored", () => {
    const r = resolvePosition(ROWS, INDEX, { token: "Teststar1_Testville" });
    expect(r).toMatchObject({ ok: true, label: "Testville", orbit: 10 });
  });

  it("Given 'OOC_Teststar_3a_Beta', Then the orbit name gives the place (short and numeric segments are never names)", () => {
    expect(resolvePosition(ROWS, INDEX, { token: "OOC_Teststar_3a_Beta" })).toMatchObject({
      ok: true,
      orbit: 20,
    });
  });

  it("Given a token that names only a star system, Then it is not a position", () => {
    expect(resolvePosition(ROWS, INDEX, { token: "Teststar1" })).toMatchObject({
      ok: false,
      reason: "unknown",
    });
    expect(resolvePosition(ROWS, INDEX, { token: "OOC_Teststar" })).toMatchObject({
      ok: false,
      reason: "unknown",
    });
  });

  it("Given segments that point at two different orbits, Then it is ambiguous, not the last one", () => {
    expect(resolvePosition(ROWS, INDEX, { token: "Testville_Beta" })).toMatchObject({
      ok: false,
      reason: "ambiguous",
    });
  });

  it("Given a segment that fits two orbits and none that fits one, Then it is ambiguous", () => {
    expect(resolvePosition(ROWS, INDEX, { token: "Teststar_Twin Port" })).toMatchObject({
      ok: false,
    });
  });

  it("Given a partial match only ('Alp' inside a longer name), Then a token does not accept it", () => {
    expect(resolvePosition(ROWS, INDEX, { token: "Teststar_Dock" })).toMatchObject({
      ok: false,
      reason: "unknown",
    });
  });
});

describe("Feature: an orbit-level name is the whole orbit, named by itself, and the most specific segment wins", () => {
  it("Given 'OOC_Teststar_1_Alpha' (a moon: two places stand in that orbit), Then all of its terminals are here and the label is the orbit's, not the first city's", () => {
    const r = resolvePosition(ROWS, INDEX, { token: "OOC_Teststar_1_Alpha" });
    expect(r).toMatchObject({ ok: true, label: "Alpha", orbit: 10 });
    if (r.ok) expect(r.terminalIds.sort()).toEqual([1, 2]);
    else expect.unreachable();
  });

  it("Given the same name typed, Then the same", () => {
    const r = resolvePosition(ROWS, INDEX, { text: "Alpha" });
    expect(r).toMatchObject({ ok: true, label: "Alpha" });
  });

  it("Given a city and its orbit in one token, Then the city wins, whatever the order of the segments", () => {
    for (const token of ["Testville_Alpha", "Alpha_Testville", "OOC_Teststar_Alpha_Testville"]) {
      const r = resolvePosition(ROWS, INDEX, { token });
      expect(r, token).toMatchObject({ ok: true, label: "Testville" });
      if (r.ok) expect(r.terminalIds, token).toEqual([1]);
    }
  });
});

describe("Feature: the game's tokens write names without the spaces UEX has", () => {
  it("Given 'NewBabbage' and 'Area18', Then camel case and digit boundaries are opened before the exact lookup", () => {
    expect(resolvePosition(ROWS, INDEX, { token: "Teststar4_NewBabbage" })).toMatchObject({
      ok: true,
      label: "New Babbage",
      orbit: 50,
    });
    expect(resolvePosition(ROWS, INDEX, { token: "Teststar2_Area18" })).toMatchObject({
      ok: true,
      label: "Area 18",
      orbit: 40,
    });
  });

  it("Given 'Area18' or 'NewBabbage' typed, Then they resolve too", () => {
    expect(resolvePosition(ROWS, INDEX, { text: "Area18" })).toMatchObject({
      ok: true,
      label: "Area 18",
    });
    expect(resolvePosition(ROWS, INDEX, { text: "NewBabbage" })).toMatchObject({
      ok: true,
      label: "New Babbage",
    });
    expect(resolvePosition(ROWS, INDEX, { text: "area 18" })).toMatchObject({
      ok: true,
      label: "Area 18",
    });
  });

  it("Given a star-system token with a digit, Then opening it does not make it a place", () => {
    expect(resolvePosition(ROWS, INDEX, { token: "Teststar1" })).toMatchObject({ ok: false });
  });
});
