import { describe, expect, it } from "vitest";
import { parseLog } from "./parser.js";
import {
  buildShipLosses,
  lossCuts,
  SHIP_RECORDS_MAX,
  ShipRecordBuffer,
  tidyShipRecords,
  type ShipLoss,
} from "./shipLoss.js";
import { entityRef, parseShipLine } from "./shipLossParse.js";
import { buildTradeJournal, pairCargoRuns } from "./trade.js";

/**
 * A ship destroyed with the player aboard, from invented log lines of both log eras (4.10 and the 2025 builds):
 * what counts as a loss, what must not, and what the records are allowed to hold. Every id, name and place below is made up.
 */

const BASE = Date.UTC(2026, 10, 3, 20, 0, 0);
const at = (s: number) => `<${new Date(BASE + s * 1000).toISOString()}>`;
const ME = "700000000001"; // the player's own id (invented)
const SHIP = "700000000555"; // the ship he flies (invented)
const OTHER_SHIP = "700000000777";
const NAME = "ZyxPilotName";
const GUID = "5c2e9a41-1111-4222-8333-444444444444";
const GUID2 = "5c2e9a41-2222-4222-8333-444444444444";
const OWNER = "[Team_CoreGameplayFeatures][Shops][UI]";
const ids = "playerId[1111111111] shopId[2222222]";

const character = (s = 0) =>
  `${at(s)} [Notice] <AccountLoginCharacterStatus_Character> Character: createdAt 1 - updatedAt 2 - geid ${ME} - accountId 5 - name ${NAME} - state STATE_CURRENT [Team_GameServices][Login]`;
const kiosk = (s: number, ship = SHIP) =>
  `${at(s)} [Notice] <CEntityComponentCommodityUIProvider::LoadSelectedShipBindings> Sending VehicleCargoDataRequest for vehicleEntityId[${ship}] ${OWNER}`;
const buy = (s: number, scu = 100, price = 947857, guid = GUID) =>
  `${at(s)} [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> Sending SShopCommodityBuyRequest - ${ids} shopName[SCShop_Cargo_Test] kioskId[3333333] price[${price}.000000] shopPricePerCentiSCU[1.889409] resourceGUID[${guid}] autoLoading[1] quantity[${scu * 100}.000000 cSCU] Cargo Box Data: boxSize[32.000000] | unitAmount[20] ${OWNER}`;
const sell = (s: number, scu = 100, amount = 1200000, guid = GUID) =>
  `${at(s)} [Notice] <CEntityComponentCommodityUIProvider::SendCommoditySellRequest> Sending SShopCommoditySellRequest - ${ids} shopName[SCShop_Cargo_Test] kioskId[3333333] amount[${amount}.000000] resourceGUID[${guid}] autoLoading[1] quantity[${scu}] transactionMode[CargoGrid] Cargo Box Data:  [boxSize[32] | unitAmount[20]] ${OWNER}`;
const error = (s: number, result = "TransactionCostMismatch", type = "Buying") =>
  `${at(s)} [Error] <CEntityComponentCommodityUIProvider::RmToken_CommodityTransactionResponse> Commodity Transaction Response Error - playerId[1111111111] result[${result}] type[${type}] [Team_NAPU][Shops]`;
const crash = (s: number, ship = SHIP, pilot = 1) =>
  `${at(s)} [Notice] <FatalCollision> Fatal Collision occured for vehicle MISC_Freelancer_${ship} [Part: Nose, Pos: x: 1.5, y: -2.5, z: 3.5, Zone: OOC_Stanton_3a_Lyria, PlayerPilot: ${pilot}] after hitting entity: SomeRock_${NAME}`;
const dead = (s: number, ship = SHIP, actor = ME) =>
  `${at(s)} [Notice] <[ActorState] Dead> [ACTOR STATE][CSCActorControlStateDead::PrePhysicsUpdate] Actor '${NAME}' [${actor}] ejected from zone 'MISC_Freelancer_${ship}' [${ship}] to zone 'OOC_Stanton_3a_Lyria' [800000000002] due to previous zone being in a destroyed vehicle with detached interior. [Team_ActorFeatures][Actor]`;
