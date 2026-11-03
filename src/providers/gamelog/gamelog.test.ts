import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCache, configureDiskCache } from "../../core/cache.js";
import type { HttpClient } from "../../core/http.js";
import { allTools, createRegistry } from "../../tools/registry.js";
import { Scmdb } from "../scmdb/store.js";
import { decodeLog, parseLog } from "./parser.js";
import { GameLog, GameLogError, shortPath } from "./reader.js";
import { FleetStore } from "../fleet/store.js";

/**
 * A hand-made log in the shapes seen in real logs. Every name, id and path is invented; the
 * pilot name and account id are here ONLY so the tests can prove they never come back out.
 */
const PILOT = "FakePilotXyz";
const ACCOUNT = "9876543";
const t = (s: string) => `<2026-11-02T20:${s}Z>`;

const HEADER = [
  `${t("06:10.100")} BackupNameAttachment=" Build(111) 02 Nov 26 (22 06 10)"  -- used by backup system`,
  `${t("06:15.200")} Log started on Mon Nov  2 21:06:15 2026`,
  `${t("06:15.201")} Built on Oct 12 2026 10:40:48`,
  `${t("06:15.202")} FileVersion: 9.9.1.2222`,
  `${t("06:15.300")} [Trace] Environment:   PUB`,
  `${t("06:15.301")} [Trace] @env_session:  'pub-sc-alpha-991-12345678'`,
  `${t("06:15.302")} [Trace] @host_session: '${PILOT}_PC'`,
  `${t("06:16.000")} Executable: C:\\Users\\fakeuser\\Games\\StarCitizen\\LIVE\\Bin64\\StarCitizen.exe`,
];

const BODY = [
  `${t("07:00.000")} [Notice] <LoginCompleted> LoginCompleted message [Team_GameServices][Login]`,
  `${t("07:00.010")} [Notice] <AccountLoginCharacterStatus_Character> Character: createdAt 1 - updatedAt 2 - geid 3 - accountId ${ACCOUNT} - name ${PILOT} - state STATE_CURRENT [Team_GameServices][Login]`,
  `${t("07:00.020")} [Notice] <Channel Created> map="x" nickname="${PILOT}" playerGEID=3`,
  `${t("07:05.000")} [CSessionManager::OnClientSpawned] Spawned!`,
  `${t("08:00.000")}    "Entered Test Alliance Jurisdiction: " [7]`,
  `${t("08:00.001")} [Notice] <SHUDEvent_OnNotification> Added notification "Entered Test Alliance Jurisdiction: " [7] to queue. New queue size: 1, MissionId: [], ObjectiveId: [] [Team_X]`,
  `${t("08:00.002")} [Notice] <UpdateNotificationItem> Notification "Entered Test Alliance Jurisdiction: " [7], Action: Next [Team_X]`,
  `${t("08:10.000")}    "Entered Ungoverned Jurisdiction: " [1]`,
  `${t("08:11.000")}    "Entering Armistice Zone - Combat Prohibited: " [1]`,
  `${t("08:12.000")}    "Leaving Armistice Zone - Caution Advised: " [10]`,
  `${t("08:13.000")}    "Entered Monitored Space: " [0]`,
  `${t("08:14.000")}    "Restricted Area - Vehicles Will Be Impounded: " [136]`,
  `${t("09:00.000")}    "Contract Accepted:  Test Bounty: Some Target | Low-Risk: " [34]`,
  `${t("09:01.000")}    "New Objective: Go to Asteroid Base: " [38]`,
  `${t("09:02.000")}    "Objective Complete: Go to Somewhere`,
  `${t("09:03.000")}    "Contract Complete: Test Bounty: Some Target | Low-Risk: " [181]`,
  `${t("09:03.500")} [Notice] <MissionEnded> Received MissionEnded push message for: mission_id 11111111-2222-3333-4444-555555555555 - mission_ MISSION_STATE_COMPLETED [Team_GameServices][Missions]`,
  `${t("09:30.000")} [Notice] <CEntityComponentShopUIProvider::SendShopBuyRequest> Sending SShopBuyRequest - playerId[${ACCOUNT}] shopId[2] shopName[SCShop_Test_Area] kioskId[3] client_price[16761.000000] itemClassGUID[g] itemName[test_armor_01] quantity[1] [Team_X]`,
  `${t("09:30.100")} [Notice] <CEntityComponentShopUIProvider::RmShopFlowResponse> Received ShopFlowResponse - playerId[${ACCOUNT}] shopId[2] shopName[SCShop_Test_Area] kioskId[3] kioskState[BuyRequestProcessing] result[Success] type[Buying] [Team_X]`,
  `${t("09:40.000")} [Notice] <CWallet::ProcessClaimToNextStep> New Insurance Claim Request - entitlementURN: urn:sc:x, Id : 1 [Team_GameServices][Transaction]`,
  `${t("09:41.000")}    "Hangar Request Completed: " [6]`,
  // noise the parser must ignore, and count
  `${t("09:50.000")} [Error] <CPU Particle Limit reached> something happened`,
  `${t("09:50.001")} [Warning] <Time Debt Too Large (Positive)> 12.5`,
  `${t("09:50.002")}    "Quantum Drive - Spooling: Ships must fully spool up." [8]`,
  `${t("09:50.003")} [Notice] <Connection Flow> update bubble for ${PILOT} [${ACCOUNT}]`,
];
const QUIT = `${t("10:00.000")} [Notice] <SystemQuit> CSystem::Quit invoked with - cause=30016, ${PILOT} closed the application, exitCode=0, thread id=1`;

