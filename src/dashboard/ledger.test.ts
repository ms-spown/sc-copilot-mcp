import { describe, expect, it } from "vitest";
import { parseLog } from "../providers/gamelog/parser.js";
import type { BalancePoint } from "../providers/telemetry/service.js";
import {
  balanceAt,
  boundLedger,
  buildContracts,
  buildLedgerPayload,
  EMPTY_LEDGER,
  LEDGER_BUDGET_CHARS,
  LEDGER_LABEL_MAX,
  LEDGER_MAX_CONTRACTS,
  LEDGER_MAX_STEPS,
  LEDGER_SETTLE_MS,
  LEDGER_TITLE_MAX,
  type Contract,
  type LedgerBase,
  type LedgerPayload,
} from "./ledger.js";
import { transportLedger, transportLogText } from "./testing/ledgerScenario.js";

/**
 * The transport ledger, as scenarios. The log lines are invented (testing/ledgerScenario.ts) and go through the real
 * parser; the balance history is hand-made. Time is always an argument.
 */

const EPOCH = Date.UTC(2026, 10, 3, 18, 0, 0);
const S = 1000;
const at = (seconds: number) => EPOCH + seconds * S;
const eventsUntil = (seconds: number) =>
  parseLog(transportLogText(EPOCH)).events.filter(
    (e) => e.time !== null && Date.parse(e.time) <= at(seconds),
  );
const contractsAt = (seconds: number) => buildContracts(eventsUntil(seconds));
const base = (contracts: Contract[]): LedgerBase => ({
  status: "ok",
  asOf: EPOCH,
  partial: false,
  contracts,
});
/** The balance of the story: 250 000 from 6 s, 434 500 from 90.25 s. */
const HISTORY: BalancePoint[] = [
  { at: at(6), uec: 250_000, until: at(90) },
  { at: at(90.25), uec: 434_500, until: at(130) },
];

describe("Feature: steps pile up in the order the game announced them", () => {
  it("Given a contract with a pickup and a drop-off, When the log is read, Then the steps keep their order, place and goods, and carry no quantity", () => {
    const [parcel, waste] = contractsAt(16);
    expect(parcel!.title).toBe("Urgent Parcel | Medium");
    expect(waste!.title).toBe("Waste Disposal | Easy");
    expect(waste!.state).toBe("in_progress");
    expect(waste!.steps.map((s) => `${s.kind}:${s.location}`)).toEqual([
      "pickup:Outpost_Test_One",
      "dropoff:Station_Test_Two",
    ]);
    expect(waste!.stepsTotal).toBe(2);
    expect(waste!.steps[0]).toEqual({
      kind: "pickup",
      location: "Outpost_Test_One",
      cargo: "HaulCargo_Test_Waste_Stanton",
    });
    // The log has no quantity and no reward: the model of a step does not even have a field for them.
    expect(Object.keys(waste!.steps[0]!).sort()).toEqual(["cargo", "kind", "location"]);
  });

  it("Given more steps than a payload may carry, Then eight are kept and the total says how many exist", () => {
    const lines = [
      '<2026-11-03T18:00:00.000Z>    "Contract Accepted:  Big Haul: " [9]',
      '<2026-11-03T18:00:00.001Z> [Notice] <SHUDEvent_OnNotification> Added notification "Contract Accepted:  Big Haul: " [9] to queue. New queue size: 1, MissionId: [dddddddd-1111-2222-3333-444444444444], ObjectiveId: [] [Team_X]',
      ...Array.from(
        { length: 12 },
        (_, i) =>
          `<2026-11-03T18:00:01.000Z> [Notice] <CreateHaulingObjectiveHandler> Pick created - [Cient] sourcename: HaulCargo_Test_Ore, missionId: dddddddd-1111-2222-3333-444444444444, locationName: Unknown [Place_${i}], locationHash: ${i}`,
      ),
    ];
    const [c] = buildContracts(parseLog(lines.join("\n")).events);
    expect(c!.steps).toHaveLength(LEDGER_MAX_STEPS);
    expect(c!.stepsTotal).toBe(12);
    const payload = buildLedgerPayload({
      base: base([c!]),
      history: [],
      includeBalance: false,
      nowMs: at(5),
    });
    expect(payload.contracts[0]!.steps).toHaveLength(LEDGER_MAX_STEPS);
    expect(payload.contracts[0]!.steps_total).toBe(12);
  });

  it("Given objective notices, Then the ticks count them and never exceed the number of steps", () => {
    expect(
      buildLedgerPayload({
        base: base(contractsAt(60)),
        history: [],
        includeBalance: false,
        nowMs: at(60),
      }).contracts.find((c) => c.title.startsWith("Waste"))!.steps_done,
    ).toBe(1);
    const late = buildLedgerPayload({
      base: base(contractsAt(111)),
      history: [],
      includeBalance: false,
      nowMs: at(111),
    });
    const ore = late.contracts.find((c) => c.title.startsWith("Ore"))!;
    expect([ore.steps_done, ore.steps_total, ore.steps_done_is_estimate]).toEqual([1, 3, true]);
  });
});