// 2025 builds
const death = (
  s: number,
  type: string,
  ship = SHIP,
  victim = ME,
  zone = `MISC_Freelancer_${SHIP}`,
) =>
  `${at(s)} [Notice] <Actor Death> CActor::Kill: '${NAME}' [${victim}] in zone '${ship === SHIP ? zone : `MISC_Freelancer_${ship}`}' killed by '${NAME}' [${victim}] using 'unknown' [Class unknown] with damage type '${type}' from direction x: 0.000000, y: 0.000000, z: 0.000000 [Team_ActorTech][Actor]`;
const destroyed = (
  s: number,
  cause: string,
  by: string,
  byId: string,
  ship = SHIP,
  cls = "MISC_Freelancer",
  level = 2,
) =>
  `${at(s)} [Notice] <Vehicle Destruction> CVehicle::OnAdvanceDestroyLevel: Vehicle '${cls}_${ship}' [${ship}] in zone 'OOC_Stanton_3a_Lyria' [pos x: 1.0, y: 2.0, z: 3.0 vel x: 0.0, y: 0.0, z: 0.0] driven by 'unknown' [0] advanced from destroy level ${level - 1} to ${level} caused by '${by}' [${byId}] with '${cause}' [Team_VehicleFeatures][Vehicle]`;
const claim = (s: number) =>
  `${at(s)} [Notice] <CWallet::ProcessClaimToNextStep> New Insurance Claim Request - entitlementURN: urn:sc:global:entitlement:uuid:${GUID}, requestId : 7 [Team_X][Y]`;

function lossesOf(lines: string[], withJournal = true): ShipLoss[] {
  const parsed = parseLog(lines.join("\n"));
  const journal = buildTradeJournal(parsed.commerce, "2026-11-04T12:00:00.000Z").transactions;
  return buildShipLosses(parsed.ships, withJournal ? journal : undefined);
}

describe("Feature: the player's ship destroyed with him aboard (build 4.10)", () => {
  it("Given a purchase bound to the ship then a crash, Then one loss with the cargo presumed lost, as SCU and aUEC paid", () => {
    const [loss, ...rest] = lossesOf([character(), kiosk(10), buy(25), crash(900), dead(900.3)]);
    expect(rest).toEqual([]);
    expect(loss).toMatchObject({
      at: new Date(BASE + 900_300).toISOString(),
      ship_class: "MISC_Freelancer",
      cause: "collision",
      causer: "unknown",
      zone: "OOC_Stanton_3a_Lyria",
      via: "actor_state_dead",
    });
    expect(loss!.ship_ref).toBe(entityRef(SHIP));
    expect(loss!.cargo).toEqual({
      scu: 100,
      paid_auec: 947857,
      buys: 1,
      unconfirmed_buys: 0,
      unconfirmed_sells: 0,
      last_buy_at: new Date(BASE + 25_000).toISOString(),
    });
  });

  it("Given a destroyed ship, Then the records hold no name, no raw id and no GUID", () => {
    const parsed = parseLog([character(), kiosk(10), buy(25), crash(900), dead(900.3)].join("\n"));
    const json = JSON.stringify([parsed.ships, buildShipLosses(parsed.ships, [])]);
    for (const secret of [NAME, ME, SHIP, "800000000002", GUID, "SomeRock"])
      expect(json).not.toContain(secret);
    // the player's own reference travels as a hash only
    expect(parsed.player_ref).toBe(entityRef(ME));
  });

  it("Given no fatal collision before the Dead line, Then the cause is unknown (never guessed as combat)", () => {
    const [loss] = lossesOf([character(), dead(900)]);
    expect(loss).toMatchObject({ cause: "unknown", causer: "unknown" });
    // a collision more than 1 s earlier does not explain it either
    const [late] = lossesOf([character(), crash(897.5), dead(900)]);
    expect(late!.cause).toBe("unknown");
    // and a collision of another ship does not
    const [other] = lossesOf([character(), crash(899.9, OTHER_SHIP), dead(900)]);
    expect(other!.cause).toBe("unknown");
  });

  it("Given a crash of a ship the player did not pilot (PlayerPilot 0), Then there is nothing", () => {
    expect(lossesOf([character(), crash(900, SHIP, 0)])).toEqual([]);
  });

  it("Given the Dead line of another actor, Then it is not the player's loss", () => {
    expect(lossesOf([character(), dead(900, SHIP, "700000000099")])).toEqual([]);
  });

  it("Given a log read in pieces, Then the player's hash carried over still tells his Dead line from another's", () => {
    const first = parseLog(character());
    const piece = parseLog([dead(900), dead(901, OTHER_SHIP, "700000000099")].join("\n"), {
      playerRef: first.player_ref,
    });
    expect(piece.ships).toHaveLength(1);
    expect(piece.ships[0]).toMatchObject({ kind: "dead", ship: entityRef(SHIP) });
  });

  it("Given the same lines read twice (a look-behind) and a fatal collision per hull part, Then it is one loss", () => {
    const lines = [character(), kiosk(10), buy(25), crash(900), crash(900.05), dead(900.3)];
    const parsed = parseLog([...lines, ...lines].join("\n"));
    expect(tidyShipRecords(parsed.ships).filter((r) => r.kind === "dead")).toHaveLength(1);
    expect(buildShipLosses(parsed.ships, [])).toHaveLength(1);
  });
});

