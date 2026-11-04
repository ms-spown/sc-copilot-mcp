import { describe, expect, it } from "vitest";
import { extractHauling, haulingRankIndex, HaulingFormatError } from "./hauling.js";
import { fitFor, rankHauling, RankQueryError, type RankQuery } from "./haulingRank.js";

/**
 * Feature: hauling contract templates read from SCMDB's merged file, then ranked for a ship.
 * Every contract below is hand-made; nothing is copied from game data.
 */

const ZW = String.fromCharCode(0x200b);

const SCOPES = {
  s1: {
    scopeName: "Hauling",
    ranks: [
      { name: "Trainee", rankIndex: 0, minReputation: 0 },
      { name: "Rookie", rankIndex: 1, minReputation: 50 },
      { name: "Junior", rankIndex: 2, minReputation: 250 },
      { name: "Master", rankIndex: 6, minReputation: 237750 },
    ],
  },
  s2: { scopeName: "FactionReputation", ranks: [{ name: "Neutral", rankIndex: 0 }] },
};
const gate = (scopeName: string, name: string) => ({ scopeName, name, minReputation: 1 });
const order = (resource: string, extra: Record<string, unknown>) => ({
  resource,
  maxContainerSize: 4,
  ...extra,
});

const contract = (id: string, extra: Record<string, unknown>) => ({
  id,
  debugName: `Debug_${id}`,
  category: "career",
  missionType: "Hauling",
  title: `Haul ${id}`,
  contractorName: "Acme Freight",
  illegal: false,
  canBeShared: true,
  onceOnly: false,
  hasPersonalCooldown: false,
  maxPlayersPerInstance: 1,
  timeToComplete: 30,
  rewardUEC: 100_000,
  systems: ["Stanton"],
  minStanding: gate("Hauling", "Trainee"),
  maxStanding: gate("Hauling", "Master"),
  partialRewardPayoutIndex: 1,
  availabilityIndex: 0,
  locations: ["p1"],
  destinations: ["d1", "d2"],
  haulingOrders: [order("r1", { minSCU: 10, maxSCU: 20 })],
  ...extra,
});

const MERGED = {
  version: "4.10.2-live.1",
  scopes: SCOPES,
  availabilityPools: [{}],
  partialRewardPayoutPools: [
    [],
    [
      { minPercentage: 0, maxPercentage: 25, currencyRewardMultiplier: 0 },
      { minPercentage: 26, maxPercentage: 99, currencyRewardMultiplier: 0.45 },
    ],
  ],
  resourcePools: {
    r1: { name: "Waste" },
    r2: { name: "<= PLACEHOLDER =>" },
    r3: { name: `Medical${ZW} Supplies` },
  },
  locationPools: {
    p1: { name: "Pyro", type: "Star" },
    d1: { name: "Checkmate", type: "Destination" },
    d2: { name: `<EM4>Ruin${ZW} Station</EM4>`, type: "Destination" },
  },
  contracts: [
    // ranged order plus an order with maxSCU 0 (a fixed quantity, deduced)
    contract("a1", {
      title: `<EM4>Small${ZW} Shipment</EM4>`,
      rewardUEC: 188_250,
      minStanding: gate("Hauling", "Junior"),
      haulingOrders: [
        order("r1", { minSCU: 6, maxSCU: 32 }),
        order("r3", { minSCU: 4, maxSCU: 0, maxContainerSize: 2 }),
      ],
    }),
    // the same contract again: one family with 2 variants
    contract("a2", {
      title: `<EM4>Small${ZW} Shipment</EM4>`,
      rewardUEC: 188_250,
      minStanding: gate("Hauling", "Junior"),
      haulingOrders: [
        order("r1", { minSCU: 6, maxSCU: 32 }),
        order("r3", { minSCU: 4, maxSCU: 0, maxContainerSize: 2 }),
      ],
    }),
    contract("b1", {
      missionType: "Hauling - Stellar",
      rewardUEC: 2_113_750,
      minStanding: gate("Hauling", "Master"),
      systems: ["Pyro"],
      haulingOrders: [
        order("r1", { minSCU: 100, maxSCU: 150, maxContainerSize: 32 }),
        order("r1", { minSCU: 100, maxSCU: 150, maxContainerSize: 32 }),
      ],
    }),
    contract("c1", { missionType: "Hauling - Local", illegal: true, rewardUEC: 51_000 }),
    // unknown commodity and an order counted in items: no SCU at all
    contract("d1", {
      rewardUEC: 90_000,
      haulingOrders: [
        order("r2", { minSCU: 0, maxSCU: 0 }),
        order("r1", { minAmount: 2, maxAmount: 3 }),
      ],
    }),
    contract("e1", {
      rewardUEC: 70_000,
      minStanding: gate("FactionReputation", "Neutral"),
      requiredIntros: [{ title: "Seeking New Haulers" }],
    }),
    contract("f1", { rewardUEC: 60_000, maxStanding: gate("Hauling", "Trainee"), onceOnly: true }),
    // not freight: has orders but is a mining contract
    contract("g1", { missionType: "Ship Mining", rewardUEC: 999_999_999 }),
  ],
};

