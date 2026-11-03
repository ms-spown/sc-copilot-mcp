import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveContext, summarizeSession } from "./context.js";
import { parseLog } from "./parser.js";
import { GameLog } from "./reader.js";

/**
 * Behaviour of the game-log features, told as scenarios.
 * The log text is invented, in the shapes seen in real logs; PILOT must never come back out.
 */
const PILOT = "FakePilotQrs";
const t = (s: string) => `<2026-11-02T20:${s}Z>`;
const M1 = "aaaaaaaa-1111-2222-3333-444444444444"; // a contract that gets completed
const M2 = "bbbbbbbb-1111-2222-3333-444444444444"; // a contract still running
const M3 = "cccccccc-1111-2222-3333-444444444444"; // a contract that gets abandoned

const added = (clock: string, text: string, mission: string) =>
  `${t(clock)} [Notice] <SHUDEvent_OnNotification> Added notification "${text}" [9] to queue. New queue size: 1, MissionId: [${mission}], ObjectiveId: [] [Team_X]`;
const quoted = (clock: string, text: string) => `${t(clock)}    "${text}" [9]`;

const HEADER = [
  `${t("00:00.000")} Log started on Mon Nov  2 21:00:00 2026`,
  `${t("00:00.001")} FileVersion: 9.9.1.2222`,
  `${t("00:00.002")} [Trace] Environment:   PUB`,
  `${t("00:00.003")} [Trace] @env_session:  'pub-sc-alpha-991-12345678'`,
  `${t("00:00.004")} [Trace] @host_session: '${PILOT}_PC'`,
];

const PLAY = [
  quoted("01:00.000", "Entered Test Alliance Jurisdiction: "),
  quoted("01:05.000", "Entering Armistice Zone - Combat Prohibited: "),
  quoted("01:06.000", "You have joined channel 'Test Ship Alpha : " + PILOT + "'."),
  // contract 1: accepted, objective, blueprint, completed
  quoted("02:00.000", "Contract Accepted:  First Job | Easy: "),
  added("02:00.001", "Contract Accepted:  First Job | Easy: ", M1),
  quoted("02:01.000", "New Objective: Go to the Depot: "),
  added("02:01.001", "New Objective: Go to the Depot: ", M1),
  `${t("02:02.000")} [Notice] <CreateHaulingObjectiveHandler> Pick created - [Cient] sourcename: HaulCargo_Test_Waste_Stanton, missionId: ${M1}, locationName: Unknown [Outpost_Test_One], locationHash: 1`,
  `${t("02:02.001")} [Notice] <CreateHaulingObjectiveHandler> Pick created - [Cient] sourcename: HaulCargo_Test_Waste_Stanton, missionId: ${M1}, locationName: Unknown [Outpost_Test_One], locationHash: 1`,
  `${t("02:02.002")} [Notice] <CreateHaulingObjectiveHandler> Dropoff created - [Cient] sourcename: HaulCargo_Test_Waste_Stanton, missionId: ${M1}, locationName: Unknown [Station_Test_Two], locationHash: 2`,
  quoted("03:00.000", "Received Blueprint: Test Rifle: "),
  added("03:00.001", "Received Blueprint: Test Rifle: ", M1),
  quoted("03:30.000", "Contract Complete: First Job | Easy: "),
  added("03:30.001", "Contract Complete: First Job | Easy: ", M1),
  `${t("03:30.500")} [Notice] <MissionEnded> Received MissionEnded push message for: mission_id ${M1} - mission_ MISSION_STATE_COMPLETED [Team_X]`,
  // contract 2: accepted, still running
  quoted("04:00.000", "Contract Accepted:  Second Job | Hard: "),
  added("04:00.001", "Contract Accepted:  Second Job | Hard: ", M2),
  quoted("04:01.000", "New Objective: Neutralize Target: "),
  added("04:01.001", "New Objective: Neutralize Target: ", M2),
  // contract 3: accepted then abandoned
  quoted("05:00.000", "Contract Accepted:  Third Job: "),
  added("05:00.001", "Contract Accepted:  Third Job: ", M3),
  `${t("05:10.000")} [Notice] <MissionEnded> Received MissionEnded push message for: mission_id ${M3} - mission_ MISSION_STATE_ABANDONED [Team_X]`,
  // leaving, jump point, shop
  quoted("06:00.000", "Leaving Armistice Zone - Caution Advised: "),
  quoted("06:10.000", "Entered Monitored Space: "),
  `${t("07:00.000")} [Notice] <Jump Drive State Changed> Now Tuning | CL1 | AUTH | Stanton | JDRV_X [1] (adam: SHIP_X in zone Z_1) | CSCItemJumpDrive::OnStateChanged [Team_VehicleFeatures][JumpSystem]`,
  `${t("07:01.000")} [Notice] <Jump Drive State Changed> Now Entering | CL1 | AUTH | Stanton | JDRV_X [1] (adam: SHIP_X in zone Z_1) | CSCItemJumpDrive::OnStateChanged [Team_VehicleFeatures][JumpSystem]`,
  `${t("07:02.000")} [Notice] <Jump Drive State Changed> Now Exiting | CL1 | AUTH | Pyro | JDRV_X [1] (adam: SHIP_X in zone Z_2) | CSCItemJumpDrive::OnStateChanged [Team_VehicleFeatures][JumpSystem]`,
  quoted("07:30.000", "Entered Another Jurisdiction: "),
  `${t("08:00.000")} [Notice] <CEntityComponentShopUIProvider::SendShopBuyRequest> Sending SShopBuyRequest - playerId[1] shopId[2] shopName[SCShop_Test] kioskId[3] client_price[100.000000] itemClassGUID[g] itemName[test_item] quantity[2] [Team_X]`,
  quoted("08:10.000", "Joined hangar queue."),
  quoted("08:20.000", "Hangar Request Completed: "),
  quoted("09:00.000", "You have left the channel 'Test Ship Alpha : " + PILOT + "'."),
];