const LOG = [...HEADER, ...BODY, QUIT].join("\r\n") + "\r\n";

describe("parseLog", () => {
  const parsed = parseLog(LOG);

  it("reads the session from the header, and maps PUB to live without guessing others", () => {
    expect(parsed.session).toMatchObject({
      game_version: "9.9.1.2222",
      environment: "PUB",
      build: "12345678",
      channel: "live",
      started_local: "Mon Nov  2 21:06:15 2026",
      clean_exit: true,
    });
    expect(parseLog(LOG.replace("PUB", "PTU")).session.channel).toBe("ptu");
    expect(parseLog(LOG.replace("PUB", "HOTFIX")).session.channel).toBe("unknown");
  });

  it("finds the events, in order, with the log's own UTC times", () => {
    expect(parsed.events.map((e) => e.type)).toEqual([
      "login_completed",
      "spawned",
      "jurisdiction_entered",
      "jurisdiction_entered",
      "zone_change",
      "zone_change",
      "zone_change",
      "zone_change",
      "mission_accepted",
      "objective_new",
      "objective_completed",
      "mission_completed",
      "mission_ended",
      "shop_purchase_requested",
      "shop_purchase_result",
      "insurance_claim_requested",
      "hangar_request_completed",
      "session_end",
    ]);
    expect(parsed.events[0].time).toBe("2026-11-02T20:07:00.000Z");
  });

  it("extracts the useful fields", () => {
    const by = (type: string) => parsed.events.filter((e) => e.type === type);
    expect(by("jurisdiction_entered").map((e) => e.jurisdiction)).toEqual([
      "Test Alliance",
      "Ungoverned",
    ]);
    expect(by("zone_change").map((e) => `${e.zone}:${e.action}`)).toEqual([
      "armistice:enter",
      "armistice:leave",
      "monitored_space:enter",
      "restricted_area:warning",
    ]);
    expect(by("mission_accepted")[0].title).toBe("Test Bounty: Some Target | Low-Risk");
    expect(by("mission_completed")[0].title).toBe("Test Bounty: Some Target | Low-Risk");
    expect(by("objective_new")[0].objective).toBe("Go to Asteroid Base");
    expect(by("objective_completed")[0].objective).toBe("Go to Somewhere");
    expect(by("mission_ended")[0].state).toBe("completed");
    expect(by("shop_purchase_requested")[0]).toMatchObject({
      shop: "SCShop_Test_Area",
      item: "test_armor_01",
      quantity: 1,
      price: 16761,
    });
    expect(by("shop_purchase_result")[0]).toMatchObject({
      shop: "SCShop_Test_Area",
      result: "Success",
    });
    expect(by("session_end")[0].exit_code).toBe(0);
  });

  it("counts a notification once although the game logs it three times", () => {
    expect(
      parsed.events.filter(
        (e) => e.type === "jurisdiction_entered" && e.jurisdiction === "Test Alliance",
      ),
    ).toHaveLength(1);
  });

  it("ignores and counts the lines it does not know, and invents nothing from them", () => {
    expect(parsed.stats.ignored).toBeGreaterThanOrEqual(4);
    expect(parsed.stats.lines).toBe(parsed.stats.recognized + parsed.stats.ignored);
    expect(parsed.events.some((e) => JSON.stringify(e).includes("Quantum"))).toBe(false);
  });

  it("never returns the pilot name, the account id or a personal path", () => {
    const out = JSON.stringify(parsed);
    expect(out).not.toContain(PILOT);
    expect(out).not.toContain(ACCOUNT);
    expect(out).not.toContain("fakeuser");
  });

  it("does not report a clean exit when the log just stops (crash, kill, still running)", () => {
    expect(parseLog([...HEADER, ...BODY].join("\n")).session.clean_exit).toBe(false);
  });

  it("copes with empty and garbage input", () => {
    expect(parseLog("").events).toEqual([]);
    expect(parseLog("\u0000\u0001 not a log\n\n\n").stats.recognized).toBe(0);
  });
});

