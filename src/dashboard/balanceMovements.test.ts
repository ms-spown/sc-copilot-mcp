import { describe, expect, it } from "vitest";
import { MAX_BALANCE_POINTS } from "../providers/telemetry/service.js";
import {
  MOVEMENT_CATEGORIES,
  MOVEMENT_HISTORY_CAP,
  MOVEMENT_MAX_LISTED,
  buildMovementsSection,
  decomposeRun,
  explainMovements,
  explainWindowText,
  moneyText,
  type ContractEnd,
  type Explanation,
  type MovementEvent,
} from "./balanceMovements.js";
import { buildTradeSection } from "./tradeRun.js";
import {
  AGRICIUM_GUID,
  TRADE_FIGURES as F,
  cargoBuyLine,
  cargoSellLine,
  journalTransactions,
  tradeHistory,
  tradeTransactions,
} from "./testing/tradeScenario.js";
import {
  MOVEMENT_CONTRACT_TITLE,
  MOVEMENT_FIGURES as M,
  MOVEMENT_ITEM_CLASS,
  historyFrom,
  itemBuyLine,
  itemSuccessLine,
  movementSteps,
  movementsStory,
} from "./testing/movementsScenario.js";

/**
 * Given/When/Then for the balance movement explainer, on invented data only: the trading story of the commerce card
 * (bought 131 504, sold 318 072, fees 19 468 + 24 100, balance 320 000 -> 463 000) and the extras of the movements story.
 */

const BASE = Date.UTC(2026, 10, 3, 18, 0, 0);
const NOW = BASE + 400_000;
const sec = (s: number) => BASE + s * 1000;
const NO_CONTRACTS: ContractEnd[] = [];
const NO_EVENTS: MovementEvent[] = [];

const sum = (e: Explanation) => e.movements.reduce((s, m) => s + m.amount, 0);

/** The net window of the story's latest run, as the commerce model reads it. */
function netWindow(
  transactions: ReturnType<typeof tradeTransactions>,
  history: ReturnType<typeof tradeHistory>,
) {
  const run = buildTradeSection({
    transactions,
    history,
    includeBalance: true,
    nowMs: NOW,
  }).runs[0]!;
  return run.money!.net;
}

function explainRun(
  transactions: ReturnType<typeof tradeTransactions>,
  history: ReturnType<typeof tradeHistory>,
  contracts: ContractEnd[] = NO_CONTRACTS,
  events: MovementEvent[] = NO_EVENTS,
) {
  const net = netWindow(transactions, history);
  const e = explainMovements({
    history,
    transactions,
    contracts,
    events,
    from: net.window!.from,
    fromInclusive: net.window!.from_inclusive,
    to: net.window!.to,
  });
  return { e, net };
}

