import { describe, expect, it } from "vitest";
import { orbitDistance, orbitKey, type OrbitMatrix } from "./distances.js";
import { analyzeOffers, type OfferInput, type OffersContext } from "./haulingOffers.js";
import { buildPlaceIndex, resolvePlace } from "./haulingPlaces.js";
import { parseContainerSizes } from "./shipSheet.js";

/**
 * Feature: concrete hauling offers are placed on UEX orbits and priced in time.
 * A small made-up map: Stanton orbits 10, 20, 30 and one Pyro orbit 400.
 */

const term = (id: number, extra: Record<string, unknown>) => ({
  id,
  id_star_system: 68,
  star_system_name: "Stanton",
  id_orbit: 10,
  name: `Shop ${id}`,
  ...extra,
});
const TERMINALS = [
  term(1, { id_orbit: 10, space_station_name: "Port Tressler", orbit_name: "Microtech" }),
  term(2, { id_orbit: 20, space_station_name: "Everus Harbor", orbit_name: "Hurston" }),
  term(3, { id_orbit: 20, city_name: "Lorville", orbit_name: "Hurston" }),
  term(4, { id_orbit: 30, space_station_name: "Seraphim Station", orbit_name: "Crusader" }),
  term(5, { id_orbit: 30, space_station_name: "Seraphim Station", orbit_name: "Crusader" }),
  term(6, { id_orbit: 31, space_station_name: "Orbital Depot A", orbit_name: "Yela" }),
  term(7, { id_orbit: 32, space_station_name: "Orbital Depot A", orbit_name: "Daymar" }),
  term(8, {
    id_orbit: 400,
    id_star_system: 64,
    star_system_name: "Pyro",
    space_station_name: "Checkmate",
    orbit_name: "Pyro I",
  }),
  term(9, { id_orbit: 0, outpost_name: "Lost Outpost" }),
  ...["A", "B", "C", "D"].map((s, i) =>
    term(20 + i, { id_orbit: 20, outpost_name: `Extra ${s}`, orbit_name: "Hurston" }),
  ),
];
const index = buildPlaceIndex(TERMINALS);

describe("Feature: a place name from the mobiGlas is resolved to a UEX orbit", () => {
  it("Given a station, Then the name resolves, case and punctuation aside", () => {
    expect(resolvePlace(index, "port  TRESSLER!")).toMatchObject({
      status: "resolved",
      basis: "exact",
      label: "Port Tressler",
      system: 68,
      orbit: 10,
    });
  });

  it("Given two terminals of one station, Then it is one place, not an ambiguity", () => {
    expect(resolvePlace(index, "Seraphim Station")).toMatchObject({
      status: "resolved",
      orbit: 30,
    });
  });

  it("Given a planet name, Then the places in its orbit share it", () => {
    expect(resolvePlace(index, "Hurston")).toMatchObject({ status: "resolved", orbit: 20 });
  });

  it("Given a name found in two orbits, Then it is ambiguous with suggestions, never guessed", () => {
    const m = resolvePlace(index, "Orbital Depot A");
    expect(m.status).toBe("ambiguous");
    expect(m.suggestions).toEqual(["Orbital Depot A"]);
    expect(m.orbit).toBeUndefined();
  });

  it("Given part of a name, Then it matches by words, flagged partial", () => {
    expect(resolvePlace(index, "tressler")).toMatchObject({ status: "resolved", basis: "partial" });
    expect(resolvePlace(index, "Nowhere Base").status).toBe("not_found");
    expect(resolvePlace(index, "  ").status).toBe("not_found");
  });
});

