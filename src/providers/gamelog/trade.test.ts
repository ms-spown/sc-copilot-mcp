import { describe, expect, it } from "vitest";
import { parseLog } from "./parser.js";
import {
  bracketField,
  buildTradeJournal,
  categorize,
  parseCommerceText,
  type TradeRecord,
} from "./trade.js";

/**
 * Hand-made lines in the shapes seen in real logs. Every name, id and number is invented; the
 * handle and the ids are here ONLY so the tests can prove they never come back out.
 */
const PILOT = "FakePilotXyz";
const ACCOUNT = "9876543210";
const SHOP_ID = "5551234";
const KIOSK_ID = "7774321";
const WASTE = "aaaaaaaa-1111-4222-8333-444444444444";
const STIMS = "bbbbbbbb-1111-4222-8333-555555555555";

const at = (hms: string) => `<2026-11-03T${hms}Z>`;
const OWNER = "[Team_CoreGameplayFeatures][Shops][UI]";
const ids = `playerId[${ACCOUNT}] shopId[${SHOP_ID}]`;
const kiosk = `kioskId[${KIOSK_ID}]`;
const CARGO_SHOP = "SCShop_Test_Admin_g";

const cargoBuy = (hms: string, price: number, centi: number, guid = WASTE, auto = 1) =>
  `${at(hms)} [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> Sending SShopCommodityBuyRequest - ${ids} shopName[${CARGO_SHOP}] ${kiosk} price[${price}.000000] shopPricePerCentiSCU[1.889409] resourceGUID[${guid}] autoLoading[${auto}] quantity[${centi}.000000 cSCU] Cargo Box Data: boxSize[32.000000] | unitAmount[20] ${OWNER}`;
const cargoSell = (hms: string, amount: number, scu: number, guid = WASTE) =>
  `${at(hms)} [Notice] <CEntityComponentCommodityUIProvider::SendCommoditySellRequest> Sending SShopCommoditySellRequest - ${ids} shopName[${CARGO_SHOP}] ${kiosk} amount[${amount}.000000] resourceGUID[${guid}] autoLoading[1] quantity[${scu}] transactionMode[CargoGrid] Cargo Box Data:  [boxSize[32] | unitAmount[20]] ${OWNER}`;
const cargoError = (hms: string, result: string, type: string) =>
  `${at(hms)} [Error] <CEntityComponentCommodityUIProvider::RmToken_CommodityTransactionResponse> Commodity Transaction Response Error - playerId[${ACCOUNT}] result[${result}] type[${type}] [Team_NAPU][Shops]`;
const itemBuy = (
  hms: string,
  item: string,
  price: number,
  qty: number,
  shop = "SCShop_Test_Armor",
) =>
  `${at(hms)} [Notice] <CEntityComponentShopUIProvider::SendShopBuyRequest> Sending SShopBuyRequest - ${ids} shopName[${shop}] ${kiosk} client_price[${price}.000000] itemClassGUID[cccccccc-1111-4222-8333-666666666666] itemName[${item}] quantity[${qty}]  ${OWNER}`;
const itemSell = (hms: string, item: string, price: number, qty: number) =>
  `${at(hms)} [Notice] <CEntityComponentShopUIProvider::SendShopSellRequest> Sending SShopSellRequest - ${ids} shopName[SCShop_Test_Fence] ${kiosk} client_price[${price}.000000] itemClassGUID[cccccccc-1111-4222-8333-666666666666] itemName[${item}] quantity[${qty}]  ${OWNER}`;
const standardBuy = (hms: string, item: string, price: number, currency = "UEC") =>
  `${at(hms)} [Notice] <CEntityComponentShoppingProvider::SendStandardItemBuyRequest> Sending SShopBuyRequest - ${ids} shopName[SCShop_Test_Noodles] kioskId[0] client_price[${price}.000000] itemClassGUID[cccccccc-1111-4222-8333-666666666666] itemName[${item}] quantity[1] currencyType[${currency}] ${OWNER}`;
