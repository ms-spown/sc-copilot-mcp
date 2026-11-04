import { describe, expect, it } from "vitest";
import { buildTradeSection, TRADE_MAX_REFUSALS } from "../../dashboard/tradeRun.js";
import { PRICE_REFUSAL_MAX, priceRefusalsOf } from "./priceRefusals.js";
import { buildTradeJournal, parseCommerceText } from "./trade.js";

/**
 * The game refuses a purchase or a sale whose displayed price moved (TransactionCostMismatch). The refusals are read from
 * the transactions of the trade journal (nothing is parsed twice): invented log lines go through the real parser and
 * journal, and what comes out must hold a time, a side and a kind, and no amount.
 */

const GUID = "5c2e9a41-1111-4222-8333-444444444444";
const at = (s: number) => `<${new Date(Date.UTC(2026, 10, 3, 20, 0, 0) + s * 1000).toISOString()}>`;
const OWNER = "[Team_CoreGameplayFeatures][Shops][UI]";
const ids = "playerId[1111111111] shopId[2222222]";
const buy = (s: number, price = 98765) =>
  `${at(s)} [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> Sending SShopCommodityBuyRequest - ${ids} shopName[SCShop_Cargo_Test] kioskId[3333333] price[${price}.000000] shopPricePerCentiSCU[1.889409] resourceGUID[${GUID}] autoLoading[1] quantity[10000.000000 cSCU] Cargo Box Data: boxSize[32.000000] | unitAmount[20] ${OWNER}`;
const sell = (s: number, amount = 54321) =>
  `${at(s)} [Notice] <CEntityComponentCommodityUIProvider::SendCommoditySellRequest> Sending SShopCommoditySellRequest - ${ids} shopName[SCShop_Cargo_Test] kioskId[3333333] amount[${amount}.000000] resourceGUID[${GUID}] autoLoading[1] quantity[40] transactionMode[CargoGrid] Cargo Box Data:  [boxSize[32] | unitAmount[20]] ${OWNER}`;
const error = (s: number, result: string, type: string) =>
  `${at(s)} [Error] <CEntityComponentCommodityUIProvider::RmToken_CommodityTransactionResponse> Commodity Transaction Response Error - playerId[1111111111] result[${result}] type[${type}] [Team_NAPU][Shops]`;
const itemBuy = (s: number) =>
  `${at(s)} [Notice] <CEntityComponentShopUIProvider::SendShopBuyRequest> Sending SShopBuyRequest - ${ids} shopName[SCShop_Armor] kioskId[3333333] client_price[77777.000000] itemClassGUID[cccccccc-1111-4222-8333-666666666666] itemName[ARMR_Test_Core] quantity[1]  ${OWNER}`;
const itemAnswer = (s: number, result: string) =>
  `${at(s)} [Notice] <CEntityComponentShopUIProvider::RmShopFlowResponse> Received ShopFlowResponse - ${ids} shopName[SCShop_Armor] kioskId[3333333] kioskState[Idle] result[${result}] type[Buying] ${OWNER}`;

const journal = (lines: string[]) =>
  buildTradeJournal(parseCommerceText(lines.join("\n")), `2026-11-04T23:59:59.000Z`).transactions;

