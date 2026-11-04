import type { BalancePolicy } from "../core/balance.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, configureDiskCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { HIDDEN_MODES, SHOWN_MODES } from "../testing/balanceModes.js";
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

function world(lines: string[] | null, scw?: (url: string) => unknown, balance?: BalancePolicy) {
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
      ...(balance ? { balance } : {}),
    }),
    {},
  );
  return { registry, get };
}
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

/** n round trips (2 cargo lines each) and m shop purchases, one line every 10 s from `start`. */
function busySession(start: number, trips: number, purchases: number): string[] {
  const out: string[] = [];
  let at = start;
  const hms = () => {
    at += 10;
    return new Date(at * 1000).toISOString().slice(11, 23);
  };
  for (let i = 0; i < trips; i++) {
    out.push(buy(hms(), 1000 + i, 1000));
    out.push(sell(hms(), 1500 + i, 10));
  }
  for (let i = 0; i < purchases; i++) {
    out.push(gear.replace(/<[^>]+>/, `<2026-11-03T${hms()}Z>`));
    out.push(gearOk.replace(/<[^>]+>/, `<2026-11-03T${hms()}Z>`));
  }
  return out;
}
const T0 = Date.parse("2026-11-03T00:00:00Z") / 1000;

describe("Feature: sc_trade_journal", () => {
  describe("Scenario: a session with a cargo run and a gear purchase", () => {
    it("Given the log, When I ask, Then the run is paired, named, and labelled gross and estimated", async () => {
      const { registry } = world(TRIP, () =>
        wikiPage([
          { uuid: OTHER, name: "Not Mine" },
          { uuid: WASTE.toUpperCase(), name: "Waste" },
        ]),
      );
      const out = body(await registry.call("sc_trade_journal", { include_balance: true }));
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

  describe("Scenario: aUEC amounts are given by default and withheld when the player hid them", () => {
    // Every amount of TRIP, as a number a scan can look for: line totals, unit prices, cost, revenue, margins, spending.
    const AMOUNTS = [120923, 10581, 292480, 25592, 131504, 318072, 186568, 900, 1.889409, 267.8];
    const AMOUNT_KEYS =
      /"(total_auec|unit_price_auec|shop_unit_price_scu|cost_auec|revenue_auec|gross_margin_auec|gross_margin_per_scu_auec|bought_auec|sold_auec|auec)"/;

    it.each(HIDDEN_MODES)(
      "Given $label, When I ask for the journal, Then no amount, key or figure of aUEC is in the answer",
      async (mode) => {
        const { registry } = world(
          TRIP,
          () => wikiPage([{ uuid: WASTE, name: "Waste" }]),
          mode.policy,
        );
        const result = await registry.call("sc_trade_journal", { ...mode.args });
        const text = result.content[0].text;
        expect(text).not.toMatch(AMOUNT_KEYS);
        // A whole figure, not a part of a longer number or a decimal fraction: the milliseconds of a clock time
        // ("...:46.900Z") must not count as the amount 900.
        for (const amount of AMOUNTS) {
          const whole = new RegExp(`(?<![0-9.])${String(amount).replace(/\./g, "\\.")}(?![0-9])`);
          expect(text, String(amount)).not.toMatch(whole);
        }
        const out = JSON.parse(text);
        expect(out.data.money_note).toMatch(/Montants masqués/);
        // the player's hidden choice says what it ignores; a call that only passed false says its own, shorter note
        if (mode.policy) {
          expect(out.data.money_note).toMatch(/include_balance=true est ignoré/);
        } else {
          expect(out.data.money_note).toMatch(/pour cet appel/);
        }
      },
    );

    it.each(HIDDEN_MODES)(
      "Given $label, Then counts, SCU, kinds, statuses, categories and the structure stay",
      async (mode) => {
        const { registry } = world(
          TRIP,
          () => wikiPage([{ uuid: WASTE, name: "Waste" }]),
          mode.policy,
        );
        const s = body(await registry.call("sc_trade_journal", { ...mode.args })).data.sessions[0];
        expect(s.cargo_runs[0]).toMatchObject({
          commodity_name: "Waste",
          state: "closed",
          paired_scu: 696,
          bought_scu: 696,
          buy_lines: 2,
          sell_lines: 2,
          estimated: true,
        });
        expect(s.spending_by_category).toEqual([
          { category: "armor", lines: 1, quantity: 3, inferred: true },
        ]);
        expect(s.totals.cargo).toMatchObject({ bought_scu: 696, sold_scu: 696, buy_lines: 2 });
        expect(s.transactions[0]).toMatchObject({
          kind: "commodity",
          side: "buy",
          unit: "SCU",
          quantity: 640,
          status: expect.any(String),
          confidence: "inferred",
        });
        expect(s.transactions_shown).toBe(5);
      },
    );

    it.each(SHOWN_MODES)(
      "Given $label, Then the amounts are there (positive control) and there is no withheld note",
      async (mode) => {
        const { registry } = world(
          TRIP,
          () => wikiPage([{ uuid: WASTE, name: "Waste" }]),
          mode.policy,
        );
        const out = body(await registry.call("sc_trade_journal", { ...mode.args }));
        expect(out.data.sessions[0].cargo_runs[0]).toMatchObject({
          cost_auec: 131504,
          revenue_auec: 318072,
          gross_margin_auec: 186568,
        });
        expect(out.data.sessions[0].transactions[0].total_auec).toBe(120923);
        expect(out.data.money_note).toBeUndefined();
      },
    );

    it("Given SC_BALANCE=hidden, Then include_balance true is ignored, and only the player's click on Afficher gives the amounts", async () => {
      const policy = { hiddenByDefault: true, playerChoice: null as "hidden" | "shown" | null };
      const { registry } = world(TRIP, () => wikiPage([{ uuid: WASTE, name: "Waste" }]), policy);
      const ignored = (await registry.call("sc_trade_journal", { include_balance: true }))
        .content[0].text;
      expect(ignored).not.toContain("120923");
      expect(ignored).toContain("Montants masqués par le joueur");
      policy.playerChoice = "shown";
      const lifted = (await registry.call("sc_trade_journal", {})).content[0].text;
      expect(lifted).toContain("120923");
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
      const out = body(await registry.call("sc_trade_journal", { include_balance: true }));
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

  describe("Scenario: a very busy log must never come back as 'too large'", () => {
    const wiki = () => wikiPage([{ uuid: WASTE, name: "Waste" }]);
    const fits = (out: { data: Record<string, unknown> }) => {
      expect(out.data.error).toBeUndefined();
      expect(JSON.stringify(out.data, null, 2).length).toBeLessThan(40_000);
    };

    it("Given 130 cargo lines, 40 shop lines and max_transactions 120, Then the answer is cut to fit and says how much", async () => {
      const { registry } = world(busySession(T0, 65, 40), wiki);
      const out = body(
        await registry.call("sc_trade_journal", { max_transactions: 120, include_balance: true }),
      );
      fits(out);
      const s = out.data.sessions[0];
      expect(s.transactions_total).toBe(170);
      expect(s.transactions_shown).toBeLessThan(120);
      expect(s.transactions_shown).toBeGreaterThan(0);
      expect(s.cargo_runs_total).toBe(65);
      expect(out.data.truncated.transactions).toMatch(/of 170 shown/);
      expect(out.data.truncated.cargo_runs).toMatch(/of 65 shown/);
      // Totals still cover the whole session.
      expect(s.totals.cargo.buy_lines).toBe(65);
    });

    it("Given the same log and resolve_names false, Then it fits too", async () => {
      const { registry } = world(busySession(T0, 65, 40), wiki);
      fits(
        body(
          await registry.call("sc_trade_journal", {
            max_transactions: 120,
            resolve_names: false,
            include_balance: true,
          }),
        ),
      );
    });

    it("Given 3 sessions with many lines, Then the whole answer fits and every session is listed", async () => {
      const { registry } = world(busySession(T0, 40, 20), wiki);
      fs.mkdirSync(path.join(dir, "logbackups"));
      for (const [i, name] of ["a.log", "b.log"].entries()) {
        const f = path.join(dir, "logbackups", name);
        fs.writeFileSync(f, [...HEADER, ...busySession(T0 + (i + 1) * 100_000, 40, 20)].join("\n"));
        const old = new Date(Date.now() - (i + 1) * 3_600_000);
        fs.utimesSync(f, old, old);
      }
      const out = body(
        await registry.call("sc_trade_journal", {
          sessions: 5,
          max_transactions: 120,
          include_balance: true,
        }),
      );
      fits(out);
      expect(out.data.sessions).toHaveLength(3);
      expect(
        out.data.sessions.reduce(
          (n: number, x: { transactions_shown: number }) => n + x.transactions_shown,
          0,
        ),
      ).toBeLessThanOrEqual(120);
    });

    it("Given three small sessions, Then each one lists its own rows (the row budget counts rows shown)", async () => {
      const { registry } = world(TRIP, wiki);
      fs.mkdirSync(path.join(dir, "logbackups"));
      for (const [i, name] of ["a.log", "b.log"].entries()) {
        const f = path.join(dir, "logbackups", name);
        fs.writeFileSync(f, [...HEADER, ...TRIP].join("\n"));
        const old = new Date(Date.now() - (i + 1) * 3_600_000);
        fs.utimesSync(f, old, old);
      }
      const out = body(await registry.call("sc_trade_journal", { sessions: 5 }));
      expect(
        out.data.sessions.map((x: { transactions_shown: number }) => x.transactions_shown),
      ).toEqual([5, 5, 5]);
    });

    it("Given a small log, Then nothing is cut and there is no truncation note", async () => {
      const { registry } = world(TRIP, wiki);
      const out = body(await registry.call("sc_trade_journal", {}));
      expect(out.data.truncated).toBeUndefined();
    });
  });

  describe("Scenario: limits", () => {
    it("Given many transactions, Then only the latest are listed and totals still cover all", async () => {
      const { registry } = world(TRIP, () => wikiPage([]));
      const s = body(
        await registry.call("sc_trade_journal", { max_transactions: 2, include_balance: true }),
      ).data.sessions[0];
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
