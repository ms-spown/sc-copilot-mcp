import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, configureDiskCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { allTools, createRegistry } from "./registry.js";

/**
 * Feature: my trade journal, from my own Game.log.
 * The log is a hand-made file in a temp folder; the wiki is a fake client. Every name, id and
 * GUID is invented; the handle and ids are here only to prove they never come back out.
 */

const PILOT = "FakePilotXyz";
const ACCOUNT = "9876543210";
const SHOP_ID = "5551234";
const WASTE = "aaaaaaaa-1111-4222-8333-444444444444";
const OTHER = "dddddddd-1111-4222-8333-777777777777";
const ids = `playerId[${ACCOUNT}] shopId[${SHOP_ID}] shopName[SCShop_Test_Admin_g] kioskId[${SHOP_ID}]`;
const t = (hms: string) => `<2026-11-03T${hms}Z>`;
const buy = (hms: string, price: number, centi: number, guid = WASTE) =>
  `${t(hms)} [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> Sending SShopCommodityBuyRequest - ${ids} price[${price}.000000] shopPricePerCentiSCU[1.889409] resourceGUID[${guid}] autoLoading[1] quantity[${centi}.000000 cSCU] Cargo Box Data: boxSize[32.000000] | unitAmount[20] [Team_X][Shops][UI]`;
const sell = (hms: string, amount: number, scu: number, guid = WASTE) =>
  `${t(hms)} [Notice] <CEntityComponentCommodityUIProvider::SendCommoditySellRequest> Sending SShopCommoditySellRequest - ${ids} amount[${amount}.000000] resourceGUID[${guid}] autoLoading[1] quantity[${scu}] transactionMode[CargoGrid] Cargo Box Data:  [boxSize[32] | unitAmount[20]] [Team_X][Shops][UI]`;
const gear = `${t("20:05:00.000")} [Notice] <CEntityComponentShopUIProvider::SendShopBuyRequest> Sending SShopBuyRequest - ${ids} client_price[900.000000] itemClassGUID[eeeeeeee-1111-4222-8333-888888888888] itemName[tst_armor_heavy_core_01] quantity[3]  [Team_X][Shops][UI]`;
const gearOk = `${t("20:05:01.000")} [Notice] <CEntityComponentShopUIProvider::RmShopFlowResponse> Received ShopFlowResponse - ${ids} kioskState[BuyRequestProcessing] result[Success] type[Buying] [Team_X][Shops][UI]`;
const where = `${t("19:59:00.000")} [Notice] <RequestLocationInventory> Player[${PILOT}] requested inventory for Location[Test_Station_1] [Team_X][Inventory]`;
const HEADER = [
  `${t("19:00:00.100")} Log started on Tue Nov  3 20:00:00 2026`,
  `${t("19:00:00.200")} FileVersion: 9.9.1.2222`,
  `${t("19:00:00.300")} [Trace] Environment:   PUB`,
  `${t("19:00:00.400")} [Trace] @env_session:  'pub-sc-alpha-991-12345678'`,
];
const TRIP = [
  where,
  buy("20:01:00.000", 120923, 64000),
  buy("20:03:00.000", 10581, 5600),
  gear,
  gearOk,
  sell("20:20:00.000", 292480, 640),
  sell("20:21:00.000", 25592, 56),
  `${t("20:30:00.000")} [Notice] <Something Else> later`,
];

function wikiPage(rows: { uuid: string; name: string }[], last = 1) {
  return { data: { data: rows, meta: { last_page: last } } };
}