describe("Feature: price refusals are read from the journal's transactions", () => {
  it("Given a purchase the game refused because the price moved, Then there is one confirmed event with a time, a side and a kind", () => {
    const events = priceRefusalsOf(
      journal([buy(10), error(10.2, "TransactionCostMismatch", "Buying")]),
    );
    expect(events).toEqual([
      {
        at: new Date(Date.UTC(2026, 10, 3, 20, 0, 10)).toISOString(),
        side: "buy",
        kind: "commodity",
        confidence: "confirmed",
        superseded: false,
      },
    ]);
  });

  it("Given a later transaction of the same side that went through, Then the refusal is superseded (the alert is over)", () => {
    const lines = [
      buy(10),
      error(10.2, "TransactionCostMismatch", "Buying"),
      buy(60), // no error line after it: the journal infers it went through
    ];
    expect(priceRefusalsOf(journal(lines))[0]?.superseded).toBe(true);
    // a purchase that went through does not end the alert of a refused SALE, and an earlier one does not either
    const sale = [buy(5), sell(10), error(10.2, "TransactionCostMismatch", "Selling"), buy(60)];
    expect(priceRefusalsOf(journal(sale))[0]?.superseded).toBe(false);
    const before = [buy(2), buy(10), error(10.2, "TransactionCostMismatch", "Buying")];
    expect(priceRefusalsOf(journal(before))[0]?.superseded).toBe(false);
    // a later refused purchase is not a success
    const again = [
      buy(10),
      error(10.2, "TransactionCostMismatch", "Buying"),
      buy(60),
      error(60.2, "TransactionCostMismatch", "Buying"),
    ];
    expect(priceRefusalsOf(journal(again)).map((e) => e.superseded)).toEqual([false, false]);
  });

  it("Given a refused sale, Then the side is sell", () => {
    const events = priceRefusalsOf(
      journal([sell(5), error(5.25, "TransactionCostMismatch", "Selling")]),
    );
    expect(events.map((e) => [e.side, e.kind, e.confidence])).toEqual([
      ["sell", "commodity", "confirmed"],
    ]);
  });

  it("Given a refused shop item, Then the kind is item", () => {
    const events = priceRefusalsOf(
      journal([itemBuy(5), itemAnswer(5.2, "TransactionCostMismatch")]),
    );
    expect(events.map((e) => [e.side, e.kind])).toEqual([["buy", "item"]]);
  });

  it("Given other errors or a success, Then they are not price refusals", () => {
    const lines = [
      buy(1),
      error(1.1, "InvalidQuantityError", "Buying"),
      sell(20),
      error(20.1, "AutoLoadStartFailed", "Selling"),
      itemBuy(40),
      itemAnswer(40.1, "Success"),
    ];
    expect(priceRefusalsOf(journal(lines))).toEqual([]);
  });

  it("Given one error that follows several requests, Then the refusal is counted ONCE and marked ambiguous", () => {
    const events = priceRefusalsOf(
      journal([buy(10), buy(10.5), buy(11), error(11.3, "TransactionCostMismatch", "Buying")]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ side: "buy", kind: "commodity", confidence: "ambiguous" });
  });

  it("Given two refusals far apart on the same side, Then there are two events, oldest first", () => {
    const events = priceRefusalsOf(
      journal([
        buy(10),
        error(10.2, "TransactionCostMismatch", "Buying"),
        buy(300),
        error(300.2, "TransactionCostMismatch", "Buying"),
      ]),
    );
    expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort());
    expect(events).toHaveLength(2);
  });

  it("Given nothing, undefined or junk, Then there is nothing and nothing throws", () => {
    expect(priceRefusalsOf(undefined)).toEqual([]);
    expect(priceRefusalsOf([])).toEqual([]);
    expect(priceRefusalsOf([null, 3, {}, { status: "failed" }] as never)).toEqual([]);
  });

  it("Given a very long history of refusals, Then only the newest few are kept", () => {
    const lines: string[] = [];
    for (let i = 0; i < 40; i++)
      lines.push(buy(i * 60), error(i * 60 + 0.2, "TransactionCostMismatch", "Buying"));
    const events = priceRefusalsOf(journal(lines));
    expect(events).toHaveLength(PRICE_REFUSAL_MAX);
    expect(events.at(-1)?.at).toBe(
      new Date(Date.UTC(2026, 10, 3, 20, 0, 0) + 39 * 60_000).toISOString(),
    );
  });

  it("Given the events, Then their keys are exactly a time, a side, a kind and a confidence: no amount, shop, item or id", () => {
    const events = priceRefusalsOf(
      journal([
        buy(10, 98765),
        error(10.2, "TransactionCostMismatch", "Buying"),
        itemBuy(50),
        itemAnswer(50.1, "TransactionCostMismatch"),
      ]),
    );
    for (const e of events)
      expect(Object.keys(e).sort()).toEqual(["at", "confidence", "kind", "side", "superseded"]);
    const wire = JSON.stringify(events);
    for (const leak of ["98765", "77777", "SCShop", "ARMR", "5c2e9a41", "1111111111", "2222222"]) {
      expect(wire).not.toContain(leak);
    }
  });
});

describe("Feature: the commerce section carries the refusals, with or without the balance", () => {
  const section = (includeBalance: boolean, lines: string[]) =>
    buildTradeSection({
      transactions: journal(lines),
      history: includeBalance
        ? [
            {
              at: Date.UTC(2026, 10, 3, 19, 59, 0),
              uec: 1_000_000,
              until: Date.UTC(2026, 10, 3, 20, 5, 0),
            },
          ]
        : [],
      includeBalance,
      nowMs: Date.UTC(2026, 10, 3, 20, 10, 0),
    });
  const lines = [buy(10, 98765), error(10.2, "TransactionCostMismatch", "Buying")];

  it("Given a refusal, Then the section lists it identically whether or not the balance was asked for", () => {
    const withBalance = section(true, lines);
    const without = section(false, lines);
    expect(without.price_refusals).toHaveLength(1);
    expect(withBalance.price_refusals).toEqual(without.price_refusals);
  });

  it("Given a refusal and no balance, Then the section holds none of the made-up amounts", () => {
    const wire = JSON.stringify(
      section(false, [
        ...lines,
        sell(60, 54321),
        error(60.2, "TransactionCostMismatch", "Selling"),
      ]),
    );
    expect(wire).not.toContain("98765");
    expect(wire).not.toContain("54321");
  });

  it("Given no refusal, Then the field is absent (the section is what it was)", () => {
    expect("price_refusals" in section(false, [buy(10), sell(20)])).toBe(false);
  });

  it("Given many refusals, Then the payload keeps the newest few", () => {
    const many: string[] = [];
    for (let i = 0; i < 9; i++)
      many.push(buy(i * 60), error(i * 60 + 0.2, "TransactionCostMismatch", "Buying"));
    const s = section(false, many);
    expect(s.price_refusals).toHaveLength(TRADE_MAX_REFUSALS);
  });
});