describe("Feature: abandoned and finished contracts, two at a time", () => {
  it("Given a contract abandoned ten seconds after it was accepted, Then it is abandoned, timed, and has no gain even with the balance", () => {
    const contracts = contractsAt(13);
    const parcel = contracts[0]!;
    expect(parcel.state).toBe("abandoned");
    const payload = buildLedgerPayload({
      base: base(contracts),
      history: HISTORY,
      includeBalance: true,
      nowMs: at(13),
    });
    const view = payload.contracts.find((c) => c.title.startsWith("Urgent"))!;
    expect(view.duration_ms).toBe(10 * S);
    expect(view).not.toHaveProperty("gain");
    expect(payload.totals).toMatchObject({ completed: 0, abandoned: 1, failed: 0 });
  });

  it("Given a finished contract and a running one, Then the payload lists the newest first, with durations and counts", () => {
    const payload = buildLedgerPayload({
      base: base(contractsAt(100)),
      history: [],
      includeBalance: false,
      nowMs: at(100),
    });
    expect(payload.contracts.map((c) => [c.title.split(" ")[0], c.state])).toEqual([
      ["Ore", "in_progress"],
      ["Waste", "completed"],
      ["Urgent", "abandoned"],
    ]);
    expect(payload.contracts_total).toBe(3);
    expect(payload.totals).toEqual({ completed: 1, abandoned: 1, failed: 0, duration_ms: 76 * S });
    expect(payload.contracts[1]!.duration_ms).toBe(76 * S);
    expect(payload.contracts[0]!.duration_ms).toBeNull(); // still running: no duration yet
  });

  it("Given more contracts than the payload carries, Then an active one is never pushed out by newer finished ones", () => {
    const mk = (i: number, state: Contract["state"]): Contract => ({
      id: String(i),
      title: `C${i}`,
      state,
      acceptedMs: at(i),
      endedMs: state === "completed" ? at(i + 1) : null,
      steps: [],
      stepsTotal: 0,
      objectivesDone: 0,
    });
    const all = [
      mk(0, "in_progress"),
      ...Array.from({ length: 15 }, (_, i) => mk(i + 1, "completed")),
    ];
    const payload = buildLedgerPayload({
      base: base(all),
      history: [],
      includeBalance: false,
      nowMs: at(99),
    });
    expect(payload.contracts).toHaveLength(LEDGER_MAX_CONTRACTS);
    expect(payload.contracts.some((c) => c.title === "C0")).toBe(true);
    expect(payload.contracts_total).toBe(16);
  });

  it("Given the game announces a contract twice, Then it is one contract", () => {
    const lines = [
      '<2026-11-03T18:00:00.000Z>    "Contract Accepted:  Twice: " [9]',
      '<2026-11-03T18:00:05.000Z>    "Contract Accepted:  Twice: " [9]',
      '<2026-11-03T18:00:05.001Z> [Notice] <SHUDEvent_OnNotification> Added notification "Contract Accepted:  Twice: " [9] to queue. New queue size: 1, MissionId: [ffffffff-1111-2222-3333-444444444444], ObjectiveId: [] [Team_X]',
    ];
    const list = buildContracts(parseLog(lines.join("\n")).events);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("ffffffff"); // the copy that carries the mission id wins
  });
});