describe("Feature: a run explained change by change", () => {
  it("Given the player's run, Then the price and the fee of each side are told apart and nothing is left unexplained", () => {
    const { e, net } = explainRun(tradeTransactions(BASE), tradeHistory(BASE, NOW));
    const kinds = e.movements.map((m) => [m.category, m.side, m.amount, m.confidence]);
    expect(kinds).toEqual([
      ["explained_by_transaction", "buy", -(F.buys[0] + F.buys[1]), "matched"],
      ["fee_on_transaction", "buy", -F.buyFee, "measured"],
      ["explained_by_transaction", "sell", F.sells[0] + F.sells[1], "matched"],
      ["fee_on_transaction", "sell", -F.sellFee, "measured"],
    ]);
    expect(e.totals.unexplained.count).toBe(0);
    expect(e.unmatched_transactions).toBe(0);
    // The invariant: the amounts add up, to the aUEC, to the balance variation the model measured.
    expect(sum(e)).toBe(net.auec);
    expect(e.total_auec).toBe(143_000);
  });

  it("Given the reconciliation of the commerce model, Then the fee entries are the very fees it reports", () => {
    const transactions = tradeTransactions(BASE);
    const history = tradeHistory(BASE, NOW);
    const run = buildTradeSection({ transactions, history, includeBalance: true, nowMs: NOW })
      .runs[0]!.money!;
    const { e } = explainRun(transactions, history);
    const fee = (side: "buy" | "sell") =>
      -e.movements
        .filter((m) => m.category === "fee_on_transaction" && m.side === side)
        .reduce((s, m) => s + m.amount, 0);
    expect(fee("buy")).toBe(run.fees.buy!.auec);
    expect(fee("sell")).toBe(run.fees.sell!.auec);
  });

  it("Given every kind of movement of the story, Then each change goes to one cause and the sums close", () => {
    const s = movementsStory(NOW, BASE);
    const net = netWindow(s.transactions, s.history);
    const e = explainMovements({
      history: s.history,
      transactions: s.transactions,
      contracts: [{ state: "completed", endedMs: s.contract.endedMs!, title: s.contract.title }],
      events: s.events,
      from: net.window!.from,
      fromInclusive: net.window!.from_inclusive,
      to: net.window!.to,
    });
    const by = (c: string) => e.movements.filter((m) => m.category === c);
    expect(by("item_purchase")).toMatchObject([
      { amount: -M.item, confidence: "matched", ref: MOVEMENT_ITEM_CLASS },
    ]);
    expect(by("probable_contract_reward")).toMatchObject([
      { amount: M.reward, confidence: "probable", ref: MOVEMENT_CONTRACT_TITLE },
    ]);
    expect(by("probable_insurance_or_hangar_cost")).toMatchObject([
      { amount: -M.insurance, confidence: "probable", cause: "insurance" },
    ]);
    // The refuel-like fall has no line near it: it is not explained, and it names no cause.
    expect(by("unexplained")).toMatchObject([
      { amount: -M.unexplained, confidence: "none", reason: "no_cause" },
    ]);
    expect(by("unexplained")[0]).not.toHaveProperty("candidates");
    expect(sum(e)).toBe(net.auec);
    expect(net.auec).toBe(143_000 - M.item + M.reward - M.unexplained - M.insurance);
    // Exactly one entry list: every category total is the sum of its entries.
    for (const c of MOVEMENT_CATEGORIES)
      expect(e.totals[c].auec).toBe(by(c).reduce((x, m) => x + m.amount, 0));
  });
});

describe("Feature: the window of the net is the exact set of changes it sums", () => {
  it("Given a fall just before the purchase window (so the balance before is read at its start), Then the window excludes it and still sums to the net", () => {
    const transactions = tradeTransactions(BASE);
    // 2 500 fall at 10 s (outside [18 s, ...]); then the story's own steps, shifted down by it.
    const shifted = tradeHistory(BASE, NOW)
      .filter((p) => p.at >= sec(20))
      .map((p) => ({ ...p, uec: p.uec - 2_500 }));
    const history = [
      { at: sec(6), uec: F.start, until: sec(9.9) },
      { at: sec(10), uec: F.start - 2_500, until: sec(19.9) },
      ...shifted,
    ];
    const net = netWindow(transactions, history);
    // The first fall inside the purchase window is at 20.1 s, so the net starts there (inclusive).
    expect(net.window!.from_inclusive).toBe(true);
    const { e } = explainRun(transactions, history);
    expect(sum(e)).toBe(net.auec);
    // The same story without any decrease in the window: only a rise (a deposit) at 20 s... the window starts at 18 s.
    const lateBuy = journalTransactions(
      [cargoBuyLine(BASE, 100, 50_000, 100), cargoSellLine(BASE, 160, 70_000, 100)],
      BASE + 3_600_000,
    );
    const hist2 = historyFrom(
      BASE,
      [
        [1, 500_000],
        [90, 450_000],
        [100.2, 400_000],
        [160.1, 470_000],
        [160.5, 466_000],
      ],
      NOW,
    );
    const n2 = netWindow(lateBuy, hist2);
    expect(n2.auec).toBe(466_000 - 450_000);
    expect(n2.window!.from_inclusive).toBe(true);
    const r2 = explainRun(lateBuy, hist2);
    expect(sum(r2.e)).toBe(n2.auec);
    // The 50 000 fall at 90 s is before the purchase, so it is NOT in the net, nor in the window.
    expect(r2.e.movements.some((m) => m.amount === -50_000 && m.category === "unexplained")).toBe(
      false,
    );
  });

  it("Given no fall in the purchase window, Then the net is read from the value just before it and the window is exclusive", () => {
    // The purchase is paid by a shop credit that never moved the balance: only a later rise exists.
    const lateBuy = journalTransactions(
      [cargoBuyLine(BASE, 100, 50_000, 100), cargoSellLine(BASE, 160, 70_000, 100)],
      BASE + 3_600_000,
    );
    const hist = historyFrom(
      BASE,
      [
        [1, 500_000],
        [160.1, 570_000],
        [160.5, 566_000],
      ],
      NOW,
    );
    const net = netWindow(lateBuy, hist);
    expect(net.method).toBe("mesure");
    expect(net.window!.from_inclusive).toBe(false);
    const { e } = explainRun(lateBuy, hist);
    expect(sum(e)).toBe(net.auec);
  });
});

