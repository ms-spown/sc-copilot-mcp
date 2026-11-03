import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameLog } from "../providers/gamelog/reader.js";
import { parseLog } from "../providers/gamelog/parser.js";
import type { Telemetry } from "../providers/telemetry/index.js";
import type { BalancePoint } from "../providers/telemetry/service.js";
import { dashboardTools } from "../tools/dashboard.js";
import { LEDGER_BUDGET_CHARS } from "./ledger.js";
import { LedgerService, ledgerLogFrom, type LedgerLogSource } from "./ledgerService.js";
import { MAX_POLL_CHARS } from "./poll.js";
import { DashboardService } from "./service.js";
import { transportLogText } from "./testing/ledgerScenario.js";

/**
 * The ledger inside the poll answer: what it carries, what it never carries without the balance, and how big the
 * whole answer can get. A stub stands in for the telemetry; the log is a made-up file in a temporary folder.
 */

const EPOCH = Date.UTC(2026, 10, 3, 18, 0, 0);
const at = (s: number) => EPOCH + s * 1000;
/** Numbers chosen so that they cannot appear by chance in any other field of the answer. */
const BALANCE_NOW = 7_912_345;
const BALANCE_BEFORE = 7_654_321;
const GAIN = BALANCE_NOW - BALANCE_BEFORE; // 258 024
const SESSION_DELTA = 1_234_567;
const HISTORY: BalancePoint[] = [
  { at: at(6), uec: BALANCE_BEFORE, until: at(90) },
  { at: at(90.25), uec: BALANCE_NOW, until: at(130) },
];
const FORBIDDEN = [BALANCE_NOW, BALANCE_BEFORE, GAIN, SESSION_DELTA].map(String);

function stubTelemetry(
  extra: { events?: unknown[]; weapons?: unknown; balanceHistory?: boolean } = {},
): Telemetry & { balanceHistory: ReturnType<typeof vi.fn> } {
  const state = {
    ship: null,
    weapons: extra.weapons ?? null,
    pilot: { uec_balance: BALANCE_NOW, health: { current: 100, max: 100 } },
    derived: {},
    game_events: [],
    broken: [],
    countermeasure_burst: {},
  };
  const balanceHistory = vi.fn(async () => HISTORY);
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
      received_at: new Date(at(100)).toISOString(),
      uec_session: {
        start: BALANCE_BEFORE,
        current: BALANCE_NOW,
        delta: SESSION_DELTA,
        since: new Date(at(6)).toISOString(),
      },
    })),
    events: vi.fn(async () => ({
      events: extra.events ?? [],
      last_seq: (extra.events ?? []).length,
    })),
    resetUecDelta: vi.fn(async () => undefined),
    balanceHistory,
    stop: vi.fn(async () => undefined),
  } as unknown as Telemetry & { balanceHistory: ReturnType<typeof vi.fn> };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-poll-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function logFile(text: string): GameLog {
  const file = path.join(dir, "Game.log");
  fs.writeFileSync(file, text);
  return new GameLog({ logPath: file });
}

/** A service whose ledger has already read the log (the first poll only ever says "loading"). */
async function readyService(telemetry: Telemetry, text = transportLogText(EPOCH), nowS = 118) {
  const ledger = new LedgerService(ledgerLogFrom(logFile(text)), () => at(nowS));
  ledger.state();
  await ledger.settled();
  return new DashboardService(telemetry, () => at(nowS), ledger);
}

describe("Feature: the balance never reaches an answer that did not ask for it", () => {
  it("Given a finished contract and the balance NOT asked, Then no balance, no gain, no delta and no plan figure is in the answer", async () => {
    const service = await readyService(stubTelemetry());
    service.setPlan({ expected_profit_auec: 150_000 });
    const poll = await service.poll(false);
    const text = JSON.stringify(poll);
    expect(poll.ledger!.status).toBe("ok");
    expect(poll.ledger!.contracts).toHaveLength(3);
    expect(poll.ledger!.contracts.find((c) => c.state === "completed")).not.toHaveProperty("gain");
    for (const word of FORBIDDEN) expect(text, word).not.toContain(word);
    expect(text).not.toContain("150000");
    expect(poll.ledger).not.toHaveProperty("balance");
    expect(poll.ledger).not.toHaveProperty("plan_compare");
    expect(poll).not.toHaveProperty("balance");
  });

  it("Given the balance NOT asked, Then the history is not even requested from the telemetry", async () => {
    const telemetry = stubTelemetry();
    const service = await readyService(telemetry);
    await service.poll(false);
    expect(telemetry.balanceHistory).not.toHaveBeenCalled();
  });

  it("Given the balance asked, Then the gain, the total and planned against measured are in the ledger, marked raw", async () => {
    const service = await readyService(stubTelemetry());
    service.setPlan({ expected_profit_auec: 300_000 });
    const poll = await service.poll(true);
    const done = poll.ledger!.contracts.find((c) => c.state === "completed")!;
    expect(done.gain).toMatchObject({
      auec: GAIN,
      confidence: "mesure_brute",
      mixed_flows_possible: true,
    });
    expect(poll.ledger!.balance).toMatchObject({
      gain_auec: GAIN,
      measured_contracts: 1,
      confidence: "mesure_brute",
      mixed_flows_possible: true,
    });
    expect(poll.ledger!.plan_compare).toMatchObject({
      expected_auec: 300_000,
      measured_auec: GAIN,
    });
  });

  it("Given the tool handler, When the balance is not asked, Then neither the text nor the structured content holds a figure", async () => {
    const telemetry = stubTelemetry();
    const tools = dashboardTools({
      telemetry,
      gameLog: logFile(transportLogText(Date.now() - 118_000)),
    });
    const poll = tools.find((t) => t.name === "sc_live_poll")!;
    const first = await poll.handler({});
    expect(first.content[0]!.text).toBe("live dashboard poll: live");
    // The text is fixed and the data are in the structured content, which the host does not add to the model.
    const all = JSON.stringify(first);
    for (const word of FORBIDDEN) expect(all, word).not.toContain(word);
    expect((first.structuredContent as { ledger: { status: string } }).ledger.status).toBe(
      "loading",
    );
  });
});