const shopResponse = (hms: string, shop: string, state: string, result: string, type: string) =>
  `${at(hms)} [Notice] <CEntityComponentShopUIProvider::RmShopFlowResponse> Received ShopFlowResponse - ${ids} shopName[${shop}] ${kiosk} kioskState[${state}] result[${result}] type[${type}] ${OWNER}`;
const standardResponse = (hms: string, result: string) =>
  `${at(hms)} [Notice] <CEntityComponentShoppingProvider::RmShopFlowResponse> Shop Flow Response - playerId[${ACCOUNT}] result[${result}] ${OWNER}`;
const location = (hms: string, token: string) =>
  `${at(hms)} [Notice] <RequestLocationInventory> Player[${PILOT}] requested inventory for Location[${token}] [Team_CoreGameplayFeatures][Inventory]`;
const filler = (hms: string) => `${at(hms)} [Notice] <Something Else> nothing to see [Team_X]`;

const records = (...lines: string[]): TradeRecord[] => parseCommerceText(lines.join("\n"));
const journal = (lines: string[], last = "23:59:59.000") =>
  buildTradeJournal(records(...lines), `2026-11-03T${last}Z`);

describe("Feature: reading the commerce lines of Game.log", () => {
  describe("Scenario: field names that contain each other", () => {
    it("Given `client_price[5]`, When `price` is read, Then it is not found inside it", () => {
      expect(bracketField("client_price[5] price[7]", "price")).toBe("7");
      expect(bracketField("client_price[5]", "price")).toBeNull();
    });
    it("Given an item line and a cargo line, When parsed, Then each reads its own price", () => {
      const [item] = records(itemBuy("20:00:00.000", "test_armor_01", 1500, 3));
      const [cargo] = records(cargoBuy("20:00:01.000", 4200, 2200));
      expect(item).toMatchObject({ kind: "item_request", total: 1500, quantity: 3 });
      expect(cargo).toMatchObject({ kind: "cargo_request", total: 4200 });
    });
  });

  describe("Scenario: a cargo purchase is in cSCU, a cargo sale in SCU", () => {
    it("Given 64000 cSCU, When parsed, Then it is 640 SCU and the shop price is per SCU", () => {
      const [r] = records(cargoBuy("20:00:00.000", 120923, 64000));
      expect(r).toMatchObject({
        kind: "cargo_request",
        side: "buy",
        scu: 640,
        total: 120923,
        shop_unit_price_scu: 188.94,
        auto_loading: true,
        resource: WASTE,
      });
    });
    it("Given a sale of 640, When parsed, Then it is 640 SCU and amount is the line total", () => {
      const [r] = records(cargoSell("20:00:00.000", 292480, 640));
      expect(r).toMatchObject({
        kind: "cargo_request",
        side: "sell",
        scu: 640,
        total: 292480,
        shop_unit_price_scu: null,
        transaction_mode: "CargoGrid",
      });
    });
    it("Given a purchase with no unit or a bad GUID, When parsed, Then it is refused, not guessed", () => {
      const noUnit = cargoBuy("20:00:00.000", 1, 100).replace(".000000 cSCU", "");
      expect(records(noUnit)).toEqual([]);
      expect(records(cargoBuy("20:00:00.000", 1, 100, "not-a-guid"))).toEqual([]);
    });
  });

  describe("Scenario: privacy", () => {
    it("Given every kind of line, When parsed, Then no id and no handle is in any record", () => {
      const all = records(
        itemBuy("20:00:00.000", "test_armor_01", 10, 1),
        itemSell("20:00:01.000", "test_chip_01", 10, 1),
        standardBuy("20:00:02.000", "Drink_can_test_01", 3),
        shopResponse(
          "20:00:03.000",
          "SCShop_Test_Armor",
          "BuyRequestProcessing",
          "Success",
          "Buying",
        ),
        standardResponse("20:00:04.000", "Success"),
        cargoBuy("20:00:05.000", 100, 100),
        cargoSell("20:00:06.000", 200, 1),
        cargoError("20:00:07.000", "InvalidQuantityError", "Selling"),
        location("20:00:08.000", "Test_Location_1"),
      );
      expect(all.map((r) => r.kind)).toEqual([
        "item_request",
        "item_request",
        "item_request",
        "item_response",
        "item_response",
        "cargo_request",
        "cargo_request",
        "cargo_error",
        "location",
      ]);
      const text = JSON.stringify(all);
      for (const secret of [PILOT, ACCOUNT, SHOP_ID, KIOSK_ID]) expect(text).not.toContain(secret);
    });
    it("Given a location token with a long number in it, When parsed, Then it is dropped (it could be an id)", () => {
      expect(records(location("20:00:00.000", "RR_P2_L4_12345678"))).toEqual([]);
      expect(records(location("20:00:00.000", "Stanton4_NewBabbage_01"))).toHaveLength(1);
    });
    it("Given a location line whose token is not a plain identifier, When parsed, Then it is dropped", () => {
      expect(records(location("20:00:00.000", "bad token</x>"))).toEqual([]);
    });
  });

  describe("Scenario: the existing parser", () => {
    it("Given a log, When parsed, Then commerce is kept apart and the events are unchanged", () => {
      const parsed = parseLog(
        [
          itemBuy("20:00:00.000", "test_armor_01", 10, 1),
          shopResponse(
            "20:00:01.000",
            "SCShop_Test_Armor",
            "BuyRequestProcessing",
            "Success",
            "Buying",
          ),
          cargoSell("20:00:02.000", 200, 1),
          itemSell("20:00:03.000", "test_chip_01", 10, 1),
          filler("20:00:04.000"),
        ].join("\n"),
      );
      expect(parsed.events.map((e) => e.type)).toEqual([
        "shop_purchase_requested",
        "shop_purchase_result",
      ]);
      expect(parsed.commerce).toHaveLength(4);
      expect(parsed.stats).toMatchObject({ lines: 5, recognized: 4, ignored: 1 });
    });
  });
});