const QUERY: RankQuery = {
  ship: null,
  rank: null,
  system: null,
  includeIllegal: false,
  includeUnfit: false,
  sort: "reward_per_scu",
  limit: 20,
};

describe("Feature: the extractor keeps what is certain and says what is not", () => {
  const d = extractHauling(MERGED);
  const t = (id: string) => d.templates.find((x) => x.id === id)!;

  it("Given a mixed contract list, Then only Hauling* contracts are templates and the build is kept", () => {
    expect(d.templates.map((x) => x.id)).toEqual(["a1", "a2", "b1", "c1", "d1", "e1", "f1"]);
    expect(d.data_version).toBe("4.10.2-live.1");
    expect(d.counts).toMatchObject({
      contracts_in_file: 8,
      hauling: 7,
      illegal: 1,
      requiring_intro: 1,
    });
  });

  it("Given an order with maxSCU 0 and a minimum, Then the quantity is fixed, flagged as DEDUCED", () => {
    const o = t("a1").orders[1];
    expect(o).toMatchObject({ min_scu: 4, max_scu: 4, scu_rule: "fixed_when_max_is_zero" });
    expect(t("a1").scu).toEqual({ min: 10, max: 36 });
    expect(t("a1").scu_uses_deduction).toBe(true);
    expect(d.counts.orders_fixed_by_deduction).toBe(2); // a1 and its twin a2
  });

  it("Given a placeholder commodity or an order counted in items, Then SCU and commodity are null, never 0", () => {
    const orders = t("d1").orders;
    expect(orders[0]).toMatchObject({
      commodity: null,
      commodity_is_placeholder: true,
      min_scu: null,
      max_scu: null,
      scu_rule: "unknown",
    });
    expect(orders[1].items).toEqual({ min: 2, max: 3 });
    expect(t("d1").scu).toBeNull();
    expect(t("d1").commodities).toEqual(["Waste"]);
  });

  it("Given markup and invisible characters in third-party text, Then they are removed", () => {
    expect(t("a1").title).toBe("Small Shipment");
    expect(t("a1").commodities).toEqual(["Waste", "Medical Supplies"]);
    expect(t("a1").pickup_pool).toEqual({ count: 1, types: { Star: 1 }, sample: ["Pyro"] });
    expect(t("a1").destination_pool.sample).toEqual(["Checkmate", "Ruin Station"]);
  });

  it("Given the ranks of the data, Then a Hauling gate has an index and another scale does not", () => {
    expect(t("a1").rank_min).toMatchObject({ name: "Junior", index: 2, scope: "Hauling" });
    expect(t("e1").rank_min).toMatchObject({ name: "Neutral", index: null });
    expect(haulingRankIndex(d, "master")).toBe(6);
    expect(haulingRankIndex(d, "Admiral")).toBeNull();
  });

  it("Given a partial payout table, Then it is kept once and an empty one is no table", () => {
    expect(d.partial_payout_tables[1]).toEqual([
      { from_percent: 0, to_percent: 25, reward_multiplier: 0 },
      { from_percent: 26, to_percent: 99, reward_multiplier: 0.45 },
    ]);
    expect(t("a1").partial_payout_index).toBe(1);
    const none = extractHauling({
      ...MERGED,
      contracts: [contract("z", { partialRewardPayoutIndex: 0 })],
    });
    expect(none.templates[0].partial_payout_index).toBeNull();
  });

  it("Given an empty availability pool, Then availability is unknown", () => {
    expect(d.availability_known).toBe(false);
  });

  it("Given no hauling contract with orders, Then it is a format error, not an empty answer", () => {
    expect(() => extractHauling({ contracts: [{ id: "x", missionType: "Bounty" }] })).toThrow(
      HaulingFormatError,
    );
    expect(() =>
      extractHauling({ contracts: [{ id: "x", missionType: "Hauling", title: "t" }] }),
    ).toThrow(HaulingFormatError);
  });
});