describe("Feature: what the cargo presumed lost does and does not hold", () => {
  const run = (...lines: string[]) =>
    lossesOf([character(), ...lines, crash(900), dead(900.3)])[0]!;

  it("Given everything bought was sold before the destruction, Then no cargo is presumed lost", () => {
    expect(run(kiosk(10), buy(25), kiosk(300), sell(310)).cargo!.scu).toBe(0);
  });

  it("Given part of it was sold, Then only the rest is lost, at the price paid for it", () => {
    const cargo = run(kiosk(10), buy(25, 100, 100000), kiosk(300), sell(310, 40)).cargo!;
    expect(cargo.scu).toBe(60);
    expect(cargo.paid_auec).toBe(60000);
  });

  it("Given a purchase the game refused (an error line right after it), Then it is not counted", () => {
    const cargo = run(kiosk(10), buy(25), error(25.2)).cargo!;
    expect(cargo.scu).toBe(0);
    expect(cargo.buys).toBe(0);
  });

  it("Given an error that follows two purchases, Then neither is counted and both are reported as unconfirmed", () => {
    const cargo = run(kiosk(10), buy(25, 10, 1000), buy(26, 10, 1000), error(26.5)).cargo!;
    expect(cargo.scu).toBe(0);
    expect(cargo.unconfirmed_buys).toBe(2);
  });

  it("Given a sale the journal cannot confirm, Then it is counted apart (the cargo lost may be overestimated)", () => {
    const cargo = run(
      kiosk(10),
      buy(25, 100),
      sell(300, 40),
      sell(301, 40),
      error(301.5, "SomeError", "Selling"),
    ).cargo!;
    expect(cargo.unconfirmed_sells).toBe(2);
    expect(cargo.scu).toBe(100);
  });

  it("Given the cargo was bought for ANOTHER ship (the kiosk named it), Then the destroyed ship carries none", () => {
    expect(run(kiosk(10, OTHER_SHIP), buy(25)).cargo!.scu).toBe(0);
  });

  it("Given a purchase with no kiosk binding before it, Then it is not attributed to any ship", () => {
    expect(run(buy(25)).cargo!.scu).toBe(0);
    // a binding more than 30 minutes before the purchase is stale
    expect(run(kiosk(10), buy(10 + 31 * 60)).cargo!.scu).toBe(0);
  });

  it("Given a sale from another ship, Then it does not use up this ship's cargo", () => {
    const cargo = run(kiosk(10), buy(25), kiosk(300, OTHER_SHIP), sell(310)).cargo!;
    expect(cargo.scu).toBe(100);
  });

  it("Given two goods, Then a sale of one does not remove the other", () => {
    const cargo = run(
      kiosk(10),
      buy(25, 100),
      buy(40, 50, 5000, GUID2),
      kiosk(300),
      sell(310),
    ).cargo!;
    expect(cargo.scu).toBe(50);
    expect(cargo.paid_auec).toBe(5000);
  });

  it("Given a purchase a long time before (over 3 hours), Then it is not presumed aboard any more", () => {
    const lines = [
      character(),
      kiosk(10),
      buy(25),
      crash(25 + 4 * 3600),
      dead(25 + 4 * 3600 + 0.3),
    ];
    expect(lossesOf(lines)[0]!.cargo!.scu).toBe(0);
  });

  it("Given no trade journal, Then the cargo is unknown (null), not zero", () => {
    expect(lossesOf([character(), dead(900)], false)[0]!.cargo).toBeNull();
  });
});