const log = (...parts: string[][]) => parts.flat().join("\n") + "\n";

describe("Feature: the parser understands a session of play", () => {
  describe("Scenario: a contract is accepted, worked and completed", () => {
    const parsed = parseLog(log(HEADER, PLAY));

    it("Given the contract's notification carries a mission id, When it is parsed, Then every step of the contract shares that id", () => {
      const ofMission = parsed.events.filter((e) => e.mission_id === "aaaaaaaa");
      expect(ofMission.map((e) => e.type)).toEqual([
        "mission_accepted",
        "objective_new",
        "hauling_objective",
        "hauling_objective",
        "blueprint_received",
        "mission_completed",
        "mission_ended",
      ]);
    });

    it("Then the blueprint reward is named, and the hauling objectives are listed once each", () => {
      expect(parsed.events.find((e) => e.type === "blueprint_received")).toMatchObject({
        blueprint: "Test Rifle",
      });
      const hauling = parsed.events.filter((e) => e.type === "hauling_objective");
      expect(hauling).toHaveLength(2); // the repeated pickup line counts once
      expect(hauling.map((h) => `${h.kind}:${h.location}`)).toEqual([
        "pickup:Outpost_Test_One",
        "dropoff:Station_Test_Two",
      ]);
    });
  });

  describe("Scenario: the player boards a ship and leaves", () => {
    it("Given the ship's comms channel names the pilot, When parsed, Then only the ship is kept", () => {
      const parsed = parseLog(log(HEADER, PLAY));
      expect(
        parsed.events
          .filter((e) => e.type === "ship_channel_joined" || e.type === "ship_channel_left")
          .map((e) => `${e.type}:${e.ship}`),
      ).toEqual(["ship_channel_joined:Test Ship Alpha", "ship_channel_left:Test Ship Alpha"]);
      expect(JSON.stringify(parsed)).not.toContain(PILOT);
    });
  });

  describe("Scenario: the player jumps to another system", () => {
    it("Then entering, transiting and exiting are reported with the system, and tuning is not", () => {
      const jumps = parseLog(log(HEADER, PLAY)).events.filter(
        (e) => e.type === "jump_point_transit",
      );
      expect(jumps.map((j) => `${j.phase}:${j.system}`)).toEqual([
        "entering:Stanton",
        "exiting:Pyro",
      ]);
    });
  });

  describe("Scenario: nothing in the notification links it to a mission", () => {
    it("Then the event is still reported, just without an id", () => {
      const parsed = parseLog(
        log(HEADER, [quoted("02:00.000", "Contract Accepted:  Lonely Job: ")]),
      );
      expect(parsed.events[0]).toMatchObject({ type: "mission_accepted", title: "Lonely Job" });
      expect(parsed.events[0]).not.toHaveProperty("mission_id");
    });
  });
});