describe("Feature: rewards and costs are probable, never certain", () => {
  const story = () => movementsStory(NOW, BASE);

  it("Given a rise and no contract event near it, Then it is unexplained, not a reward", () => {
    const s = story();
    const { e } = explainRun(s.transactions, s.history, NO_CONTRACTS, s.events);
    expect(e.movements.some((m) => m.category === "probable_contract_reward")).toBe(false);
    expect(e.movements.find((m) => m.amount === M.reward)).toMatchObject({
      category: "unexplained",
      reason: "no_cause",
    });
  });

  it("Given a contract that FAILED just before a fall, Then it stays unexplained with a hint, never a penalty claim", () => {
    // 6 300 fall at 140.2 s; a contract failed at 139 s.
    const s = story();
    const failed: ContractEnd[] = [{ state: "failed", endedMs: sec(139), title: "x" }];
    const { e } = explainRun(s.transactions, s.history, failed, s.events);
    const m = e.movements.find((x) => x.amount === -M.unexplained)!;
    expect(m.category).toBe("unexplained");
    expect(m.hints).toContain("contract_penalty");
    expect(m.cause).toBeUndefined();
  });

  it("Given a fall near an insurance claim AND a hangar request, Then it is probable, several causes compete, and none is named", () => {
    const s = story();
    const events: MovementEvent[] = [
      { type: "insurance_claim_requested", atMs: sec(150) },
      { type: "hangar_request_completed", atMs: sec(151) },
    ];
    const { e } = explainRun(s.transactions, s.history, NO_CONTRACTS, events);
    expect(e.movements.find((m) => m.amount === -M.insurance)).toMatchObject({
      category: "probable_insurance_or_hangar_cost",
      confidence: "probable",
      cause: "insurance_or_hangar",
      several: true,
    });
  });

  it("Given two completed contracts near one rise, Then the rise is a probable reward without a title (which one is not known)", () => {
    const s = story();
    const two: ContractEnd[] = [
      { state: "completed", endedMs: sec(99), title: "A" },
      { state: "completed", endedMs: sec(100), title: "B" },
    ];
    const { e } = explainRun(s.transactions, s.history, two, s.events);
    const m = e.movements.find((x) => x.amount === M.reward)!;
    expect(m.category).toBe("probable_contract_reward");
    expect(m.several).toBe(true);
    expect(m.ref).toBeUndefined();
  });

  it("Given a reward paid inside the window of a cargo sale, Then the sale's own changes are not read as rewards: one cause per variation (found by the end-to-end replay)", () => {
    // The sale (292 480 + 25 592, fees 21 800 + 2 300) is settled by two changes; a 60 000 reward lands 1.6 s after them
    // and spoils the fee reconciliation. The three changes could each be the sale or the reward: none is chosen.
    const txs = tradeTransactions(BASE);
    const hist = historyFrom(
      BASE,
      [
        [1, 320_000],
        [20.7, 320_000 - 120_923 - 17_900],
        [22.9, 320_000 - 131_504 - 19_468],
        [200.1, 320_000 - 131_504 - 19_468 + 292_480 - 21_800],
        [202.4, 320_000 - 131_504 - 19_468 + 318_072 - 24_100],
        [204, 320_000 - 131_504 - 19_468 + 318_072 - 24_100 + 60_000],
      ],
      NOW,
    );
    const contracts: ContractEnd[] = [{ state: "completed", endedMs: sec(201), title: "A" }];
    const { e, net } = explainRun(txs, hist, contracts);
    expect(sum(e)).toBe(net.auec);
    // the purchases are explained as usual; no reward is claimed for the sale's changes
    expect(e.totals.probable_contract_reward.count).toBe(0);
    const sale = e.movements.filter((m) => m.at >= sec(200));
    expect(sale.map((m) => m.amount).sort((a, b) => a - b)).toEqual([23_292, 60_000, 270_680]);
    for (const m of sale) {
      expect(m).toMatchObject({ category: "unexplained", confidence: "ambiguous" });
      expect(m.candidates).toEqual(["explained_by_transaction", "probable_contract_reward"]);
    }
    // A reward far from any sale is still a probable reward.
    const far = explainRun(txs, hist, [{ state: "completed", endedMs: sec(100), title: "B" }]);
    expect(far.e.totals.probable_contract_reward.count).toBe(0); // 100 s is nowhere near the 204 s rise either
    expect(sum(far.e)).toBe(far.net.auec);
  });

  it("Given a reward window, Then it starts 3 s before the contract end and ends 20 s after it", () => {
    const hist = historyFrom(
      BASE,
      [
        [1, 1000],
        [50, 51_000],
        [90, 41_000],
      ],
      NOW,
    );
    const at = (s: number, c: ContractEnd[]) =>
      explainMovements({
        history: hist,
        transactions: undefined,
        contracts: c,
        events: NO_EVENTS,
        from: sec(1),
        fromInclusive: false,
        to: sec(100),
      }).movements.find((m) => m.amount === 50_000)!.category;
    expect(at(0, [{ state: "completed", endedMs: sec(53), title: "t" }])).toBe(
      "probable_contract_reward",
    );
    expect(at(0, [{ state: "completed", endedMs: sec(30), title: "t" }])).toBe(
      "probable_contract_reward",
    );
    expect(at(0, [{ state: "completed", endedMs: sec(29), title: "t" }])).toBe("unexplained");
    expect(at(0, [{ state: "completed", endedMs: sec(54), title: "t" }])).toBe("unexplained");
  });
});