describe("Feature: families are ranked for a ship, with ranges and unknowns", () => {
  const d = extractHauling(MERGED);

  it("Given identical templates, Then they are one family counting its variants", () => {
    const r = rankHauling(d, QUERY);
    const small = r.rows.find((x) => x.title === "Small Shipment")!;
    expect(small.variants).toBe(2);
    expect(r.total_templates).toBe(7);
    expect(r.total_families).toBe(6);
  });

  it("Given a reward and a SCU range, Then the reward per SCU is a range, high end from the smallest quantity", () => {
    const small = rankHauling(d, QUERY).rows.find((x) => x.title === "Small Shipment")!;
    expect(small.reward_auec).toBe(188_250);
    expect(small.scu).toEqual({ min: 10, max: 36, fixed: false, deduced_fixed_quantity: true });
    expect(small.reward_per_scu).toEqual({ low: Math.round(188_250 / 36), high: 18_825 });
  });

  it("Given no SCU, Then the reward per SCU is null and the row comes last", () => {
    const r = rankHauling(d, QUERY);
    const unknown = r.rows.find((x) => x.scu === null)!;
    expect(unknown.reward_per_scu).toBeNull();
    expect(unknown.flags).toContain("scu_unknown");
    expect(r.rows[r.rows.length - 1].scu).toBeNull();
  });

  it("Given the defaults, Then illegal contracts are left out and counted", () => {
    const r = rankHauling(d, QUERY);
    expect(r.rows.some((x) => x.illegal)).toBe(false);
    expect(r.excluded.illegal_or_unknown_legality).toBe(1);
    expect(rankHauling(d, { ...QUERY, includeIllegal: true }).rows.some((x) => x.illegal)).toBe(
      true,
    );
  });

  it("Given a rank, Then contracts above it or past their maximum are left out, other scales are not judged", () => {
    const rookie = rankHauling(d, { ...QUERY, rank: "Rookie" });
    const titles = rookie.rows.map((x) => x.id);
    expect(rookie.excluded.rank_too_low).toBe(2); // Junior family and the Master one
    expect(rookie.excluded.rank_above_the_contract_maximum).toBe(1); // Trainee-only
    expect(titles).not.toContain("b1");
    // The FactionReputation gate cannot be checked: kept, and said so.
    const e = rookie.rows.find((x) => x.id === "e1")!;
    expect(e.rank).toMatchObject({ required: "Neutral", scale: "other", check: "not_checked" });
    expect(e.flags).toContain("needs_intro: Seeking New Haulers");
    expect(rookie.rank_applied).toEqual({ name: "Rookie", index: 1 });
    expect(() => rankHauling(d, { ...QUERY, rank: "Admiral" })).toThrow(/Ranks: Trainee, Rookie/);
  });

  it("Given a system, Then only its contracts stay; an unknown system lists the known ones", () => {
    const pyro = rankHauling(d, { ...QUERY, system: "pyro" });
    expect(pyro.rows.map((x) => x.id)).toEqual(["b1"]);
    expect(() => rankHauling(d, { ...QUERY, system: "Terra" })).toThrow(RankQueryError);
  });

  it("Given a small ship, Then big containers are left out unless asked, and the fit says why", () => {
    const ship = { name: "Tiny", hold_scu: 46, max_container_size: 4 };
    const r = rankHauling(d, { ...QUERY, ship });
    expect(r.rows.some((x) => x.id === "b1")).toBe(false);
    expect(r.excluded.containers_too_big_for_the_ship).toBe(1);
    const all = rankHauling(d, { ...QUERY, ship, includeUnfit: true });
    const big = all.rows.find((x) => x.id === "b1")!;
    expect(big.fit.container).toBe("too_big");
    expect(big.flags).toContain("containers_too_big_for_the_ship");
    expect(big.fit.hold).toBe("several_trips");
  });

  it("Given no ship, Then every fit is unknown", () => {
    const row = rankHauling(d, QUERY).rows[0];
    expect(row.fit).toMatchObject({ container: "unknown", hold: "unknown", trips: null });
  });

  it("Given sort reward, Then the biggest reward is first; ties and nulls are deterministic", () => {
    const r = rankHauling(d, { ...QUERY, sort: "reward", rank: "Master" });
    expect(r.rows[0].id).toBe("b1");
    expect(rankHauling(d, { ...QUERY, sort: "reward" }).rows.map((x) => x.id)).toEqual(
      rankHauling(d, { ...QUERY, sort: "reward" }).rows.map((x) => x.id),
    );
  });

  it("Given a limit, Then only that many rows come back with the true count", () => {
    const r = rankHauling(d, { ...QUERY, limit: 2 });
    expect(r.rows).toHaveLength(2);
    expect(r.matching_families).toBe(5);
  });
});

describe("Feature: fit to the hold counts trips", () => {
  const ship = { name: null, hold_scu: 46, max_container_size: 16 };
  it("Given SCU at most the hold, Then one trip; around the hold, it depends; above, several", () => {
    expect(fitFor(ship, { min: 10, max: 46 }, 4)).toEqual({
      container: "fits",
      hold: "one_trip",
      trips: { min: 1, max: 1 },
    });
    expect(fitFor(ship, { min: 10, max: 100 }, 4).hold).toBe("depends_on_roll");
    expect(fitFor(ship, { min: 60, max: 100 }, 4)).toMatchObject({
      hold: "several_trips",
      trips: { min: 2, max: 3 },
    });
  });
  it("Given a missing ship fact, Then that part is unknown and the other is still answered", () => {
    expect(
      fitFor({ name: null, hold_scu: null, max_container_size: 8 }, { min: 1, max: 2 }, 4),
    ).toEqual({
      container: "fits",
      hold: "unknown",
      trips: null,
    });
    expect(fitFor(ship, null, null)).toEqual({
      container: "unknown",
      hold: "unknown",
      trips: null,
    });
  });
});