describe("Feature: the balance history answers only for instants it saw", () => {
  it("Given points with their last confirmation, Then an instant between frames is answered, a gap is not", () => {
    const h: BalancePoint[] = [
      { at: 1000, uec: 10, until: 2000 },
      { at: 9000, uec: 20, until: 9500 },
    ];
    expect(balanceAt(h, 999)).toBeNull(); // before the first frame
    expect(balanceAt(h, 1000)).toBe(10);
    expect(balanceAt(h, 2000)).toBe(10);
    expect(balanceAt(h, 4900)).toBe(10); // within the tolerance after the last confirmation
    expect(balanceAt(h, 6000)).toBeNull(); // the stream saw nothing between 2 s and 9 s
    expect(balanceAt(h, 9200)).toBe(20);
    expect(balanceAt(h, 20_000)).toBeNull(); // after the last frame: unknown, not "the same"
    expect(balanceAt([], 5)).toBeNull();
  });
});

describe("Feature: the measured gain of a finished contract", () => {
  const waste = (seconds: number) => contractsAt(seconds);
  const gainAt = (seconds: number, history: BalancePoint[] = HISTORY) =>
    buildLedgerPayload({
      base: base(waste(seconds)),
      history,
      includeBalance: true,
      nowMs: at(seconds),
    }).contracts.find((c) => c.title.startsWith("Waste"))!.gain;

  it("Given the balance went from 250 000 to 434 500 across a contract, Then the gain is the difference, marked raw and mixed", () => {
    // 100 s is when the settle delay ends; the second contract (accepted at 95 s) overlaps it.
    expect(gainAt(130)).toEqual({
      auec: 184_500,
      confidence: "mesure_brute",
      mixed_flows_possible: true,
      changes: 1,
      overlapping: true,
    });
  });

  it("Given the end of the contract is less than the settle delay ago, Then the gain is pending, not zero", () => {
    expect(gainAt(95)).toMatchObject({ auec: null, reason: "pending", mixed_flows_possible: true });
    expect(LEDGER_SETTLE_MS).toBe(10_000);
  });

  it("Given the telemetry did not see the balance when the contract was accepted, Then the gain is unknown, not zero", () => {
    const late: BalancePoint[] = [{ at: at(60), uec: 300_000, until: at(130) }];
    expect(gainAt(130, late)).toMatchObject({ auec: null, reason: "balance_unknown" });
    expect(gainAt(130, [])).toMatchObject({ auec: null, reason: "balance_unknown" });
  });

  it("Given a gap in the stream between the acceptance and the end, Then the gain is still measured from both ends", () => {
    const gap: BalancePoint[] = [
      { at: at(6), uec: 250_000, until: at(20) },
      { at: at(70), uec: 434_500, until: at(130) },
    ];
    expect(gainAt(130, gap)).toMatchObject({ auec: 184_500 });
  });

  it("Given a purchase and a sale inside the contract, Then the gain mixes them and says how many changes were seen", () => {
    const busy: BalancePoint[] = [
      { at: at(6), uec: 250_000, until: at(30) },
      { at: at(30.2), uec: 200_000, until: at(60) }, // bought something
      { at: at(60.2), uec: 230_000, until: at(90) }, // a fine or a sale
      { at: at(90.25), uec: 434_500, until: at(130) },
    ];
    expect(gainAt(130, busy)).toMatchObject({ auec: 184_500, changes: 3 });
  });

  it("Given the balance is not asked for, Then the payload holds no gain, no total, no plan and no balance figure at all", () => {
    const payload = transportLedger(at(118), EPOCH, false, "story", {
      expected_profit_auec: 150_000,
    });
    const text = JSON.stringify(payload);
    for (const word of [
      "gain",
      "balance",
      "plan_compare",
      "rate_auec",
      "184500",
      "434500",
      "250000",
      "150000",
    ]) {
      expect(text, word).not.toContain(word);
    }
    // The same story with the balance does carry them.
    const asked = JSON.stringify(
      transportLedger(at(118), EPOCH, true, "story", { expected_profit_auec: 150_000 }),
    );
    expect(asked).toContain("184500");
  });
});