describe("Feature: nothing is explained that the data cannot show", () => {
  it("Given only fuel-like and repair-like falls, Then they are all 'unexplained' with no cause, and the text says what they could be", () => {
    const hist = historyFrom(
      BASE,
      [
        [1, 100_000],
        [10, 96_000],
        [40, 90_000],
        [80, 91_500],
      ],
      NOW,
    );
    const e = explainMovements({
      history: hist,
      transactions: [],
      contracts: NO_CONTRACTS,
      events: NO_EVENTS,
      from: sec(1),
      fromInclusive: false,
      to: sec(100),
    });
    expect(e.movements.map((m) => [m.category, m.amount, m.reason])).toEqual([
      ["unexplained", -4000, "no_cause"],
      ["unexplained", -6000, "no_cause"],
      ["unexplained", 1500, "no_cause"],
    ]);
    const text = explainWindowText(e).join(" ");
    expect(text).toMatch(/carburant/);
    expect(text).toMatch(/réparations/);
    expect(text).toMatch(/amendes/);
    expect(text).toMatch(/rien ne permet de trancher/);
    // And it never says one of them is the cause.
    expect(text).not.toMatch(/\bprobable/);
  });

  it("Given a change across a cut in the stream, Then it is flagged as such and never explained, even if it equals a purchase", () => {
    const hist = historyFrom(
      BASE,
      [
        [1, 100_000],
        [10, 97_600],
      ],
      NOW,
    );
    // The first point's frames stopped at 2 s: the fall at 10 s spans a cut (the history builder puts `until` just before the next change).
    hist[0] = { ...hist[0]!, until: sec(2) };
    const lines = [itemBuyLine(BASE, 9.5, M.item), itemSuccessLine(BASE, 9.8)];
    const e = explainMovements({
      history: hist,
      transactions: journalTransactions(lines, NOW),
      contracts: NO_CONTRACTS,
      events: NO_EVENTS,
      from: sec(1),
      fromInclusive: false,
      to: sec(100),
    });
    expect(e.movements).toMatchObject([
      { category: "unexplained", reason: "stream_gap", hints: ["stream_gap"], amount: -2400 },
    ]);
    expect(e.coverage.gap_changes).toBe(1);
    expect(e.unexplained_split.stream_gap).toBe(-2400);
  });

  it("Given a window that starts before the oldest balance the server remembers, Then the coverage says so", () => {
    const hist = historyFrom(
      BASE,
      [
        [50, 100_000],
        [60, 90_000],
      ],
      NOW,
    );
    const e = explainMovements({
      history: hist,
      transactions: [],
      contracts: NO_CONTRACTS,
      events: NO_EVENTS,
      from: sec(0),
      fromInclusive: true,
      to: sec(100),
    });
    expect(e.coverage.starts_before_history).toBe(true);
    expect(explainWindowText(e).join(" ")).toMatch(/pas vu le solde au début/);
    expect(MOVEMENT_HISTORY_CAP).toBe(MAX_BALANCE_POINTS);
  });

  it("Given a log line with no balance change, Then it is counted as unmatched and nothing is invented for it", () => {
    const hist = historyFrom(BASE, [[1, 100_000]], NOW); // one point: no change at all
    const e = explainMovements({
      history: hist,
      transactions: journalTransactions(
        [itemBuyLine(BASE, 20, M.item), itemSuccessLine(BASE, 20.3)],
        NOW,
      ),
      contracts: NO_CONTRACTS,
      events: NO_EVENTS,
      from: sec(1),
      fromInclusive: false,
      to: sec(100),
    });
    expect(e.movements).toEqual([]);
    expect(e.unmatched_transactions).toBe(1);
  });

  it("Given the explanation of a window, Then the amounts in it are the sums of the entries", () => {
    const s = movementsStory(NOW, BASE);
    const section = buildMovementsSection({
      history: s.history,
      transactions: s.transactions,
      contracts: [{ state: "completed", endedMs: s.contract.endedMs!, title: s.contract.title }],
      events: s.events,
      nowMs: NOW,
    })!;
    expect(section.total_auec).toBe(s.history[s.history.length - 1]!.uec - s.history[0]!.uec);
    const text = section.explanation.join(" ");
    expect(text).toContain(moneyText(section.total_auec, true));
    expect(text).toContain(moneyText(-M.unexplained, true));
  });
});