describe("Feature: what must not be counted as a loss", () => {
  it("Given a player who respawns by suicide (on foot or in a ship), Then nothing", () => {
    expect(
      lossesOf([
        character(),
        kiosk(10),
        buy(25),
        sell(300),
        death(320, "Suicide", "700000000900", ME, "station_hangar_zone"),
        death(900, "Suicide"),
        claim(910),
      ]),
    ).toEqual([]);
  });

  it("Given a routine insurance claim and nothing else, Then nothing", () => {
    expect(lossesOf([character(), claim(10), claim(11)])).toEqual([]);
  });

  it("Given AI vehicles the player destroyed, Then nothing (their ids are not his ship)", () => {
    expect(
      lossesOf([
        character(),
        destroyed(100, "Combat", NAME, ME, "700000000801", "ANVL_PU_AI_Hornet"),
        destroyed(101, "Combat", NAME, ME, "700000000802", "TEST_Unmanned_Drone"),
        destroyed(102, "Combat", NAME, ME, "700000000803", "ANVL_Hornet"),
      ]),
    ).toEqual([]);
  });

  it("Given another player's death in range, Then nothing", () => {
    expect(lossesOf([character(), death(100, "Crash", SHIP, "700000000099")])).toEqual([]);
  });

  it("Given the player's death on foot of another cause, Then nothing", () => {
    expect(
      lossesOf([character(), death(100, "BleedOut"), death(101, "Crash", "x", ME, "some_station")]),
    ).toEqual([]);
  });

  it("Given a ship destroyed with nobody known aboard (a Vehicle Destruction line alone), Then nothing", () => {
    expect(
      lossesOf([character(), destroyed(100, "Combat", "SomeoneElse", "700000000444")]),
    ).toEqual([]);
  });
});

describe("Feature: the 2025 log era", () => {
  it("Given the player's death in his ship and the Vehicle Destruction line of the same ship, Then the cause and the kind of causer come from the latter", () => {
    const [loss] = lossesOf([
      character(),
      kiosk(10),
      buy(25),
      destroyed(899, "Combat", "SomeoneElse", "700000000444", SHIP, "MISC_Freelancer", 2),
      death(900, "Collision"),
    ]);
    expect(loss).toMatchObject({
      via: "actor_death",
      cause: "combat",
      causer: "other",
      ship_class: "MISC_Freelancer",
    });
    expect(loss!.cargo!.scu).toBe(100);
    // the killer's name is read to be classified, never kept
    expect(JSON.stringify(loss)).not.toContain("SomeoneElse");
  });

  it("Given a Vehicle Destruction line that comes just after the death, Then it still explains it", () => {
    const [loss] = lossesOf([
      character(),
      death(900, "Crash"),
      destroyed(901, "Collision", NAME, ME),
    ]);
    expect(loss).toMatchObject({ cause: "collision", causer: "self" });
  });

  it("Given an AI-shaped causer, Then the kind is npc; given 'unknown', unknown", () => {
    const npc = lossesOf([
      character(),
      destroyed(899, "Combat", "PU_Pilots-Human-Criminal-Pilot_Light_123456789", "700000000555"),
      death(900, "VehicleDestruction"),
    ])[0]!;
    expect(npc.causer).toBe("npc");
    const unknown = lossesOf([
      character(),
      destroyed(899, "Combat", "unknown", "0"),
      death(900, "VehicleDestruction"),
    ])[0]!;
    expect(unknown.causer).toBe("unknown");
  });

  it("Given the death alone (a 'Collision' type with no other line), Then the cause is unknown: the type alone is not trusted", () => {
    expect(lossesOf([character(), death(900, "Collision")])[0]!.cause).toBe("unknown");
  });

  it("Given a death without the player's login line in the text, Then it cannot be told from another actor's and is ignored", () => {
    expect(lossesOf([death(900, "Crash")])).toEqual([]);
  });
});