let dir: string;
beforeEach(() => {
  clearCache();
  configureDiskCache(null);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "scmcp-trade-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function world(lines: string[] | null, scw?: (url: string) => unknown) {
  const file = path.join(dir, "Game.log");
  if (lines) fs.writeFileSync(file, [...HEADER, ...lines].join("\n"));
  const get = vi.fn(async (url: string) => {
    if (url === "/commodities" && scw) return scw(url) as { data: unknown };
    throw new Error(`unexpected ${url}`);
  });
  const wiki = { defaults: { baseURL: "https://trade.test" }, get } as unknown as HttpClient;
  const empty = {
    defaults: { baseURL: "https://x.test" },
    get: async () => ({ data: {} }),
  } as unknown as HttpClient;
  const registry = createRegistry(
    allTools({
      uexClient: empty,
      scwClient: wiki,
      sctClient: empty,
      scmdb: new Scmdb({ raw: empty, api: empty, repo: "o/r", cacheDir: () => "unused" }),
      gameLog: new GameLog({ logPath: file }),
      fleet: new FleetStore("unused-fleet.json"),
    }),
    {},
  );
  return { registry, get };
}
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe("Feature: sc_trade_journal", () => {
  describe("Scenario: a session with a cargo run and a gear purchase", () => {
    it("Given the log, When I ask, Then the run is paired, named, and labelled gross and estimated", async () => {
      const { registry } = world(TRIP, () =>
        wikiPage([
          { uuid: OTHER, name: "Not Mine" },
          { uuid: WASTE.toUpperCase(), name: "Waste" },
        ]),
      );
      const out = body(await registry.call("sc_trade_journal", {}));
      expect(out.provenance).toMatchObject({ trust: "untrusted_text", kind: "local_log" });
      expect(out.notice).toBeTruthy();
      const s = out.data.sessions[0];
      expect(s.game_version).toBe("9.9.1.2222");
      expect(s.cargo_runs).toHaveLength(1);
      expect(s.cargo_runs[0]).toMatchObject({
        commodity_id: "aaaaaaaa",
        commodity_name: "Waste",
        state: "closed",
        paired_scu: 696,
        cost_auec: 131504,
        revenue_auec: 318072,
        gross_margin_auec: 186568,
        estimated: true,
      });
      expect(s.spending_by_category).toEqual([
        { category: "armor", auec: 900, lines: 1, quantity: 3, inferred: true },
      ]);
      const first = s.transactions[0];
      expect(first).toMatchObject({
        kind: "commodity",
        side: "buy",
        unit: "SCU",
        quantity: 640,
        commodity_name: "Waste",
        auto_loading: true,
        confidence: "inferred",
        location_hint: { token: "Test_Station_1", seconds_before: 120 },
      });
      expect(first.resource).toBeUndefined();
      expect(s.transactions_shown).toBe(5);
      expect(out.data.reading_notes.join(" ")).toMatch(/no wallet balance/);
    });

    it("Given the log, When the answer is read, Then no handle, id or full GUID is in it", async () => {
      const { registry } = world(TRIP, () => wikiPage([{ uuid: WASTE, name: "Waste" }]));
      const text = (await registry.call("sc_trade_journal", {})).content[0].text;
      for (const secret of [PILOT, ACCOUNT, SHOP_ID, WASTE]) expect(text).not.toContain(secret);
    });
  });

  describe("Scenario: names", () => {
    it("Given the wiki does not know the GUID, Then it is 'unknown commodity', not a guess", async () => {
      const { registry } = world(TRIP, () => wikiPage([{ uuid: OTHER, name: "Not Mine" }]));
      const s = body(await registry.call("sc_trade_journal", {})).data.sessions[0];
      expect(s.cargo_runs[0].commodity_name).toBe("unknown commodity");
    });
    it("Given the wiki is down, Then the journal still comes, with the error said", async () => {
      const { registry } = world(TRIP, () => {
        throw new Error("boom");
      });
      const out = body(await registry.call("sc_trade_journal", {}));
      expect(out.data.sessions[0].cargo_runs[0].gross_margin_auec).toBe(186568);
      expect(out.data.sessions[0].cargo_runs[0].commodity_name).toBe("unknown commodity");
      expect(out.data.commodity_names.lookup_error).toBeTruthy();
    });
    it("Given resolve_names false, Then the wiki is not called at all", async () => {
      const { registry, get } = world(TRIP, () => wikiPage([]));
      const out = body(await registry.call("sc_trade_journal", { resolve_names: false }));
      expect(get).not.toHaveBeenCalled();
      expect(out.data.commodity_names.source).toBe("not looked up");
    });
    it("Given a session with no cargo, Then the wiki is not called", async () => {
      const { registry, get } = world([gear, gearOk], () => wikiPage([]));
      await registry.call("sc_trade_journal", {});
      expect(get).not.toHaveBeenCalled();
    });
    it("Given a wiki name with an invisible character, Then it comes out clean", async () => {
      const bad = `Wa${String.fromCodePoint(0x200b)}ste`;
      const { registry } = world(TRIP, () => wikiPage([{ uuid: WASTE, name: bad }]));
      const s = body(await registry.call("sc_trade_journal", {})).data.sessions[0];
      expect(s.cargo_runs[0].commodity_name).toBe("Waste");
    });
    it("Given the list has several pages, Then it reads on until the GUID is found", async () => {
      let n = 0;
      const { registry, get } = world(TRIP, () => {
        n += 1;
        return n === 1
          ? wikiPage([{ uuid: OTHER, name: "Not Mine" }], 3)
          : wikiPage([{ uuid: WASTE, name: "Waste" }], 3);
      });
      const s = body(await registry.call("sc_trade_journal", {})).data.sessions[0];
      expect(s.cargo_runs[0].commodity_name).toBe("Waste");
      expect(get).toHaveBeenCalledTimes(2);
    });
  });

  describe("Scenario: limits", () => {
    it("Given many transactions, Then only the latest are listed and totals still cover all", async () => {
      const { registry } = world(TRIP, () => wikiPage([]));
      const s = body(await registry.call("sc_trade_journal", { max_transactions: 2 })).data
        .sessions[0];
      expect(s.transactions_total).toBe(5);
      expect(s.transactions_shown).toBe(2);
      expect(s.totals.cargo.sold_auec).toBe(318072);
    });
    it("Given a log with no trade, Then no session is listed", async () => {
      const { registry } = world([`${t("20:00:00.000")} [Notice] <Other> x`]);
      const out = body(await registry.call("sc_trade_journal", {}));
      expect(out.data.sessions).toEqual([]);
      expect(out.data.log_files_scanned).toBe(1);
    });
    it("Given the game log is off, Then it says how to turn it on", async () => {
      const empty = {
        defaults: { baseURL: "https://x.test" },
        get: async () => ({ data: {} }),
      } as unknown as HttpClient;
      const registry = createRegistry(
        allTools({
          uexClient: empty,
          scwClient: empty,
          sctClient: empty,
          scmdb: new Scmdb({ raw: empty, api: empty, repo: "o/r", cacheDir: () => "unused" }),
          gameLog: new GameLog({}),
          fleet: new FleetStore("unused-fleet.json"),
        }),
        {},
      );
      const r = await registry.call("sc_trade_journal", {});
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/SC_GAME_LOG_PATH/);
    });
  });
});