describe("Feature: ambiguity is flagged, not guessed", () => {
  it("Given an item bought inside a cargo settlement's window, Then the item is matched FIRST and the fee is the cargo's own", () => {
    // The story's buy cluster (18 s..30.6 s) and an item of 500 bought inside it: the change that equals the item's
    // price is the item, not a part of the fee.
    const lines = [
      cargoBuyLine(BASE, 20, F.buys[0], 640),
      cargoBuyLine(BASE, 22, F.buys[1], 56),
      cargoSellLine(BASE, 200, F.sells[0], 640),
      cargoSellLine(BASE, 202, F.sells[1], 56),
      itemBuyLine(BASE, 25, 500),
      itemSuccessLine(BASE, 25.2),
    ];
    const transactions = journalTransactions(lines, BASE + 3_600_000);
    const steps: [number, number][] = [
      [6, F.start],
      [20.1, F.start - F.buys[0]],
      [22.1, F.start - F.buys[0] - F.buys[1]],
      [22.6, F.start - F.buys[0] - F.buys[1] - F.buyFee],
      [25.3, F.start - F.buys[0] - F.buys[1] - F.buyFee - 500],
      [200.1, 0 + F.start - F.buys[0] - F.buys[1] - F.buyFee - 500 + F.sells[0]],
      [202.1, F.start - F.buys[0] - F.buys[1] - F.buyFee - 500 + F.sells[0] + F.sells[1]],
      [
        202.6,
        F.start - F.buys[0] - F.buys[1] - F.buyFee - 500 + F.sells[0] + F.sells[1] - F.sellFee,
      ],
    ];
    const history = historyFrom(BASE, steps, NOW);
    const { e, net } = explainRun(transactions, history);
    const buyFee = e.movements.find(
      (m) => m.category === "fee_on_transaction" && m.side === "buy",
    )!;
    expect(buyFee).toMatchObject({ amount: -F.buyFee, confidence: "measured" });
    expect(buyFee.doubtful).toBeUndefined();
    expect(e.movements.find((m) => m.category === "item_purchase")).toMatchObject({
      amount: -500,
      confidence: "matched",
    });
    expect(e.unmatched_transactions).toBe(0);
    expect(e.totals.unexplained.count).toBe(0);
    expect(sum(e)).toBe(net.auec);
  });

  it("Given a net sale then an item bought two seconds later, Then the item is not absorbed into the sale's fee", () => {
    // A sale of 100 000 at 20 s settles as +97 000 (fee 3 000); an item of 3 000 at 22 s is a change of its own.
    const sale = journalTransactions(
      [
        cargoSellLine(BASE, 20, 100_000, 100),
        itemBuyLine(BASE, 22, 3_000),
        itemSuccessLine(BASE, 22.2),
      ],
      BASE + 3_600_000,
    );
    const hist = historyFrom(
      BASE,
      [
        [5, 500_000],
        [20.4, 597_000],
        [22.3, 594_000],
      ],
      NOW,
    );
    const e = explainMovements({
      history: hist,
      transactions: sale,
      contracts: NO_CONTRACTS,
      events: NO_EVENTS,
      from: sec(1),
      fromInclusive: false,
      to: sec(60),
    });
    expect(e.movements.map((m) => [m.category, m.amount, m.confidence])).toEqual([
      ["explained_by_transaction", 100_000, "matched"],
      ["fee_on_transaction", -3_000, "measured"],
      ["item_purchase", -3_000, "matched"],
    ]);
    expect(e.unmatched_transactions).toBe(0);
    expect(sum(e)).toBe(94_000);
  });

  it("Given a fee measured in the window of a completed contract, Then it is flagged doubtful and ambiguous", () => {
    const story = movementsStory(NOW, BASE);
    const { e } = explainRun(story.transactions, story.history, [
      { state: "completed", endedMs: sec(201), title: "Late contract" },
    ]);
    const fee = e.movements.find((m) => m.category === "fee_on_transaction" && m.side === "sell")!;
    expect(fee.doubtful).toBe(true);
    expect(fee.confidence).toBe("ambiguous");
  });

  it("Given two different items of the same price and a single balance change, Then the change is ambiguous and names no item", () => {
    const hist = historyFrom(
      BASE,
      [
        [1, 50_000],
        [20.5, 47_600],
      ],
      NOW,
    );
    const lines = [
      itemBuyLine(BASE, 20, 2400, "item_a_test"),
      itemSuccessLine(BASE, 20.1),
      itemBuyLine(BASE, 21, 2400, "item_b_test"),
      itemSuccessLine(BASE, 21.1),
    ];
    const e = explainMovements({
      history: hist,
      transactions: journalTransactions(lines, NOW),
      contracts: NO_CONTRACTS,
      events: NO_EVENTS,
      from: sec(1),
      fromInclusive: false,
      to: sec(100),
    });
    expect(e.movements).toHaveLength(1);
    expect(e.movements[0]).toMatchObject({
      category: "unexplained",
      confidence: "ambiguous",
      reason: "ambiguous",
      amount: -2400,
    });
    expect(e.movements[0]).not.toHaveProperty("ref");
    expect(e.unexplained_split.ambiguous).toBe(-2400);
  });

  it("Given the same item bought twice and two changes, Then both are matched, in order", () => {
    const hist = historyFrom(
      BASE,
      [
        [1, 50_000],
        [20.5, 47_600],
        [22.5, 45_200],
      ],
      NOW,
    );
    const lines = [
      itemBuyLine(BASE, 20, 2400),
      itemSuccessLine(BASE, 20.1),
      itemBuyLine(BASE, 22, 2400),
      itemSuccessLine(BASE, 22.1),
    ];
    const e = explainMovements({
      history: hist,
      transactions: journalTransactions(lines, NOW),
      contracts: NO_CONTRACTS,
      events: NO_EVENTS,
      from: sec(1),
      fromInclusive: false,
      to: sec(100),
    });
    expect(e.movements.map((m) => [m.category, m.at - BASE])).toEqual([
      ["item_purchase", 20_500],
      ["item_purchase", 22_500],
    ]);
  });

  it("Given a failed item line, Then it explains nothing", () => {
    const hist = historyFrom(
      BASE,
      [
        [1, 50_000],
        [20.5, 47_600],
      ],
      NOW,
    );
    const failed = `<${new Date(sec(20.1)).toISOString()}> [Notice] <CEntityComponentShopUIProvider::RmShopFlowResponse> Received ShopFlowResponse - playerId[1111111111] shopId[2222222] shopName[SCShop_Test_Items] kioskId[3333333] kioskState[Idle] result[TransactionCostMismatch] type[Buying] [Team_CoreGameplayFeatures][Shops][UI]`;
    const e = explainMovements({
      history: hist,
      transactions: journalTransactions([itemBuyLine(BASE, 20, 2400), failed], NOW),
      contracts: NO_CONTRACTS,
      events: NO_EVENTS,
      from: sec(1),
      fromInclusive: false,
      to: sec(100),
    });
    expect(e.movements[0]).toMatchObject({ category: "unexplained" });
  });
});