describe("Feature: the poll never waits for the game log", () => {
  it("Given a log read that never finishes, Then the poll still answers, with the ledger 'loading'", async () => {
    const source: LedgerLogSource = {
      configured: true,
      stat: async () => ({ mtimeMs: 1 }),
      read: () => new Promise(() => undefined),
    };
    const service = new DashboardService(
      stubTelemetry(),
      () => at(1),
      new LedgerService(source, () => at(1)),
    );
    const poll = await service.poll(false);
    expect(poll.ledger).toMatchObject({ status: "loading", contracts: [] });
  });

  it("Given no game log configured, Then the ledger says it is off (and the poll is otherwise unchanged)", async () => {
    const tools = dashboardTools({ telemetry: stubTelemetry(), gameLog: new GameLog({}) });
    const { structuredContent } = await tools.find((t) => t.name === "sc_live_poll")!.handler({});
    expect((structuredContent as { ledger: unknown }).ledger).toMatchObject({
      status: "off",
      contracts: [],
      contracts_total: 0,
    });
  });

  it("Given telemetry off, Then the poll holds no ledger and the ledger was never consulted", async () => {
    const state = vi.fn();
    const ledger = { state, settled: async () => undefined } as unknown as LedgerService;
    const off = { enabled: false } as Telemetry;
    const poll = await new DashboardService(off, () => at(1), ledger).poll(true);
    expect(poll).not.toHaveProperty("ledger");
    expect(state).not.toHaveBeenCalled();
  });
});

describe("Feature: the whole answer stays bounded", () => {
  it("Given a hostile log, 30 long events, 200 weapons and the balance asked, Then the answer is under the poll limit", async () => {
    // 60 contracts, each with 12 hauling steps whose names are as long as a log line may make them.
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      const id = `${String(i).padStart(8, "0")}-1111-2222-3333-444444444444`;
      const sec = String(i % 60).padStart(2, "0");
      const title = `${"T".repeat(300)} ${i}`;
      lines.push(`<2026-11-03T18:00:${sec}.000Z>    "Contract Accepted:  ${title}: " [9]`);
      lines.push(
        `<2026-11-03T18:00:${sec}.001Z> [Notice] <SHUDEvent_OnNotification> Added notification "Contract Accepted:  ${title}: " [9] to queue. New queue size: 1, MissionId: [${id}], ObjectiveId: [] [Team_X]`,
      );
      for (let k = 0; k < 12; k++) {
        lines.push(
          `<2026-11-03T18:01:00.000Z> [Notice] <CreateHaulingObjectiveHandler> ${k % 2 ? "Pick" : "Dropoff"} created - [Cient] sourcename: HaulCargo_${"G".repeat(400)}, missionId: ${id}, locationName: Unknown [${"P".repeat(300)}${k}], locationHash: 1`,
        );
      }
    }
    expect(parseLog(lines.join("\n")).events.length).toBeGreaterThan(700);
    const events = Array.from({ length: 30 }, (_, i) => ({
      seq: i + 1,
      type: "landed",
      group: "flight",
      confidence: "confirmed",
      at: new Date(at(i)).toISOString(),
      text: "x".repeat(500),
      data: { a: "y".repeat(80), b: "z".repeat(80), c: "w".repeat(80), d: "v".repeat(80) },
    }));
    const weapons = {
      weapons: Array.from({ length: 200 }, (_, i) => ({
        name: `W_${"n".repeat(60)}_${i}`,
        powered: true,
        ready: true,
      })),
      countermeasures: {},
    };
    const service = await readyService(stubTelemetry({ events, weapons }), lines.join("\n"), 200);
    for (const include of [false, true]) {
      const poll = await service.poll(include);
      const size = JSON.stringify(poll).length;
      expect(size, `include=${include}`).toBeLessThanOrEqual(MAX_POLL_CHARS);
      expect(JSON.stringify(poll.ledger).length).toBeLessThanOrEqual(LEDGER_BUDGET_CHARS);
      expect(poll.ledger!.contracts.length).toBeLessThanOrEqual(10);
      expect(poll.ledger!.contracts_total).toBe(60);
      for (const c of poll.ledger!.contracts) {
        expect(c.steps.length).toBeLessThanOrEqual(8);
        expect(c.title.length).toBeLessThanOrEqual(80);
      }
    }
  });
});