describe("Feature: the cargo run of a trader", () => {
  describe("Scenario: two purchases then two sales of the same cargo", () => {
    const j = journal([
      location("20:00:00.000", "Test_Station_1"),
      cargoBuy("20:01:00.000", 120923, 64000),
      cargoBuy("20:03:00.000", 10581, 5600),
      cargoSell("20:20:00.000", 292480, 640),
      cargoSell("20:21:00.000", 25592, 56),
    ]);
    it("Then cost, revenue and GROSS margin are those of the 696 paired SCU", () => {
      expect(j.cargo_runs).toHaveLength(1);
      expect(j.cargo_runs[0]).toMatchObject({
        state: "closed",
        buy_lines: 2,
        sell_lines: 2,
        bought_scu: 696,
        sold_scu: 696,
        paired_scu: 696,
        unsold_scu: 0,
        cost_auec: 131504,
        revenue_auec: 318072,
        gross_margin_auec: 186568,
        gross_margin_per_scu_auec: 268.06,
        estimated: true,
        confidence: "inferred",
        commodity_id: "aaaaaaaa",
      });
      // No net figure exists anywhere: the balance is not in the log.
      expect(JSON.stringify(j)).not.toMatch(/net|balance|profit/i);
    });
    it("Then each line carries its unit, unit price, id, autoload flag and the inferred outcome", () => {
      const [b1, , s1] = j.transactions;
      expect(b1).toMatchObject({
        kind: "commodity",
        side: "buy",
        quantity: 640,
        unit: "SCU",
        total_auec: 120923,
        unit_price_auec: 188.94,
        commodity_id: "aaaaaaaa",
        auto_loading: true,
        status: "completed",
        confidence: "inferred",
        basis: "no_error_within_3s",
        shop: CARGO_SHOP,
      });
      expect(s1).toMatchObject({ side: "sell", unit_price_auec: 457, total_auec: 292480 });
      expect(b1.location_hint).toEqual({ token: "Test_Station_1", seconds_before: 60 });
    });
    it("Then the totals count the lines and the autoload flag, with no fee", () => {
      expect(j.totals.cargo).toMatchObject({
        bought_auec: 131504,
        bought_scu: 696,
        sold_auec: 318072,
        sold_scu: 696,
        buy_lines: 2,
        sell_lines: 2,
        autoload_lines: 4,
      });
      expect(JSON.stringify(j)).not.toMatch(/fee/i);
    });
  });

  describe("Scenario: a sale that failed, a purchase that failed", () => {
    const j = journal([
      cargoBuy("20:00:00.000", 1000, 1000),
      cargoSell("20:00:10.000", 0, 10),
      cargoError("20:00:10.500", "InvalidQuantityError", "Selling"),
      cargoBuy("20:00:20.000", 5000, 2000),
      cargoError("20:00:21.000", "TransactionCostMismatch", "Buying"),
      cargoSell("20:00:30.000", 0, 5),
    ]);
    it("Then they are listed with the reason, and left out of totals and runs", () => {
      expect(j.transactions.map((t) => [t.side, t.status, t.reason ?? null, t.basis])).toEqual([
        ["buy", "completed", null, "no_error_within_3s"],
        ["sell", "failed", "InvalidQuantityError", "error_line"],
        ["buy", "failed", "TransactionCostMismatch", "error_line"],
        ["sell", "failed", "zero_amount", "zero_amount"],
      ]);
      expect(j.transactions[1].confidence).toBe("confirmed");
      expect(j.transactions[3].confidence).toBe("inferred");
      expect(j.totals.excluded.failed).toBe(3);
      expect(j.totals.cargo).toMatchObject({ bought_auec: 1000, sold_auec: 0, buy_lines: 1 });
      expect(j.cargo_runs[0]).toMatchObject({ state: "open", unsold_scu: 10, paired_scu: 0 });
      expect(j.cargo_runs[0].gross_margin_per_scu_auec).toBeNull();
    });
  });

  describe("Scenario: one error line after two purchases within 3 s", () => {
    it("Then neither is attributed: both are ambiguous, unconfirmed and not counted", () => {
      const j = journal([
        cargoBuy("20:00:00.000", 1000, 1000),
        cargoBuy("20:00:01.000", 2000, 1000),
        cargoError("20:00:02.000", "TransactionCostMismatch", "Buying"),
      ]);
      expect(j.transactions.map((t) => [t.status, t.confidence, t.basis])).toEqual([
        ["unconfirmed", "ambiguous", "error_line_ambiguous"],
        ["unconfirmed", "ambiguous", "error_line_ambiguous"],
      ]);
      expect(j.transactions[0].reason).toMatch(/ambiguous/);
      expect(j.totals.cargo.bought_auec).toBe(0);
      expect(j.totals.excluded).toMatchObject({ unconfirmed: 2, ambiguous: 2, failed: 0 });
      expect(j.cargo_runs).toEqual([]);
    });
    it("Given a buy and a sale close together, Then the error of one side is not blamed on the other", () => {
      const j = journal([
        cargoBuy("20:00:00.000", 1000, 1000),
        cargoSell("20:00:01.000", 900, 10),
        cargoError("20:00:02.000", "TransactionCostMismatch", "Buying"),
      ]);
      expect(j.transactions.map((t) => [t.side, t.status, t.confidence])).toEqual([
        ["buy", "failed", "confirmed"],
        ["sell", "completed", "inferred"],
      ]);
    });
    it("Given a zero-amount sale next to a normal one, Then the error is the zero-amount sale's", () => {
      const j = journal([
        cargoSell("20:00:00.000", 900, 10),
        cargoSell("20:00:01.000", 0, 10),
        cargoError("20:00:02.000", "InvalidQuantityError", "Selling"),
      ]);
      expect(j.transactions.map((t) => [t.status, t.reason ?? null])).toEqual([
        ["completed", null],
        ["failed", "InvalidQuantityError"],
      ]);
    });
  });

  describe("Scenario: a request in the last seconds of the log", () => {
    it("Given the log ends 1 s after a sale, Then it is unconfirmed and not counted", () => {
      const j = journal([cargoSell("20:00:00.000", 1000, 5)], "20:00:01.000");
      expect(j.transactions[0]).toMatchObject({ status: "unconfirmed", confidence: "unknown" });
      expect(j.totals.cargo.sold_auec).toBe(0);
      expect(j.totals.excluded.unconfirmed).toBe(1);
    });
  });

  describe("Scenario: partial pairing", () => {
    it("Given 100 SCU bought and 150 sold, Then only the 100 paired are valued", () => {
      // 100 SCU at 10 per SCU = 1000; 150 SCU sold for 3000 (20 per SCU): 100 paired = 2000.
      const j = journal([
        cargoBuy("20:00:00.000", 1000, 10000),
        cargoSell("20:10:00.000", 3000, 150),
      ]);
      expect(j.cargo_runs[0]).toMatchObject({
        state: "closed",
        paired_scu: 100,
        sold_without_purchase_scu: 50,
        cost_auec: 1000,
        revenue_auec: 2000,
        gross_margin_auec: 1000,
        gross_margin_per_scu_auec: 10,
      });
    });
    it("Given 100 SCU bought and 40 sold, Then the run stays open with 60 unsold", () => {
      const j = journal([
        cargoBuy("20:00:00.000", 1000, 10000),
        cargoSell("20:10:00.000", 800, 40),
      ]);
      expect(j.cargo_runs[0]).toMatchObject({
        state: "open",
        unsold_scu: 60,
        paired_scu: 40,
        cost_auec: 400,
        revenue_auec: 800,
      });
    });
    it("Given two commodities and two successive trips, Then each trip is its own run", () => {
      const j = journal([
        cargoBuy("20:00:00.000", 100, 1000, WASTE),
        cargoBuy("20:00:10.000", 500, 1000, STIMS),
        cargoSell("20:10:00.000", 150, 10, WASTE),
        cargoSell("20:10:10.000", 400, 10, STIMS),
        cargoBuy("20:20:00.000", 100, 1000, WASTE),
        cargoSell("20:30:00.000", 130, 10, WASTE),
      ]);
      expect(j.cargo_runs.map((r) => [r.commodity_id, r.gross_margin_auec])).toEqual([
        ["aaaaaaaa", 50],
        ["bbbbbbbb", -100],
        ["aaaaaaaa", 30],
      ]);
    });
  });
});