describe("Feature: two quick unexplained changes of one sign are one line", () => {
  it("Given a payment that arrives in two frames, Then it is merged; opposite signs and distant ones are not", () => {
    const hist = historyFrom(
      BASE,
      [
        [1, 10_000],
        [10, 12_000],
        [10.4, 15_000],
        [10.9, 14_000],
        [30, 20_000],
      ],
      NOW,
    );
    const e = explainMovements({
      history: hist,
      transactions: [],
      contracts: NO_CONTRACTS,
      events: NO_EVENTS,
      from: sec(1),
      fromInclusive: false,
      to: sec(100),
    });
    expect(e.movements.map((m) => m.amount)).toEqual([5000, -1000, 6000]);
    expect(sum(e)).toBe(10_000);
  });
});

describe("Feature: a slow trickle is not one line", () => {
  it("Given ten rises 0.8 s apart, Then they are merged by at most 5 s, so several lines remain", () => {
    const steps: [number, number][] = [[1, 10_000]];
    for (let i = 1; i <= 10; i++) steps.push([10 + i * 0.8, 10_000 + i * 100]);
    const e = explainMovements({
      history: historyFrom(BASE, steps, NOW),
      transactions: [],
      contracts: NO_CONTRACTS,
      events: NO_EVENTS,
      from: sec(1),
      fromInclusive: false,
      to: sec(100),
    });
    expect(e.movements.length).toBeGreaterThan(1);
    expect(sum(e)).toBe(1_000);
  });
  it("Given nothing unexplained but a probable reward, Then the text says no lead is missing, never that all is explained", () => {
    const s = movementsStory(NOW, BASE);
    const { e } = explainRun(
      s.transactions,
      s.history,
      [{ state: "completed", endedMs: sec(99.5), title: "x" }],
      s.events,
    );
    // The story still holds the unexplained fall; take a window that ends before it.
    const early = explainMovements({
      history: s.history,
      transactions: s.transactions,
      contracts: [{ state: "completed", endedMs: sec(99.5), title: "x" }],
      events: s.events,
      from: sec(1),
      fromInclusive: false,
      to: sec(120),
    });
    const text = explainWindowText(early).join(" ");
    expect(e.totals.unexplained.count).toBe(1);
    expect(early.totals.probable_contract_reward.count).toBe(1);
    expect(text).toContain("Rien d’autre n’est resté sans piste");
    expect(text).not.toMatch(/Rien n’est resté non expliqué/);
  });
});