describe("Feature: totals and pace over the session", () => {
  const finished = (id: string, start: number, end: number): Contract => ({
    id,
    title: `Job ${id}`,
    state: "completed",
    acceptedMs: at(start),
    endedMs: at(end),
    steps: [],
    stepsTotal: 0,
    objectivesDone: 0,
  });
  const payloadFor = (
    contracts: Contract[],
    history: BalancePoint[],
    nowMs: number,
    plan?: { expected_profit_auec?: number },
  ) => buildLedgerPayload({ base: base(contracts), history, includeBalance: true, plan, nowMs });

  it("Given two half-hour contracts one after the other, Then the pace is the total gain per hour of contract time", () => {
    const history: BalancePoint[] = [
      { at: at(0), uec: 1_000_000, until: at(1799) },
      { at: at(1800), uec: 1_300_000, until: at(3599) },
      { at: at(3600.5), uec: 1_800_000, until: at(4000) },
    ];
    const p = payloadFor([finished("a", 10, 1800), finished("b", 1810, 3600)], history, at(4000));
    expect(p.totals.duration_ms).toBe((1790 + 1790) * S);
    expect(p.balance).toEqual({
      gain_auec: 800_000,
      measured_contracts: 2,
      rate_auec_per_hour: Math.round(800_000 / (3580 / 3600)),
      confidence: "mesure_brute",
      mixed_flows_possible: true,
    });
  });

  it("Given two contracts open at the same time, Then the overlap is counted once in the total and each is flagged", () => {
    const history: BalancePoint[] = [
      { at: at(0), uec: 100_000, until: at(904) },
      { at: at(905), uec: 400_000, until: at(2000) },
    ];
    const p = payloadFor([finished("a", 10, 900), finished("b", 100, 1000)], history, at(2000));
    expect(p.contracts.map((c) => c.gain!.overlapping)).toEqual([true, true]);
    // Each figure holds the other's reward too (300 000 both); the total does not add them up.
    expect(p.contracts.map((c) => c.gain!.auec)).toEqual([300_000, 300_000]);
    expect(p.balance!.gain_auec).toBe(300_000);
    expect(p.totals.duration_ms).toBe(990 * S);
  });

  it("Given less than two minutes of contract time, Then there is a total but no hourly rate", () => {
    const history: BalancePoint[] = [
      { at: at(0), uec: 1000, until: at(59) },
      { at: at(60), uec: 1500, until: at(90) },
    ];
    const p = payloadFor([finished("a", 10, 70)], history, at(90));
    expect(p.balance).toMatchObject({ gain_auec: 500, rate_auec_per_hour: null });
  });

  it("Given no finished contract or no known balance, Then the total and the rate are absent, not zero", () => {
    const running: Contract = { ...finished("a", 10, 20), state: "in_progress", endedMs: null };
    expect(payloadFor([running], HISTORY, at(100)).balance).toMatchObject({
      gain_auec: null,
      rate_auec_per_hour: null,
      measured_contracts: 0,
    });
    expect(payloadFor([finished("a", 10, 400)], [], at(500)).balance).toMatchObject({
      gain_auec: null,
      rate_auec_per_hour: null,
    });
  });

  it("Given a route plan, Then planned and measured profit are compared on the latest finished contract", () => {
    const history: BalancePoint[] = [
      { at: at(0), uec: 100_000, until: at(399) },
      { at: at(400.5), uec: 220_000, until: at(500) },
    ];
    const p = payloadFor([finished("a", 10, 400)], history, at(500), {
      expected_profit_auec: 150_000,
    });
    expect(p.plan_compare).toEqual({
      expected_auec: 150_000,
      measured_auec: 120_000,
      ratio: 0.8,
      contract_id: "a",
    });
    expect(payloadFor([finished("a", 10, 400)], history, at(500), {}).plan_compare).toBeUndefined();
    expect(payloadFor([finished("a", 10, 400)], history, at(500)).plan_compare).toBeUndefined();
    // No measurable contract yet: planned is shown, measured is absent.
    expect(
      payloadFor([], history, at(500), { expected_profit_auec: 150_000 }).plan_compare,
    ).toMatchObject({
      measured_auec: null,
      ratio: null,
    });
  });
});

describe("Feature: states of the log", () => {
  it("Given the log is off, Then the ledger says so, with no contract and no balance figure", () => {
    const p = buildLedgerPayload({
      base: EMPTY_LEDGER,
      history: HISTORY,
      includeBalance: true,
      nowMs: at(1),
    });
    expect(p).toMatchObject({ status: "off", contracts: [], contracts_total: 0, as_of: null });
    expect(p).not.toHaveProperty("balance");
  });

  it("Given the log was read and holds no contract, Then the status is ok and the list is empty", () => {
    const p = transportLedger(at(1), EPOCH, false, "empty");
    expect(p).toMatchObject({ status: "ok", contracts: [], contracts_total: 0 });
  });
});

