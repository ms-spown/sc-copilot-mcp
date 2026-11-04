import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GameLog } from "../providers/gamelog/reader.js";
import { LedgerService, ledgerLogFrom } from "./ledgerService.js";
import { tradeLines } from "./testing/tradeScenario.js";
import type { Telemetry } from "../providers/telemetry/index.js";
import { PLAN_PRICE_POINTS_MAX } from "./constants.js";
import { parsePlan } from "./plan.js";
import { DashboardService } from "./service.js";
import { tradeHistory, tradeTransactions } from "./testing/tradeScenario.js";
import { tradeApplySuggestion, tradeSuggestionText } from "./tradeActions.js";
import * as L from "./viewLogic.js";

/**
 * The commerce section inside the poll answer: no amount without the balance, the history not even requested, the
 * plan extended and cleaned on both sides, and the seam for the action bar.
 */

const EPOCH = Date.UTC(2026, 10, 3, 18, 0, 0);
const NOW = EPOCH + 400_000;
const MEASURED = /(?<![\d.])(131504|318072|186568|143000|463000|320000|43568|136432)(?!\d)/;

function stubTelemetry(): Telemetry & { balanceHistory: ReturnType<typeof vi.fn> } {
  const state = {
    ship: null,
    weapons: null,
    pilot: { uec_balance: 463_000, health: { current: 100, max: 100 }, unverified: {} },
    conditions: [],
    derived: {},
    game_events: [],
    broken: [],
    countermeasure_burst: {},
  };
  return {
    enabled: true,
    status: vi.fn(async () => ({
      state: "live",
      cause: "Frames are arriving.",
      frames_received: 10,
      frames_rejected: 0,
      reconnects: 0,
      unknown_fields: [],
      anomalies: [],
      not_in_stream: [],
      idle_stop_ms: 0,
    })),
    snapshot: vi.fn(async () => ({
      state,
      frame_age_ms: 20,
      received_at: new Date(NOW).toISOString(),
      uec_session: {
        start: 320_000,
        current: 463_000,
        delta: 143_000,
        since: new Date(EPOCH).toISOString(),
      },
    })),
    events: vi.fn(async () => ({ events: [], last_seq: 0 })),
    resetUecDelta: vi.fn(async () => undefined),
    balanceHistory: vi.fn(async () => tradeHistory(EPOCH, NOW)),
    stop: vi.fn(async () => undefined),
  } as unknown as Telemetry & { balanceHistory: ReturnType<typeof vi.fn> };
}

const service = (telemetry: Telemetry, withJournal = true) =>
  new DashboardService(
    telemetry,
    () => NOW,
    undefined,
    undefined,
    undefined,
    withJournal ? () => tradeTransactions(EPOCH) : undefined,
  );

describe("Feature: the commerce section of the poll", () => {
  it("Given a journal and the balance NOT asked, Then the run has no amount and the history is not requested", async () => {
    const telemetry = stubTelemetry();
    const s = service(telemetry);
    s.setPlan({ expected_profit_auec: 180_000, scu: 696, sell_unit_price: 457 });
    const poll = await s.poll({ includeBalance: false });
    const wire = JSON.stringify(poll);
    expect(poll.ledger!.trade!.source).toBe("journal");
    expect(poll.ledger!.trade!.runs[0]).not.toHaveProperty("money");
    expect(wire).not.toMatch(MEASURED);
    expect(wire).not.toContain("180000"); // the plan is not echoed by the poll
    expect(telemetry.balanceHistory).not.toHaveBeenCalled();
    expect(poll).not.toHaveProperty("balance");
  });

  it("Given the balance asked, Then the run carries its money, and a View that did not ask never shares its hash", async () => {
    const s = service(stubTelemetry());
    s.setPlan({
      expected_profit_auec: 180_000,
      scu: 696,
      sell_unit_price: 457,
      commodity: "Laranite",
    });
    const withBalance = await s.poll({ includeBalance: true });
    const without = await s.poll({ includeBalance: false });
    const money = withBalance.ledger!.trade!.runs[0]!.money!;
    expect(money.net).toMatchObject({ auec: 143_000, method: "mesure" });
    expect(money.fees.total).toBe(43_568);
    expect(money.planned_net?.auec).toBe(136_432);
    expect(withBalance.hash!.ledger).not.toBe(without.hash!.ledger);
    // A View that asked without the balance and holds the other hash still receives the plain version.
    const tailored = await s.poll({
      includeBalance: false,
      have: { ledger: withBalance.hash!.ledger },
    });
    expect(tailored.ledger).toBeDefined();
    expect(JSON.stringify(tailored)).not.toMatch(MEASURED);
  });

  it("Given no journal is wired (production today), Then there is no trade section at all", async () => {
    const poll = await service(stubTelemetry(), false).poll({ includeBalance: true });
    expect(poll.ledger).toBeDefined();
    expect(poll.ledger).not.toHaveProperty("trade");
  });
});