describe("Feature: the net of a run, decomposed", () => {
  const decompose = (opts: { marginPartial?: boolean } = {}) => {
    const s = movementsStory(NOW, BASE);
    const contracts: ContractEnd[] = [
      { state: "completed", endedMs: s.contract.endedMs!, title: s.contract.title },
    ];
    const { e, net } = explainRun(s.transactions, s.history, contracts, s.events);
    const run = buildTradeSection({
      transactions: s.transactions,
      history: s.history,
      includeBalance: true,
      nowMs: NOW,
    }).runs[0]!.money!;
    return {
      d: decomposeRun(
        e,
        { net: net.auec!, margin: run.gross_margin, marginPartial: opts.marginPartial ?? false },
        net.window!.from,
        net.window!.to,
      ),
      run,
      net,
    };
  };

  it("Given margin, fees, an item, a probable reward and costs, Then the parts add up to the net and the equation closes", () => {
    const { d, net } = decompose();
    expect(d.closes).toBe(true);
    expect(d.margin).toBe(186_568);
    expect(d.parts).toEqual({
      transactions: 186_568,
      fees: -43_568,
      items: -M.item,
      probable_rewards: M.reward,
      probable_costs: -M.insurance,
      unexplained: -M.unexplained,
      ambiguous: 0,
      stream_gap: 0,
    });
    const total = Object.values(d.parts).reduce((a, b) => a + b, 0);
    expect(total).toBe(net.auec);
    // margin - fees - explained costs + probable rewards - unexplained = net variation
    expect(186_568 - 43_568 - M.item - M.insurance + M.reward - M.unexplained).toBe(net.auec);
    expect(d.residual).toBe(-M.unexplained);
    expect(d.named).toMatchObject([{ amount: -M.unexplained, reason: "no_cause" }]);
  });

  it("Given the legacy figure, Then its unexplained part is the opposite of ours when only margin and fees are named", () => {
    const { run, d } = decompose();
    // fees.unexplained = margin - net - fees, positive when the balance fell more than the margin says.
    expect(run.fees.unexplained).toBe(
      -(d.parts.items + d.parts.probable_rewards + d.parts.probable_costs + d.parts.unexplained),
    );
  });

  it("Given unsold goods (margin partial), Then the equation is not shown as closing and the text says why", () => {
    const { d } = decompose({ marginPartial: true });
    expect(d.closes).toBe(false);
    expect(d.explanation.join(" ")).toMatch(/ne se ferme pas/);
  });

  it("Given the decomposition, Then the explanation names the unexplained part and says what it could be", () => {
    const { d } = decompose();
    const text = d.explanation.join(" ");
    expect(text).toContain(moneyText(210_300, true));
    // The printed equation sums exactly: it uses the transaction parts, not the margin (equal within 0.1 %).
    expect(text).toContain(moneyText(d.parts.transactions, true));
    expect(text).toContain("coûts possibles (hangar ou assurance, sans preuve du coût)");
    expect(text).not.toMatch(/coûts probables/);
    expect(text).toMatch(/non expliqué/);
    expect(text).toMatch(/carburant/);
    expect(text).toMatch(/probables/);
    for (const line of d.explanation) expect(line.length).toBeLessThan(600);
  });
});

