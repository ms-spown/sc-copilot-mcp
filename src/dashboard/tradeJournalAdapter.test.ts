import { describe, expect, it } from "vitest";
import {
  fromJournalTransaction,
  tradeSourceFrom,
  type JournalTransaction,
} from "./tradeJournalAdapter.js";
import { buildTradeSection } from "./tradeRun.js";

/** The shape below is the one of `Transaction` in the trade journal (pull request 45), hand-made. */
const base: JournalTransaction = {
  time: "2026-11-03T18:00:20.000Z",
  kind: "commodity",
  side: "buy",
  status: "completed",
  confidence: "confirmed",
  shop: "TDD_Area18",
  total_auec: 120_923,
  currency: "aUEC",
  quantity: 640,
  unit: "SCU",
  commodity_id: "a1b2c3d4",
  auto_loading: true,
};

describe("Feature: the journal's transactions feed the commerce model", () => {
  it("Given a completed cargo buy, Then it maps field by field", () => {
    expect(fromJournalTransaction(base)).toEqual({
      at: base.time,
      side: "buy",
      kind: "commodity",
      total_auec: 120_923,
      quantity: 640,
      unit: "SCU",
      commodity: "a1b2c3d4",
      shop: "TDD_Area18",
      auto_loading: true,
      outcome: "success",
      confidence: "logged",
    });
  });

  it("Given failed, unconfirmed and ambiguous lines, Then the outcome and the confidence say so", () => {
    expect(fromJournalTransaction({ ...base, status: "failed" })!.outcome).toBe("failed");
    expect(
      fromJournalTransaction({ ...base, status: "unconfirmed", confidence: "unknown" }),
    ).toMatchObject({
      outcome: "unknown",
      confidence: "inferred",
    });
    expect(fromJournalTransaction({ ...base, confidence: "ambiguous" })!.confidence).toBe(
      "inferred",
    );
  });

  it("Given an item line, Then it keeps no SCU quantity; given another currency on cargo, Then it is dropped", () => {
    const item = fromJournalTransaction({ ...base, kind: "item", unit: "item", quantity: 2 })!;
    expect(item).toMatchObject({ kind: "item", quantity: null, unit: null });
    expect(fromJournalTransaction({ ...base, currency: "REC" })).toBeNull();
  });

  it("Given a journal with a missing autoload flag, Then it is not claimed", () => {
    const { auto_loading: _omit, ...without } = base;
    void _omit;
    expect(fromJournalTransaction(without)!.auto_loading).toBe(false);
    expect(fromJournalTransaction({ ...base, auto_loading: null })!.auto_loading).toBe(false);
  });

  it("Given a source over the journal, Then the model builds a run from it", () => {
    const journal: JournalTransaction[] = [
      base,
      { ...base, time: "2026-11-03T18:03:20.000Z", side: "sell", total_auec: 292_480 },
      { ...base, kind: "item", unit: "item", time: "2026-11-03T18:01:00.000Z" },
    ];
    const txs = tradeSourceFrom(() => journal)();
    expect(txs).toHaveLength(3);
    const section = buildTradeSection({
      transactions: txs,
      history: [],
      includeBalance: true,
      nowMs: Date.UTC(2026, 10, 3, 19),
    });
    expect(section.runs[0]).toMatchObject({ stage: "complete", buys: 1, sells: 1, ignored: 1 });
    expect(section.runs[0]!.money!.gross_margin).toBe(292_480 - 120_923);
  });
});