describe("decodeLog", () => {
  it("handles UTF-8, UTF-8 with BOM and UTF-16 LE with BOM", () => {
    expect(decodeLog(Buffer.from("héllo"))).toBe("héllo");
    expect(decodeLog(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("héllo")]))).toBe(
      "héllo",
    );
    expect(
      decodeLog(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo", "utf16le")])),
    ).toBe("héllo");
  });
});

describe("GameLog reader", () => {
  let dir: string;
  const write = (name: string, text: string, from = dir) => {
    fs.mkdirSync(path.dirname(path.join(from, name)), { recursive: true });
    fs.writeFileSync(path.join(from, name), text);
    return path.join(from, name);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "scmcp-log-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("is off until a path is configured, and says how to turn it on", async () => {
    const log = new GameLog({});
    expect(log.configured).toBe(false);
    await expect(log.read()).rejects.toThrow(/SC_GAME_LOG_PATH/);
  });

  it("reads from SC_GAME_LOG_PATH or from a channel folder (SC_INSTALL_DIR)", async () => {
    const file = write("Game.log", LOG);
    expect((await new GameLog({ logPath: file }).read()).parsed.events.length).toBeGreaterThan(10);
    expect((await new GameLog({ installDir: dir }).read()).parsed.session.build).toBe("12345678");
  });

  it("only reads .log files, so it cannot be turned into a general file reader", async () => {
    const secret = write("secrets.txt", "top secret");
    await expect(new GameLog({ logPath: secret }).read()).rejects.toThrow(/\.log file/);
  });

  it("names a missing file by its last three path parts, not the user's folders", async () => {
    const err = await new GameLog({ logPath: path.join(dir, "deep", "LIVE", "Game.log") })
      .read()
      .catch((e) => e);
    expect(err).toBeInstanceOf(GameLogError);
    expect(err.message).toContain("…/deep/LIVE/Game.log");
    expect(err.message).not.toContain(os.tmpdir());
  });

  it("does not modify the log or create anything next to it", async () => {
    const file = write("Game.log", LOG);
    const before = fs.statSync(file);
    const listing = fs.readdirSync(dir);
    await new GameLog({ logPath: file }).read();
    const after = fs.statSync(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(fs.readdirSync(dir)).toEqual(listing);
  });

  it("can read while the game still has the file open for writing", async () => {
    const file = write("Game.log", LOG);
    const writer = fs.openSync(file, "a");
    try {
      fs.writeSync(writer, `${t("11:00.000")} [CSessionManager::OnClientSpawned] Spawned!\n`);
      const r = await new GameLog({ logPath: file }).read();
      expect(r.parsed.events.at(-1)?.type).toBe("spawned");
    } finally {
      fs.closeSync(writer);
    }
  });

  it("reads only the end of a big log, keeps the header's facts, and counts nothing twice", async () => {
    const filler = Array.from(
      { length: 2000 },
      (_, i) => `${t("12:00.000")} [Notice] <Filler> line ${i} ${"x".repeat(60)}`,
    );
    const file = write("Game.log", [...HEADER, ...filler, ...BODY, QUIT].join("\n"));
    const r = await new GameLog({ logPath: file }).read("current", 9000);
    expect(r.truncated).toBe(true);
    expect(r.parsed.session).toMatchObject({
      game_version: "9.9.1.2222",
      build: "12345678",
      channel: "live",
    });
    expect(r.parsed.events.filter((e) => e.type === "login_completed")).toHaveLength(1);
    expect(r.parsed.events.at(-1)?.type).toBe("session_end");
  });

  it("follows a rotation: when Game.log is replaced by a smaller file, it reads the new one", async () => {
    const file = write("Game.log", LOG);
    const log = new GameLog({ logPath: file });
    await log.read();
    fs.writeFileSync(file, [...HEADER.slice(0, 5), BODY[3]].join("\n"));
    const r = await log.read();
    expect(r.parsed.events.map((e) => e.type)).toEqual(["spawned"]);
  });

  it("reads the previous session from logbackups, newest first", async () => {
    const file = write("Game.log", "");
    write("logbackups/Game Build(1) old.log", HEADER.join("\n").replace("12345678", "10000001"));
    const newer = write("logbackups/Game Build(2) new.log", HEADER.join("\n"));
    fs.utimesSync(newer, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const r = await new GameLog({ logPath: file }).read("previous");
    expect(r.parsed.session.build).toBe("12345678");
    expect(r.running).toBe(false);
  });

  it("says a log written in the last two minutes means the game is running", async () => {
    const file = write("Game.log", LOG);
    const mtime = fs.statSync(file).mtimeMs;
    expect((await new GameLog({ logPath: file }, () => mtime + 30_000).read()).running).toBe(true);
    expect((await new GameLog({ logPath: file }, () => mtime + 10 * 60_000).read()).running).toBe(
      false,
    );
  });

  it("shortPath keeps three parts, with either separator", () => {
    expect(shortPath("C:\\Games\\Me\\StarCitizen\\LIVE\\Game.log")).toBe(
      "…/StarCitizen/LIVE/Game.log",
    );
    expect(shortPath("/a/b/c/d/Game.log")).toBe("…/c/d/Game.log");
  });

  describe("through the tools", () => {
    const empty = {
      defaults: { baseURL: "https://x.test" },
      get: async () => ({ data: {} }),
    } as unknown as HttpClient;
    const registry = (gameLog: GameLog) =>
      createRegistry(
        allTools({
          uexClient: empty,
          scwClient: empty,
          sctClient: empty,
          scmdb: new Scmdb({ raw: empty, api: empty, repo: "o/r", cacheDir: () => dir }),
          gameLog,
          fleet: new FleetStore("unused-fleet.json"),
        }),
        {},
      );
    const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

    beforeEach(() => {
      configureDiskCache(null);
      clearCache();
    });

    it("sc_log_status explains how to enable the log, and reads nothing, when it is off", async () => {
      const r = body(await registry(new GameLog({})).call("sc_log_status", {}));
      expect(r.data.configured).toBe(false);
      expect(r.data.how_to_enable).toMatch(/SC_GAME_LOG_PATH/);
    });

    it("sc_log_status reports the session and the log's age in its provenance", async () => {
      const file = write("one/two/three/Game.log", LOG);
      const r = body(await registry(new GameLog({ logPath: file })).call("sc_log_status", {}));
      expect(r.provenance).toMatchObject({
        kind: "local_log",
        channel: "live",
        source: "Game.log (local)",
      });
      expect(r.provenance.game_version).toBe("9.9.1.2222 (build 12345678)");
      expect(r.data.session.state).toMatch(/ended \(clean quit\)/);
      expect(r.data.events_found.zone_change).toBe(4);
      expect(JSON.stringify(r)).not.toContain(PILOT);
      // Only the last three path parts are shown, so nothing of the folder above them can leak.
      expect(JSON.stringify(r)).not.toContain(dir);
    });

    it("sc_log_recent_events filters, limits, and fences the text as untrusted", async () => {
      const file = write("Game.log", LOG);
      const reg = registry(new GameLog({ logPath: file }));
      const all = body(await reg.call("sc_log_recent_events", {}));
      expect(all.provenance.trust).toBe("untrusted_text");
      expect(all.data.total_matching).toBe(18);
      const missions = body(
        await reg.call("sc_log_recent_events", {
          types: ["mission_accepted", "mission_completed"],
        }),
      );
      expect(missions.data.events.map((e: { type: string }) => e.type)).toEqual([
        "mission_accepted",
        "mission_completed",
      ]);
      const last = body(await reg.call("sc_log_recent_events", { limit: 2 }));
      expect(last.data.events.map((e: { type: string }) => e.type)).toEqual([
        "hangar_request_completed",
        "session_end",
      ]);
      // The log's own clock is the reference: the last 30 seconds before its final line.
      const recent = body(await reg.call("sc_log_recent_events", { since_minutes: 0.5 }));
      expect(recent.data.events.map((e: { type: string }) => e.type)).toEqual([
        "shop_purchase_requested",
        "shop_purchase_result",
        "insurance_claim_requested",
        "hangar_request_completed",
        "session_end",
      ]);
    });

    it("sc_log_recent_events returns an explicit error when the log is off", async () => {
      const r = await registry(new GameLog({})).call("sc_log_recent_events", {});
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/log is off/);
    });
  });
});