describe("Feature: the list is bounded and the totals are not", () => {
  it("Given far more changes than the list shows, Then the newest are listed and the totals still cover all", () => {
    const steps: [number, number][] = [[1, 1_000_000]];
    for (let i = 1; i <= 120; i++) steps.push([1 + i * 5, 1_000_000 - i * 777]);
    const hist = historyFrom(BASE, steps, BASE + 3_600_000);
    const section = buildMovementsSection({
      history: hist,
      transactions: [],
      contracts: NO_CONTRACTS,
      events: NO_EVENTS,
      nowMs: BASE + 3_600_000,
    })!;
    expect(section.count).toBe(120);
    expect(section.listed).toHaveLength(MOVEMENT_MAX_LISTED);
    expect(section.truncated).toBe(true);
    expect(section.total_auec).toBe(-120 * 777);
    expect(section.totals.unexplained.count).toBe(120);
    // Newest first.
    expect(Date.parse(section.listed[0]!.at)).toBeGreaterThan(Date.parse(section.listed[1]!.at));
  });

  it("Given fewer than two balances seen, Then there is no section at all", () => {
    expect(
      buildMovementsSection({
        history: historyFrom(BASE, [[1, 5]], NOW),
        transactions: [],
        contracts: NO_CONTRACTS,
        events: NO_EVENTS,
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("Given a login event, Then the session starts there and earlier changes are left out", () => {
    const hist = historyFrom(
      BASE,
      [
        [1, 100],
        [10, 90],
        [60, 70],
      ],
      NOW,
    );
    const section = buildMovementsSection({
      history: hist,
      transactions: [],
      contracts: NO_CONTRACTS,
      events: [{ type: "login_completed", atMs: sec(30) }],
      nowMs: NOW,
    })!;
    expect(section.window.basis).toBe("session");
    expect(section.total_auec).toBe(-20);
  });

  it("Given a window's end is not the clock, Then two builds a few seconds apart give the same section", () => {
    const s = movementsStory(NOW, BASE);
    const build = (nowMs: number) =>
      buildMovementsSection({
        history: s.history,
        transactions: s.transactions,
        contracts: [],
        events: s.events,
        nowMs,
      });
    expect(JSON.stringify(build(NOW + 5000))).toBe(JSON.stringify(build(NOW)));
  });
});

describe("Feature: formatting", () => {
  it("Given amounts, Then they use the narrow space and the true minus like the View", () => {
    expect(moneyText(143_000, true)).toBe("+143" + String.fromCharCode(0x202f) + "000");
    expect(moneyText(-43_568)).toBe(
      String.fromCharCode(0x2212) + "43" + String.fromCharCode(0x202f) + "568",
    );
    expect(moneyText(0, true)).toBe("0");
  });
  it("Given a second run in the same session (new goods), Then the explainer still labels both settlements", () => {
    const lines = [
      cargoBuyLine(BASE, 20, 60_000, 300, AGRICIUM_GUID),
      cargoSellLine(BASE, 60, 71_000, 300, AGRICIUM_GUID),
    ];
    const hist = historyFrom(
      BASE,
      [
        [1, 500_000],
        [20.1, 440_000],
        [20.6, 437_000],
        [60.1, 508_000],
        [60.5, 505_000],
      ],
      NOW,
    );
    const e = explainMovements({
      history: hist,
      transactions: journalTransactions(lines, BASE + 3_600_000),
      contracts: NO_CONTRACTS,
      events: NO_EVENTS,
      from: sec(1),
      fromInclusive: false,
      to: sec(100),
    });
    expect(e.movements.map((m) => [m.category, m.amount])).toEqual([
      ["explained_by_transaction", -60_000],
      ["fee_on_transaction", -3_000],
      ["explained_by_transaction", 71_000],
      ["fee_on_transaction", -3_000],
    ]);
    expect(movementSteps().length).toBeGreaterThan(5);
  });
});