describe("Feature: the plan carries prices, a trip estimate and a price curve", () => {
  it("Given the new fields, Then they are kept, rounded and bounded", () => {
    const plan = parsePlan({
      commodity: "Laranite",
      expected_profit_auec: 180_000.4,
      buy_unit_price: 189.4,
      sell_unit_price: 457,
      est_trip_minutes: 25.2,
      safety_note: "  Peu\u200b risquée  ",
      price_points: [
        430,
        436.456,
        NaN,
        "x",
        -1,
        Infinity,
        ...Array.from({ length: 60 }, (_, i) => 400 + i),
      ],
      price_points_for: "buy",
      price_points_label: "7 jours",
      secret: "dropped",
    })!;
    expect(plan).toMatchObject({
      expected_profit_auec: 180_000,
      buy_unit_price: 189,
      sell_unit_price: 457,
      est_trip_minutes: 25,
      safety_note: "Peu risquée",
      price_points_for: "buy",
      price_points_label: "7 jours",
    });
    expect(plan.price_points!.length).toBe(PLAN_PRICE_POINTS_MAX);
    expect(plan.price_points!.every((p) => Number.isFinite(p) && p >= 0)).toBe(true);
    expect(plan.price_points!.at(-1)).toBe(459); // the newest points are kept
    expect(plan).not.toHaveProperty("secret");
  });

  it("Given fewer than two usable points, Then there is no curve and no label for it", () => {
    const plan = parsePlan({
      commodity: "X",
      price_points: [5, NaN],
      price_points_label: "7 jours",
    })!;
    expect(plan).not.toHaveProperty("price_points");
    expect(plan).not.toHaveProperty("price_points_label");
  });

  it("Given a negative or zero price, Then it is dropped, never kept as a price", () => {
    expect(
      parsePlan({ buy_unit_price: -3, sell_unit_price: 0, est_trip_minutes: 0 }),
    ).toBeUndefined();
  });

  it("Given the same input, Then the server's and the page's cleaners agree on the new fields", () => {
    const input = {
      commodity: "Laranite",
      expected_profit_auec: 180_000,
      buy_unit_price: 189.4,
      sell_unit_price: 457,
      est_trip_minutes: 25,
      safety_note: "Route calme",
      price_points: [430, 436.456, 441, 450],
      price_points_for: "sell",
      price_points_label: "7 jours",
    };
    const server = parsePlan(input)!;
    const page = L.cleanPlan(input);
    for (const key of Object.keys(server) as (keyof typeof server)[]) {
      expect(page[key], key).toEqual(server[key]);
    }
    // The page re-cleans what came through the model: hostile values do not survive there either.
    const hostile = L.cleanPlan({
      ...input,
      price_points: Array.from({ length: 90 }, () => 1),
      sell_unit_price: -2,
    });
    expect(hostile.price_points).toHaveLength(30);
    expect(hostile).not.toHaveProperty("sell_unit_price");
  });
});

describe("Feature: the seam for the action bar", () => {
  const suggestion = {
    commodity: "Agricium",
    buy_terminal: "Port Tressler",
    sell_terminal: "Area18 TDD",
    scu: 96,
    buy_unit_price: 25,
    sell_unit_price: 27,
    expected_profit_auec: 190_000,
    est_trip_minutes: 22,
    safety_note: "Zone calme",
    price_points: [26, 27, 27.5],
  };

  it("Given a suggested route, Then applying it as the active plan is the plan cleaner, nothing else", () => {
    expect(tradeApplySuggestion(L, suggestion)).toEqual(L.cleanPlan(suggestion));
    expect(tradeApplySuggestion(L, suggestion)).toMatchObject({
      commodity: "Agricium",
      est_trip_minutes: 22,
    });
    expect(tradeApplySuggestion(L, "rubbish")).toBeNull();
  });

  it("Given a suggested route, Then its label says commodity, route, profit and time, and never throws", () => {
    const t = tradeSuggestionText(L, suggestion).replace(/[\u00a0\u202f]/g, " ");
    expect(t).toBe("Agricium · Port Tressler → Area18 TDD · ≈ +190 000 aUEC · 22 min");
    expect(tradeSuggestionText(L, null)).toBe("");
  });
});

describe("Feature: from a game log file to the commerce card, end to end", () => {
  it("Given a made-up Game.log with the run, When the balance is asked, Then the poll carries the run read by the real parser", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trade-e2e-"));
    try {
      const file = path.join(dir, "Game.log");
      const stamp = new Date(EPOCH).toISOString();
      const filler = `<${new Date(EPOCH + 380_000).toISOString()}> [Info] filler`;
      fs.writeFileSync(
        file,
        [
          `<${stamp}> Log started on Tue Nov  3 18:00:00 2026`,
          ...tradeLines(EPOCH),
          filler,
          "",
        ].join(String.fromCharCode(10)),
      );
      const ledger = new LedgerService(ledgerLogFrom(new GameLog({ logPath: file })), () => NOW);
      ledger.state();
      await ledger.settled();
      const s = new DashboardService(
        stubTelemetry(),
        () => NOW,
        undefined,
        undefined,
        ledger,
        () => ledger.trades(),
      );
      s.setPlan({ expected_profit_auec: 180_000, scu: 696, sell_unit_price: 457 });
      const poll = await s.poll({ includeBalance: true });
      const run = poll.ledger!.trade!.runs[0]!;
      expect(run).toMatchObject({ stage: "complete", buys: 2, sells: 2, scu_bought: 696 });
      expect(run.money!.net).toMatchObject({ auec: 143_000, method: "mesure" });
      expect(run.money!.fees).toMatchObject({ total: 43_568, method: "mesure" });
      const hidden = await s.poll({ includeBalance: false });
      expect(JSON.stringify(hidden)).not.toMatch(MEASURED);
      expect(hidden.ledger!.trade!.runs[0]).not.toHaveProperty("money");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