describe("Feature: 'what am I doing now?' from the session so far", () => {
  const ctx = deriveContext(parseLog(log(HEADER, PLAY)));

  it("Given two contracts were finished, Then they are listed with how they ended", () => {
    expect(ctx.contracts.finished.map((c) => `${c.title}:${c.outcome}`)).toEqual([
      "First Job | Easy:completed",
      "Third Job:abandoned",
    ]);
  });

  it("Given a contract was accepted and never ended, Then it is active, with its latest objective", () => {
    expect(ctx.contracts.active).toHaveLength(1);
    expect(ctx.contracts.active[0]).toMatchObject({
      title: "Second Job | Hard",
      objective: "Neutralize Target",
      mission_id: "bbbbbbbb",
    });
  });

  it("Given the player entered then left an armistice zone, Then they are not in one; monitored space they are", () => {
    expect(ctx.zones).toMatchObject({
      armistice: false,
      monitored_space: true,
      private_property: null,
    });
  });

  it("Then the latest jurisdiction and the last jump are reported, each with when it was seen", () => {
    expect(ctx.jurisdiction).toMatchObject({ name: "Another" });
    expect(ctx.last_jump_point_transit).toMatchObject({ phase: "exiting", system: "Pyro" });
    expect(ctx.jurisdiction?.since).toMatch(/^2026-11-02T20:07:30/);
  });

  it("Given the player left the ship's channel, Then no ship is reported aboard", () => {
    expect(ctx.ship_aboard).toBeNull();
    const aboard = deriveContext(parseLog(log(HEADER, PLAY.slice(0, 4))));
    expect(aboard.ship_aboard).toMatchObject({ ship: "Test Ship Alpha" });
  });

  it("Then purchases, blueprints and hangar requests are counted", () => {
    expect(ctx.purchases).toMatchObject({
      count: 1,
      last: { shop: "SCShop_Test", item: "test_item", quantity: 2, price: 100 },
    });
    expect(ctx.blueprints_received).toHaveLength(1);
    expect(ctx.hangar_requests).toBe(1);
  });

  it("Given an unfinished session, Then it says its fields are the last time something was logged", () => {
    expect(ctx.caveats[0]).toMatch(/last time the game logged it/);
  });

  it("Given an empty log, Then the context is empty rather than invented", () => {
    const empty = deriveContext(parseLog(""));
    expect(empty).toMatchObject({ jurisdiction: null, ship_aboard: null, as_of: null });
    expect(empty.contracts.active).toEqual([]);
  });
});

describe("Feature: the game announces some things twice", () => {
  it("Given the same contract is announced twice, once without its id, Then it is one contract and keeps the id", () => {
    const twice = [
      quoted("02:00.000", "Contract Accepted:  Echo Job: "),
      added("02:00.001", "Contract Accepted:  Echo Job: ", M1),
      quoted("02:05.000", "Contract Accepted:  Echo Job: "),
    ];
    const parsed = parseLog(log(HEADER, twice));
    expect(parsed.events.filter((e) => e.type === "mission_accepted")).toHaveLength(2); // raw events are kept
    const ctx = deriveContext(parsed);
    expect(ctx.contracts.active).toHaveLength(1);
    expect(ctx.contracts.active[0]).toMatchObject({ title: "Echo Job", mission_id: "aaaaaaaa" });
    expect(summarizeSession(parsed).contracts_accepted).toBe(1);
  });

  it("Given two different contracts with the same title far apart, Then both count", () => {
    const apart = [
      quoted("02:00.000", "Contract Accepted:  Repeatable: "),
      quoted("09:00.000", "Contract Accepted:  Repeatable: "),
    ];
    expect(summarizeSession(parseLog(log(HEADER, apart))).contracts_accepted).toBe(2);
  });
});

describe("Feature: a table of past sessions", () => {
  it("Given a finished session, Then its duration, counts and places are summarised", () => {
    const quit = `${t("10:00.000")} [Notice] <SystemQuit> CSystem::Quit invoked with - cause=1, closed the application, exitCode=0, thread id=1`;
    const s = summarizeSession(parseLog(log(HEADER, PLAY, [quit])));
    expect(s).toMatchObject({
      game_version: "9.9.1.2222",
      build: "12345678",
      channel: "live",
      duration_minutes: 10,
      clean_exit: true,
      contracts_accepted: 3,
      contracts_completed: 1,
      purchases: 1,
      blueprints_received: 1,
      jump_point_transits: 1,
      jurisdictions_visited: ["Test Alliance", "Another"],
    });
  });
});

describe("Feature: the reader lists sessions from the install folder", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "scmcp-sessions-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("Given a current log and two backups, When sessions are listed, Then they come newest first, capped by the limit", async () => {
    const write = (rel: string, text: string, mtime: number) => {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      fs.utimesSync(file, new Date(mtime), new Date(mtime));
    };
    const now = Date.now();
    write("Game.log", log(HEADER, PLAY), now);
    write(
      "logbackups/Game Build(1) a.log",
      log(
        HEADER.map((l) => l.replace("12345678", "10000001")),
        PLAY.slice(0, 4),
      ),
      now - 1000,
    );
    write(
      "logbackups/Game Build(2) b.log",
      log(HEADER.map((l) => l.replace("12345678", "10000002"))),
      now - 2000,
    );
    write("logbackups/notes.txt", "not a log", now);

    const all = await new GameLog({ installDir: dir }).sessions(10);
    expect(all.map((s) => s.parsed.session.build)).toEqual(["12345678", "10000001", "10000002"]);
    expect((await new GameLog({ installDir: dir }).sessions(2)).length).toBe(2);
  });
});