describe("Feature: shop purchases and sales", () => {
  it("Given responses, When paired, Then Success completes and any other result fails", () => {
    const j = journal([
      itemBuy("20:00:00.000", "test_armor_01", 900, 3, "SCShop_Test_Armor"),
      shopResponse(
        "20:00:01.000",
        "SCShop_Test_Armor",
        "BuyRequestProcessing",
        "Success",
        "Buying",
      ),
      itemBuy("20:01:00.000", "test_rifle_01", 5000, 1, "SCShop_Test_Armor"),
      shopResponse(
        "20:01:01.000",
        "SCShop_Test_Armor",
        "BuyRequestProcessing",
        "TransactionCostMismatch",
        "Buying",
      ),
      itemSell("20:02:00.000", "test_chip_01", 300, 1),
      shopResponse(
        "20:02:01.000",
        "SCShop_Test_Fence",
        "SellRequestProcessing",
        "Success",
        "Selling",
      ),
      standardBuy("20:03:00.000", "Drink_can_test_01", 3),
      standardResponse("20:03:01.000", "Success"),
      itemBuy("20:04:00.000", "test_armor_02", 100, 1),
    ]);
    expect(j.transactions.map((t) => [t.side, t.status, t.reason ?? null, t.confidence])).toEqual([
      ["buy", "completed", null, "confirmed"],
      ["buy", "failed", "TransactionCostMismatch", "confirmed"],
      ["sell", "completed", null, "confirmed"],
      ["buy", "completed", null, "confirmed"],
      ["buy", "unconfirmed", null, "unknown"],
    ]);
    expect(j.transactions[0]).toMatchObject({
      kind: "item",
      total_auec: 900,
      quantity: 3,
      unit: "item",
      unit_price_auec: 300,
      item: "test_armor_01",
      category: "armor",
      currency: "not stated (assumed aUEC)",
    });
    expect(j.transactions[3].currency).toBe("aUEC");
    expect(j.totals.items).toMatchObject({
      bought_auec: 903,
      sold_auec: 300,
      buy_lines: 2,
      sell_lines: 1,
    });
    expect(j.totals.excluded).toMatchObject({ failed: 1, unconfirmed: 1 });
  });

  it("Given a purchase in another currency, Then it is listed and left out of the aUEC totals", () => {
    const j = journal([
      standardBuy("20:00:00.000", "Drink_can_test_01", 50, "TOKENS"),
      standardResponse("20:00:01.000", "Success"),
    ]);
    expect(j.transactions[0]).toMatchObject({ status: "completed", currency: "TOKENS" });
    expect(j.totals.items.bought_auec).toBe(0);
    expect(j.totals.excluded.other_currency).toBe(1);
  });

  it("Given purchases, Then spending is grouped by an inferred category, largest first", () => {
    const lines: string[] = [];
    const add = (hms: string, item: string, price: number, qty = 1) => {
      lines.push(itemBuy(`${hms}.000`, item, price, qty));
      lines.push(
        shopResponse(
          `${hms}.500`,
          "SCShop_Test_Armor",
          "BuyRequestProcessing",
          "Success",
          "Buying",
        ),
      );
    };
    add("20:00:00", "Food_burrito_test_a", 18);
    add("20:00:10", "Drink_can_test_a", 6, 2);
    add("20:00:20", "tst_smg_ballistic_01", 800);
    add("20:00:30", "tst_smg_ballistic_01_mag", 40, 4);
    add("20:00:40", "tst_armor_heavy_core_01", 3000);
    add("20:00:50", "TSTC_LaserRepeater_S2", 90000);
    add("20:01:00", "tst_multitool_01", 500);
    const j = journal(lines);
    expect(j.spending_by_category.map((c) => [c.category, c.auec, c.lines, c.quantity])).toEqual([
      ["ship_component", 90000, 1, 1],
      ["armor", 3000, 1, 1],
      ["weapon", 840, 2, 5],
      ["other", 500, 1, 1],
      ["food", 24, 2, 3],
    ]);
    expect(j.spending_by_category.every((c) => c.inferred)).toBe(true);
  });
});