describe("Feature: the parser stays cheap and safe", () => {
  it("Given unrelated and hostile lines, Then no record and no exception", () => {
    const hostile = [
      `${at(1)} [Notice] <[ActorState] Dead> Actor '${"x".repeat(5000)}`,
      `${at(2)} <FatalCollision> Fatal Collision occured for vehicle`,
      `${at(3)} [Notice] <Actor Death> CActor::Kill: ' [`,
      `${at(4)} [Notice] <Vehicle Destruction> CVehicle::OnAdvanceDestroyLevel: Vehicle '' [ advanced from destroy level`,
      "no timestamp <FatalCollision> Fatal Collision occured for vehicle A_1234567 [Zone: z, PlayerPilot: 1]",
    ];
    // through the real parser, with the player known (so the identity check is not what stops them)
    const known = parseLog(character());
    for (const line of hostile) {
      const parsed = parseLog(line, { playerRef: known.player_ref });
      expect(parsed.ships, line.slice(0, 60)).toEqual([]);
    }
    // and a line with no timestamp is not a record whatever it holds
    expect(
      parseShipLine(
        " Fatal Collision occured for vehicle A_1234567 [Zone: z, PlayerPilot: 1]",
        null,
        {
          playerRef: null,
        },
      ),
    ).toBeNull();
  });

  it("Given a Dead line while the player's login line is not in the text (a long log read from its end), Then it is refused", () => {
    expect(parseLog(dead(900)).ships).toEqual([]);
    expect(lossesOf([crash(899.9), dead(900)])).toEqual([]);
  });

  it("Given long lines, Then they are not read, and a worst-case line stays fast (no regex blow-up)", () => {
    const apostrophes = (n: number) => " '".repeat(n);
    const bad = [
      `${at(1)} [Notice] <[ActorState] Dead> Actor${apostrophes(2000)} [1] ejected from zone`,
      `${at(2)} [Notice] <[ActorState] Dead> ${"Actor 'x' [1] ejected from zone 'z' [1] ".repeat(60)}`,
      `${at(3)} [Notice] <Actor Death> CActor::Kill: ${"' [1] in zone 'a' killed by ".repeat(120)}`,
      `${at(4)} [Notice] <Vehicle Destruction> CVehicle::OnAdvanceDestroyLevel: Vehicle 'a' [1] in zone 'b' ${" advanced from destroy level 1 to 2 caused by".repeat(120)}`,
    ];
    const known = parseLog(character());
    const started = Date.now();
    for (const line of bad) parseLog(line, { playerRef: known.player_ref });
    expect(Date.now() - started).toBeLessThan(500);
    // 20 000 characters of one line: refused before any pattern runs
    const huge = `${at(5)} [Notice] <[ActorState] Dead> Actor '${"x".repeat(20_000)}' [${ME}] ejected from zone 'MISC_Freelancer_${SHIP}' [${SHIP}] due to previous zone being in a destroyed vehicle`;
    const t0 = Date.now();
    expect(parseLog(huge, { playerRef: known.player_ref }).ships).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("Given a place token of an unknown form (spaces, dots, a GUID, braces), Then the zone is dropped", () => {
    for (const odd of ["a b", "x.y", GUID, "{zone}", "-lead", "a--".padEnd(70, "b")]) {
      const line = dead(900).replace("OOC_Stanton_3a_Lyria", odd);
      expect(parseLog([character(), line].join("\n")).ships[0], odd).toMatchObject({ zone: null });
    }
  });

  it("Given many kiosk records, Then they do not push a destruction out of the records kept", () => {
    const kiosks = Array.from({ length: 2000 }, (_, i) => kiosk(i / 10));
    const parsed = parseLog([character(), ...kiosks, dead(900)].join("\n"));
    expect(tidyShipRecords(parsed.ships).filter((r) => r.kind === "dead")).toHaveLength(1);
    expect(
      tidyShipRecords(parsed.ships).filter((r) => r.kind === "kiosk_ship").length,
    ).toBeLessThanOrEqual(SHIP_RECORDS_MAX.kiosk_ship);
  });

  it("Given a place token that holds a long number or odd characters, Then the zone is dropped", () => {
    const line = dead(900).replace("OOC_Stanton_3a_Lyria", "OOC_123456789_x");
    expect(parseLog([character(), line].join("\n")).ships[0]).toMatchObject({ zone: null });
  });

  it("Given a large log, Then parsing stays fast", () => {
    const filler = Array.from(
      { length: 60_000 },
      (_, i) => `${at(i / 100)} [Notice] <Something> filler line ${i}`,
    );
    const started = Date.now();
    parseLog([character(), ...filler, dead(900)].join("\n"));
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("Feature: only known forms of place and model are kept", () => {
  const one = (line: string) =>
    parseLog([character(), line].join("\n")).ships[0] as unknown as Record<string, unknown>;

  it("Given a place named after a player or a home, Then it is dropped", () => {
    for (const odd of [
      `Hangar_${NAME}`,
      `Apartment_${NAME}_Home`,
      `${NAME}_Residence`,
      "Hangar_Generic_01",
      `Orison_Hangar_${NAME}`,
      `lorville_Apartment_${NAME}_Home`,
      `OOC_Stanton_Habitat_${NAME}`,
      `stanton_a_b_c_d_e_f_g_h`,
      `OOC_${"x".repeat(21)}`,
    ]) {
      expect(one(dead(900).replace("OOC_Stanton_3a_Lyria", odd)), odd).toMatchObject({
        zone: null,
      });
    }
  });

  it("Given the families of place names seen in the logs, Then they are kept", () => {
    for (const ok of [
      "OOC_Stanton_3a_Lyria",
      "levski_all-001",
      "keeger_segment_mission_genrl_001_015",
      "rs_comm_arc-l001",
      "jumppoint_pyro_stanton",
      "pyro3",
      "P2_L4",
    ]) {
      expect(one(dead(900).replace("OOC_Stanton_3a_Lyria", ok)), ok).toMatchObject({ zone: ok });
    }
  });

  it("Given a ship class that starts with a player's name or any other word, Then the model is unknown", () => {
    const line = dead(900).replace(/MISC_Freelancer_/g, `${NAME}_`);
    expect(one(line)).toMatchObject({ kind: "dead", cls: null });
    expect(one(dead(900).replace(/MISC_Freelancer_/g, "DRAK_Dragonfly_Yellow_"))).toMatchObject({
      cls: "DRAK_Dragonfly_Yellow",
    });
    expect(one(dead(900))).toMatchObject({ cls: "MISC_Freelancer" });
  });
});

describe("Feature: the records are bounded while the log is parsed", () => {
  it("Given 50 000 kiosk lines of alternating ships, Then the buffer never holds more than twice the bound", () => {
    const buffer = new ShipRecordBuffer();
    let most = 0;
    for (let i = 0; i < 50_000; i++) {
      buffer.add({
        kind: "kiosk_ship",
        time: new Date(BASE + i * 1000).toISOString(),
        ship: i % 2 ? "aaaaaaaaaaaa" : "bbbbbbbbbbbb",
      });
      most = Math.max(most, buffer.records.length);
    }
    expect(most).toBeLessThanOrEqual(SHIP_RECORDS_MAX.kiosk_ship * 2);
    // the newest are the ones kept
    expect(buffer.records[buffer.records.length - 1]!.time).toBe(
      new Date(BASE + 49_999 * 1000).toISOString(),
    );
  });

  it("Given the same ship named again within 5 minutes, Then the kiosk line adds nothing; a destruction is never dropped by kiosk lines", () => {
    const buffer = new ShipRecordBuffer();
    for (let i = 0; i < 100; i++)
      buffer.add({
        kind: "kiosk_ship",
        time: new Date(BASE + i * 1000).toISOString(),
        ship: "aaaaaaaaaaaa",
      });
    expect(buffer.records).toHaveLength(1);
    buffer.add({
      kind: "dead",
      time: new Date(BASE + 200_000).toISOString(),
      ship: "aaaaaaaaaaaa",
      cls: null,
      zone: null,
    });
    for (let i = 0; i < 5000; i++)
      buffer.add({
        kind: "kiosk_ship",
        time: new Date(BASE + 300_000 + i * 1000).toISOString(),
        ship: i % 2 ? "aaaaaaaaaaaa" : "bbbbbbbbbbbb",
      });
    expect(buffer.records.filter((r) => r.kind === "dead")).toHaveLength(1);
  });
});

describe("Feature: the repeats of one crash do not push an earlier loss's collision out", () => {
  it("Given a loss, then 400 hull-part lines of another crash within a second, Then the first loss keeps its cause", () => {
    const repeats = Array.from({ length: 400 }, (_, i) => crash(2000 + i / 500, OTHER_SHIP));
    const parsed = parseLog([character(), crash(900), dead(900.3), ...repeats].join("\n"));
    expect(parsed.ships.filter((r) => r.kind === "collision")).toHaveLength(2); // one per ship and second
    const [first] = buildShipLosses(tidyShipRecords(parsed.ships), []);
    expect(first).toMatchObject({ cause: "collision" });
  });

  it("Given 300 separate crashes of 300 ships, Then the bound still applies (the newest are kept)", () => {
    const buffer = new ShipRecordBuffer();
    for (let i = 0; i < 300; i++)
      buffer.add({
        kind: "collision",
        time: new Date(BASE + i * 5000).toISOString(),
        ship: i.toString(16).padStart(12, "0"),
        cls: null,
        zone: null,
      });
    expect(buffer.records.length).toBeLessThanOrEqual(SHIP_RECORDS_MAX.collision * 2);
  });
});

describe("Feature: the ship reference is pure JavaScript", () => {
  it("Given an id, Then the reference is 12 hex characters, stable, and different for another id", () => {
    expect(entityRef("700000000555")).toMatch(/^[0-9a-f]{12}$/);
    expect(entityRef("700000000555")).toBe(entityRef("700000000555"));
    expect(entityRef("700000000555")).not.toBe(entityRef("700000000556"));
  });
});

describe("Feature: a loss with cargo ends the run", () => {
  it("Given a loss, then a new purchase and sale of the same goods, Then the sale is not paired with the lost cargo", () => {
    const lines = [
      character(),
      kiosk(10),
      buy(25, 100, 100000),
      crash(900),
      dead(900.3),
      kiosk(1200, OTHER_SHIP),
      buy(1210, 50, 80000),
      kiosk(1800, OTHER_SHIP),
      sell(1810, 50, 120000),
    ];
    const parsed = parseLog(lines.join("\n"));
    const journal = buildTradeJournal(parsed.commerce, "2026-11-04T12:00:00.000Z");
    const cuts = lossCuts(buildShipLosses(parsed.ships, journal.transactions));
    expect(cuts).toHaveLength(1);
    const uncut = pairCargoRuns(journal.transactions);
    expect(uncut).toHaveLength(1); // without the cut the sale eats the lost lot
    expect(uncut[0]!.cost_auec).toBe(50000);
    const runs = pairCargoRuns(journal.transactions, cuts);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ state: "open", unsold_scu: 100 });
    expect(runs[1]).toMatchObject({ state: "closed", cost_auec: 80000, revenue_auec: 120000 });
  });
});