describe("Feature: container sizes of a ship", () => {
  it("Given UEX's text, Then sizes are numbers; empty or missing means not provided", () => {
    expect(parseContainerSizes("1,2,4,8,16")).toEqual([1, 2, 4, 8, 16]);
    expect(parseContainerSizes(" 2, 1 ,2")).toEqual([1, 2]);
    expect(parseContainerSizes("")).toBeNull();
    expect(parseContainerSizes(null)).toBeNull();
    expect(parseContainerSizes("1,x")).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ analysis

const matrix = (pairs: [number, number, number][]): OrbitMatrix => {
  const gm = new Map<string, number>();
  for (const [a, b, d] of pairs) {
    gm.set(orbitKey(a, b), d);
    gm.set(orbitKey(b, a), d);
  }
  return { gm, rows: pairs.length, oldest: null };
};
const MATRICES = new Map([
  [
    68,
    matrix([
      [10, 20, 20],
      [10, 30, 40],
      [20, 30, 50],
    ]),
  ],
]);
const SPEED = 238_314_300;
const flight = (gm: number) => 6.9 + (gm * 1e9) / SPEED;
const STOP = 480;
const HOP = 120;

const ctx = (over: Partial<OffersContext> = {}): OffersContext => ({
  resolve: (q) => resolvePlace(index, q),
  distance: (a, b) => orbitDistance(a, b, MATRICES),
  model: { quantumSpeedMs: SPEED, spoolSeconds: 6.9, stopSeconds: STOP, localHopSeconds: HOP },
  ship: { name: "Test", hold_scu: 46, max_container_size: 16 },
  ...over,
});
const offer = (o: Partial<OfferInput> & { pickup: string; dropoffs: string[] }): OfferInput => ({
  title: null,
  reward: 100_000,
  scu: 20,
  maxContainerSize: null,
  ...o,
});
const perHour = (reward: number, seconds: number) => Math.round(reward / (seconds / 3600));

describe("Feature: one offer alone", () => {
  it("Given a pickup and a drop-off in two orbits, Then time is two stops and one flight, as an estimate", () => {
    const r = analyzeOffers(
      [offer({ pickup: "Port Tressler", dropoffs: ["Everus Harbor"] })],
      ctx(),
    );
    const secs = 2 * STOP + flight(20);
    expect(r.offers[0].alone.minutes).toBe(Math.round((secs / 60) * 10) / 10);
    expect(r.offers[0].alone.reward_per_hour).toBe(perHour(100_000, secs));
    expect(r.offers[0].alone.route).toEqual(["Port Tressler", "Everus Harbor"]);
    expect(r.best_single).toEqual({
      offer: 1,
      reward_per_hour: perHour(100_000, secs),
    });
  });

  it("Given two places in one orbit, Then the hop is the fixed local hop", () => {
    const r = analyzeOffers([offer({ pickup: "Everus Harbor", dropoffs: ["Lorville"] })], ctx());
    const secs = 2 * STOP + HOP;
    expect(r.offers[0].alone.reward_per_hour).toBe(perHour(100_000, secs));
  });

  it("Given several drop-offs, Then the cheapest order is chosen", () => {
    // From orbit 10: orbit 20 is 20 Gm, orbit 30 is 40 Gm; 20 to 30 is 50. Best: 10 > 20 > 30 = 70, not 10 > 30 > 20 = 90.
    const r = analyzeOffers(
      [offer({ pickup: "Port Tressler", dropoffs: ["Seraphim Station", "Everus Harbor"] })],
      ctx(),
    );
    expect(r.offers[0].alone.route).toEqual(["Port Tressler", "Everus Harbor", "Seraphim Station"]);
    expect(r.offers[0].alone.minutes).toBe(
      Math.round(((3 * STOP + flight(20) + flight(50)) / 60) * 10) / 10,
    );
  });

  it("Given an offer larger than the hold, Then it is timed as repeated trips with the way back", () => {
    const r = analyzeOffers(
      [offer({ pickup: "Port Tressler", dropoffs: ["Everus Harbor"], scu: 100 })],
      ctx(),
    );
    const one = 2 * STOP + flight(20);
    const total = 3 * one + 2 * flight(20);
    expect(r.offers[0].alone).toMatchObject({ trips: 3, reward_per_hour: perHour(100_000, total) });
    expect(r.offers[0].fit.hold).toBe("several_trips");
  });

  it("Given a place that cannot be resolved, Then there is no time and the reason says so", () => {
    const r = analyzeOffers(
      [offer({ pickup: "Nowhere Base", dropoffs: ["Everus Harbor"] })],
      ctx(),
    );
    expect(r.offers[0].alone).toMatchObject({ minutes: null, reward_per_hour: null });
    expect(r.offers[0].alone.reason).toMatch(/could not be resolved/);
    expect(r.offers[0].pickup.status).toBe("not_found");
    expect(r.best_single).toBeNull();
  });

  it("Given a route between two systems, Then the hourly figure is null with the reason", () => {
    const r = analyzeOffers([offer({ pickup: "Port Tressler", dropoffs: ["Checkmate"] })], ctx());
    expect(r.offers[0].alone.reward_per_hour).toBeNull();
    expect(r.offers[0].alone.reason).toMatch(/different star systems/);
  });

  it("Given a place with no UEX orbit, Then there is no time unless it is the only stop", () => {
    const r = analyzeOffers(
      [offer({ pickup: "Port Tressler", dropoffs: ["Lost Outpost"] })],
      ctx(),
    );
    expect(r.offers[0].alone.reason).toMatch(/no orbit/);
  });

  it("Given no quantum speed, Then a flight has no time but a hop inside an orbit does", () => {
    const noSpeed = ctx({
      model: { quantumSpeedMs: null, spoolSeconds: 6.9, stopSeconds: STOP, localHopSeconds: HOP },
    });
    const far = analyzeOffers(
      [offer({ pickup: "Port Tressler", dropoffs: ["Everus Harbor"] })],
      noSpeed,
    );
    expect(far.offers[0].alone.reason).toMatch(/no quantum speed/);
    const near = analyzeOffers(
      [offer({ pickup: "Everus Harbor", dropoffs: ["Lorville"] })],
      noSpeed,
    );
    expect(near.offers[0].alone.reward_per_hour).not.toBeNull();
  });

  it("Given containers too big for the ship, Then the offer is flagged and gets no time", () => {
    const r = analyzeOffers(
      [offer({ pickup: "Port Tressler", dropoffs: ["Everus Harbor"], maxContainerSize: 32 })],
      ctx(),
    );
    expect(r.offers[0].fit.container).toBe("too_big");
    expect(r.offers[0].alone.reward_per_hour).toBeNull();
  });
});

describe("Feature: bundles of offers that share a pickup orbit", () => {
  const two = [
    offer({ title: "A", reward: 100_000, pickup: "Port Tressler", dropoffs: ["Everus Harbor"] }),
    offer({ title: "B", reward: 80_000, pickup: "Port Tressler", dropoffs: ["Lorville"] }),
  ];

  it("Given two offers with one pickup, Then the bundle shares the stop and is compared with the best single", () => {
    const r = analyzeOffers(two, ctx());
    expect(r.bundles).toHaveLength(1);
    const b = r.bundles[0];
    // Pickup, then Everus and Lorville (one orbit, so a local hop between them): 3 stops.
    const secs = 3 * STOP + flight(20) + HOP;
    expect(b).toMatchObject({
      offers: [1, 2],
      scu_total: 40,
      reward_total: 180_000,
      reward_per_hour: perHour(180_000, secs),
    });
    expect(b.vs_best_single).toBe(
      Math.round((perHour(180_000, secs) / (r.best_single?.reward_per_hour ?? 1)) * 100) / 100,
    );
    expect(r.bundles_evaluated).toBe(1);
  });

  it("Given offers whose SCU exceed the hold together, Then they are not bundled", () => {
    const r = analyzeOffers(
      two.map((o) => ({ ...o, scu: 30 })),
      ctx(),
    );
    expect(r.bundles).toHaveLength(0);
    expect(r.bundles_evaluated).toBe(0);
  });

  it("Given no hold, Then offers are not combined and the note says why", () => {
    const r = analyzeOffers(two, ctx({ ship: null }));
    expect(r.bundles).toHaveLength(0);
    expect(r.bundles_note).toMatch(/hold is unknown/);
    expect(r.offers[0].fit.hold).toBe("unknown");
  });

  it("Given different pickup orbits, Then there is no bundle", () => {
    const r = analyzeOffers(
      [two[0], offer({ pickup: "Everus Harbor", dropoffs: ["Seraphim Station"] })],
      ctx(),
    );
    expect(r.bundles).toHaveLength(0);
    expect(r.bundles_note).toMatch(/No bundle/);
    expect(r.bundles_evaluated).toBe(0);
  });

  it("Given ten offers and six drop-offs, Then the work stays bounded and the order is stable", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      offer({
        title: `O${i}`,
        reward: 50_000 + i,
        scu: 4,
        pickup: "Port Tressler",
        dropoffs: ["Everus Harbor", "Seraphim Station", "Lorville"],
      }),
    );
    const a = analyzeOffers(many, ctx());
    const b = analyzeOffers(many, ctx());
    expect(a.bundles).toHaveLength(5);
    expect(a.bundles.map((x) => x.offers)).toEqual(b.bundles.map((x) => x.offers));
    expect(a.bundles_evaluated).toBe(45 + 120 + 210);
  });

  it("Given a bundle with a cross-system leg, Then it has no hourly figure and a reason", () => {
    const r = analyzeOffers(
      [
        offer({ pickup: "Port Tressler", dropoffs: ["Everus Harbor"] }),
        offer({ pickup: "Port Tressler", dropoffs: ["Checkmate"] }),
      ],
      ctx(),
    );
    // Both pickups resolve to one orbit, so they are grouped; the Pyro drop-off makes the time unknown.
    expect(r.offers[0].alone.reward_per_hour).not.toBeNull();
    expect(r.bundles).toHaveLength(1);
    expect(r.bundles[0]).toMatchObject({
      minutes: null,
      reward_per_hour: null,
      vs_best_single: null,
    });
    expect(r.bundles[0].reason).toMatch(/different star systems/);
  });

  it("Given more than six drop-off stops, Then the nearest-neighbour order is flagged as a heuristic", () => {
    const seven = [
      "Everus Harbor",
      "Lorville",
      "Seraphim Station",
      "Extra A",
      "Extra B",
      "Extra C",
      "Extra D",
    ];
    const few = ["Everus Harbor", "Seraphim Station"];
    const r = analyzeOffers([offer({ pickup: "Port Tressler", scu: 2, dropoffs: seven })], ctx());
    expect(r.offers[0].alone.heuristic_order).toBe(true);
    expect(r.offers[0].alone.reward_per_hour).not.toBeNull();
    const exact = analyzeOffers([offer({ pickup: "Port Tressler", scu: 2, dropoffs: few })], ctx());
    expect(exact.offers[0].alone.heuristic_order).toBeUndefined();
  });
});