describe("Feature: category from a class name", () => {
  it.each([
    ["Drink_can_test_01_a", "food"],
    ["Food_bar_test_01", "food"],
    ["HRST_LaserRepeater_S2", "ship_component"],
    ["POWR_TEST_S03_SCItem", "ship_component"],
    ["tst_armor_heavy_arms_01_01_01", "armor"],
    ["tst_undersuit_01_01_01", "armor"],
    ["tst_combat_heavy_backpack_01", "armor"],
    ["tst_rifle_ballistic_01", "weapon"],
    ["tst_pistol_ballistic_01_mag", "weapon"],
    ["tst_barrel_comp_s2", "weapon"],
    ["tst_consumable_healing_01", "other"],
    ["Carryable_TBO_InventoryContainer_2SCU", "other"],
  ])("Given %s, Then %s", (item, category) => {
    expect(categorize(item)).toBe(category);
  });
});

describe("Feature: the journal never carries personal data", () => {
  it("Given a full session, When journaled, Then no handle and no id is in the output", () => {
    const j = journal([
      location("20:00:00.000", "Test_Station_1"),
      itemBuy("20:00:10.000", "test_armor_01", 10, 1),
      shopResponse(
        "20:00:11.000",
        "SCShop_Test_Armor",
        "BuyRequestProcessing",
        "Success",
        "Buying",
      ),
      cargoBuy("20:01:00.000", 100, 100),
      cargoSell("20:02:00.000", 200, 1),
    ]);
    const text = JSON.stringify(j);
    for (const secret of [PILOT, ACCOUNT, SHOP_ID, KIOSK_ID]) expect(text).not.toContain(secret);
  });
});