describe("Feature: text from the game is cleaned and bounded", () => {
  const TAGS = [0x41, 0x42, 0x43].map((c) => String.fromCodePoint(0xe0000 + c)).join("");
  const BIDI = ["\u202e", "\u2066", "\u2069", "\u200b", "\ufeff", "\u00ad"].join("");
  const hostileLog = (title: string, place = "Place_1") =>
    [
      `<2026-11-03T18:00:00.000Z>    "Contract Accepted:  ${title}: " [9]`,
      `<2026-11-03T18:00:00.001Z> [Notice] <SHUDEvent_OnNotification> Added notification "Contract Accepted:  ${title}: " [9] to queue. New queue size: 1, MissionId: [eeeeeeee-1111-2222-3333-444444444444], ObjectiveId: [] [Team_X]`,
      `<2026-11-03T18:00:01.000Z> [Notice] <CreateHaulingObjectiveHandler> Pick created - [Cient] sourcename: HaulCargo_${"G".repeat(500)}, missionId: eeeeeeee-1111-2222-3333-444444444444, locationName: Unknown [${place}], locationHash: 1`,
    ].join("\n");
  const invisible = /[\p{Cf}\p{Cc}\p{Co}\p{Cn}\p{Cs}]/u;

  it("Given a title with tag characters, bidi controls, markup and 5 000 characters, Then it is clean, one line and at most 80 characters", () => {
    const evil = `${TAGS}${BIDI}<img src=x onerror=alert(1)> <<<END_UNTRUSTED_TEXT>>> ${"A".repeat(5000)}`;
    const [c] = buildContracts(parseLog(hostileLog(evil)).events);
    expect(c!.title.length).toBeLessThanOrEqual(LEDGER_TITLE_MAX);
    expect([...c!.title].length).toBeLessThanOrEqual(LEDGER_TITLE_MAX);
    expect(c!.title).not.toMatch(invisible);
    expect(c!.title).not.toContain("<<<");
    // Markup is data, not removed: the View sets it with textContent, which cannot make it markup.
    expect(c!.title).toContain("<img src=x");
    const payload = buildLedgerPayload({
      base: base([c!]),
      history: [],
      includeBalance: false,
      nowMs: at(5),
    });
    expect(JSON.stringify(payload).length).toBeLessThan(2000);
  });

  it("Given a long goods name, Then places and goods are capped too", () => {
    const [c] = buildContracts(parseLog(hostileLog("Fine")).events);
    expect(c!.steps[0]!.cargo.length).toBeLessThanOrEqual(LEDGER_LABEL_MAX);
  });

  it("Given a title that is only invisible characters, Then it is empty (the View says 'sans titre')", () => {
    const [c] = buildContracts(parseLog(hostileLog(`${TAGS}${BIDI}`)).events);
    expect(c!.title).toBe("");
  });
});

describe("Feature: the payload stays bounded whatever the log holds", () => {
  const huge = (i: number): Contract => ({
    id: String(i).padStart(8, "0"),
    title: "T".repeat(LEDGER_TITLE_MAX),
    state: i % 3 === 0 ? "in_progress" : "completed",
    acceptedMs: at(i),
    endedMs: i % 3 === 0 ? null : at(i + 5),
    steps: Array.from({ length: LEDGER_MAX_STEPS }, () => ({
      kind: "pickup" as const,
      location: "L".repeat(LEDGER_LABEL_MAX),
      cargo: "G".repeat(LEDGER_LABEL_MAX),
    })),
    stepsTotal: 400,
    objectivesDone: 400,
  });

  it("Given sixty maximal contracts with the balance asked, Then the serialised ledger fits its budget", () => {
    const all = Array.from({ length: 60 }, (_, i) => huge(i));
    const p = buildLedgerPayload({
      base: base(all),
      history: HISTORY,
      includeBalance: true,
      nowMs: at(9999),
    });
    expect(JSON.stringify(p).length).toBeLessThanOrEqual(LEDGER_BUDGET_CHARS);
    expect(p.contracts.length).toBeLessThanOrEqual(LEDGER_MAX_CONTRACTS);
  });

  it("Given a budget smaller than the payload, Then steps are cut, then contracts, and it says so", () => {
    const all = Array.from({ length: 10 }, (_, i) => huge(i));
    const full = buildLedgerPayload({
      base: base(all),
      history: [],
      includeBalance: false,
      nowMs: at(9999),
    });
    const cut: LedgerPayload = boundLedger(
      { ...full, truncated: undefined } as LedgerPayload,
      3000,
    );
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(3000);
    expect(cut.truncated).toMatch(/contracts halved/);
  });
});
