import { cleanLabel } from "../core/untrusted.js";
import { collapseRepeats } from "../providers/gamelog/context.js";
import type { LogEvent } from "../providers/gamelog/parser.js";
import type { BalancePoint } from "../providers/telemetry/service.js";
import { buildTradeSection, type TradePlan, type TradeSection } from "./tradeRun.js";
import type { Transaction } from "../providers/gamelog/trade.js";
import type { MovementEvent, MovementsSection } from "./balanceMovements.js";
import { movementsSectionFor, withDecompositions } from "./movementsLedger.js";
import type { CalibrationSection } from "../providers/sessions/calibration.js";

/**
 * The transport ledger: contracts of the current game session (from Game.log) linked to the balance change that
 * the live telemetry measured. PURE: events and a balance history in, a small bounded payload out. No file, no
 * network, no clock of its own (time is always an argument), and no Node module, so the dashboard preview can
 * import it in a browser.
 *
 * What it knows: the title of a contract, a short mission id, when it was accepted and ended, and per hauling step
 * a pickup or drop-off with its place and the name of the goods. What it does NOT know: quantity (SCU) and reward;
 * the game log carries neither. The only money figure is a balance change measured by the telemetry.
 *
 * Privacy: everything derived from the aUEC balance (gain, total, rate, planned against measured) is built ONLY
 * when `includeBalance` is true. Without it the payload holds no balance-derived number at all.
 */

/** Contracts returned in the payload (the newest, active ones always included). */
export const LEDGER_MAX_CONTRACTS = 10;
/** Steps returned per contract; `steps_total` says how many exist. */
export const LEDGER_MAX_STEPS = 8;
/** Contracts remembered per session (older ones drop off). */
export const LEDGER_KEEP_CONTRACTS = 60;
/** Longest title, place or goods name taken from the log. */
export const LEDGER_TITLE_MAX = 80;
export const LEDGER_LABEL_MAX = 60;
/**
 * After the game announces the end of a contract the balance is read this much later, so a reward paid a moment
 * after the notice is counted. This delay is an ASSUMPTION (not measured with the real game); until it has
 * elapsed the gain is reported as pending.
 */
export const LEDGER_SETTLE_MS = 10_000;
/** A balance point answers for an instant at most this long after its last frame (frames come ~17 times a second). */
export const LEDGER_GAP_TOLERANCE_MS = 3_000;
/** No hourly rate under this much cumulated contract time. */
export const LEDGER_MIN_RATE_MS = 120_000;
/** The ledger payload is cut to fit this many characters once serialised (the trade section has room of its own). */
export const LEDGER_BUDGET_CHARS = 26_000;

export type ContractState =
  "accepted" | "in_progress" | "completed" | "abandoned" | "failed" | "ended";
export type LedgerStatus = "off" | "loading" | "unreadable" | "ok";

export interface LedgerStep {
  kind: "pickup" | "dropoff";
  location: string;
  cargo: string;
}

/** A contract as built from the log (internal form, times in epoch ms). */
export interface Contract {
  /** First 8 characters of the mission id; null when the log gave none. */
  id: string | null;
  title: string;
  state: ContractState;
  acceptedMs: number | null;
  endedMs: number | null;
  steps: LedgerStep[];
  stepsTotal: number;
  /** "Objective Complete" notices attributed to this contract. */
  objectivesDone: number;
}

export interface LedgerBase {
  status: LedgerStatus;
  /** When the log was last written, when it was read; null before the first read. */
  asOf: number | null;
  /** True when only the end of a very large log was read. */
  partial: boolean;
  contracts: Contract[];
}

export const EMPTY_LEDGER: LedgerBase = {
  status: "off",
  asOf: null,
  partial: false,
  contracts: [],
};

// -------------------------------------------------------------------------------------------------
// Contracts from log events
// -------------------------------------------------------------------------------------------------

const ENDED: readonly ContractState[] = ["completed", "abandoned", "failed", "ended"];
const isEnded = (c: Contract) => ENDED.includes(c.state);

function toMs(time: unknown): number | null {
  if (typeof time !== "string") return null;
  const t = Date.parse(time);
  return Number.isFinite(t) ? t : null;
}

function endState(state: unknown): ContractState {
  return state === "completed" || state === "abandoned" || state === "failed" ? state : "ended";
}

/**
 * The contracts of a session, in the order they were accepted. The game announces a contract twice (collapsed by
 * `collapseRepeats`); an event is linked to its contract by the short mission id, and an event without one is
 * attributed only when exactly one contract is open (or, for a completion, by title). Nothing is guessed beyond that.
 */
export function buildContracts(events: readonly LogEvent[]): Contract[] {
  const list: Contract[] = [];
  const byId = new Map<string, Contract>();
  // The log repeats a pickup line hundreds of times, and a read may cut between two repeats: one step once.
  const seenSteps = new Map<Contract, Set<string>>();
  const find = (id: unknown) => (typeof id === "string" ? byId.get(id) : undefined);
  const soleOpen = () => {
    const open = list.filter((c) => !isEnded(c));
    return open.length === 1 ? open[0] : undefined;
  };
  const progress = (c: Contract) => {
    if (c.state === "accepted") c.state = "in_progress";
  };
  const finish = (c: Contract, state: ContractState, at: number | null) => {
    if (isEnded(c)) {
      // A completion notice came first, then the engine says otherwise: the engine's word wins.
      if (c.state === "completed" && state !== "completed") c.state = state;
      return;
    }
    c.state = state;
    c.endedMs = at;
  };

  for (const e of collapseRepeats([...events])) {
    switch (e.type) {
      case "mission_accepted": {
        const id = typeof e.mission_id === "string" ? e.mission_id : null;
        if (id && byId.has(id)) break;
        const c: Contract = {
          id,
          title: cleanLabel(e.title, LEDGER_TITLE_MAX) ?? "",
          state: "accepted",
          acceptedMs: toMs(e.time),
          endedMs: null,
          steps: [],
          stepsTotal: 0,
          objectivesDone: 0,
        };
        list.push(c);
        if (id) byId.set(id, c);
        break;
      }
      case "hauling_objective": {
        const c = find(e.mission_id);
        if (!c || (e.kind !== "pickup" && e.kind !== "dropoff")) break;
        const location = cleanLabel(e.location, LEDGER_LABEL_MAX) ?? "";
        const cargo = cleanLabel(e.cargo, LEDGER_LABEL_MAX) ?? "";
        const seen = seenSteps.get(c) ?? new Set<string>();
        seenSteps.set(c, seen);
        const key = `${e.kind}|${location}|${cargo}`;
        if (seen.has(key)) break;
        seen.add(key);
        c.stepsTotal += 1;
        if (c.steps.length < LEDGER_MAX_STEPS) c.steps.push({ kind: e.kind, location, cargo });
        progress(c);
        break;
      }
      case "objective_new": {
        const c = find(e.mission_id) ?? soleOpen();
        if (c && !isEnded(c)) progress(c);
        break;
      }
      case "objective_completed": {
        const c = find(e.mission_id) ?? soleOpen();
        if (c && !isEnded(c)) {
          c.objectivesDone += 1;
          progress(c);
        }
        break;
      }
      case "mission_completed": {
        const title = cleanLabel(e.title, LEDGER_TITLE_MAX) ?? "";
        const c =
          find(e.mission_id) ??
          [...list].reverse().find((x) => !isEnded(x) && x.id === null && x.title === title) ??
          [...list].reverse().find((x) => !isEnded(x) && x.title === title);
        if (c) finish(c, "completed", toMs(e.time));
        break;
      }
      case "mission_ended": {
        const c = find(e.mission_id);
        if (c) finish(c, endState(e.state), toMs(e.time));
        break;
      }
      default:
        break;
    }
  }
  return list.slice(-LEDGER_KEEP_CONTRACTS);
}

// -------------------------------------------------------------------------------------------------
// Balance
// -------------------------------------------------------------------------------------------------

/**
 * The balance at instant `t`, or null when the telemetry cannot vouch for it: before the first point, or after the
 * last frame that carried the value (a gap in the stream where it may have changed).
 */
export function balanceAt(history: readonly BalancePoint[], t: number): number | null {
  let found: BalancePoint | undefined;
  for (const p of history) {
    if (p.at <= t) found = p;
    else break;
  }
  if (!found) return null;
  return t <= found.until + LEDGER_GAP_TOLERANCE_MS ? found.uec : null;
}

export interface Gain {
  /** Balance at the end (after the settle delay) minus balance at the acceptance; null when it cannot be measured. */
  auec: number | null;
  /** Why `auec` is null: the end is not yet settled, or the telemetry did not see the balance at that time. */
  reason?: "pending" | "balance_unknown" | "no_times";
  confidence: "mesure_brute";
  /** Always true: the change mixes purchases, rewards and fines that happened in between. */
  mixed_flows_possible: true;
  /** Balance changes seen between acceptance and the end of the settle delay. */
  changes?: number;
  /** Another contract was open during this one: its rewards are in this figure too. */
  overlapping?: true;
}

const intervalEnd = (c: Contract, nowMs: number) => (c.endedMs !== null ? c.endedMs : nowMs);

function overlaps(a: Contract, b: Contract, nowMs: number): boolean {
  if (a.acceptedMs === null || b.acceptedMs === null) return false;
  const aEnd = a.endedMs !== null ? a.endedMs + LEDGER_SETTLE_MS : nowMs;
  const bEnd = intervalEnd(b, nowMs);
  return b.acceptedMs < aEnd && a.acceptedMs < bEnd;
}

export function measureGain(
  c: Contract,
  all: readonly Contract[],
  history: readonly BalancePoint[],
  nowMs: number,
): Gain {
  const base = { confidence: "mesure_brute", mixed_flows_possible: true } as const;
  if (c.acceptedMs === null || c.endedMs === null) {
    return { auec: null, reason: "no_times", ...base };
  }
  const endAt = c.endedMs + LEDGER_SETTLE_MS;
  if (endAt > nowMs) return { auec: null, reason: "pending", ...base };
  const start = balanceAt(history, c.acceptedMs);
  const end = balanceAt(history, endAt);
  if (start === null || end === null) return { auec: null, reason: "balance_unknown", ...base };
  const changes = history.filter((p) => p.at > c.acceptedMs! && p.at <= endAt).length;
  const overlapping = all.some((o) => o !== c && overlaps(c, o, nowMs));
  return { auec: end - start, ...base, changes, ...(overlapping ? { overlapping: true } : {}) };
}

/** Merges [start, end] intervals that touch or overlap. */
function mergeIntervals(list: [number, number][]): [number, number][] {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// The payload
// -------------------------------------------------------------------------------------------------

export interface ContractView {
  id: string | null;
  title: string;
  state: ContractState;
  accepted_at: string | null;
  ended_at: string | null;
  /** Only for an ended contract: end minus acceptance. */
  duration_ms: number | null;
  steps: LedgerStep[];
  steps_total: number;
  /** "Objective Complete" notices counted for this contract, at most `steps_total`. */
  steps_done: number;
  /** Always true: the ticks assume the notices come in step order; the log does not say which step is done. */
  steps_done_is_estimate: true;
  /** Present only with the balance, and only for a completed contract. */
  gain?: Gain;
}

export interface LedgerTotals {
  completed: number;
  abandoned: number;
  failed: number;
  /** Time covered by completed contracts (overlaps counted once). */
  duration_ms: number;
}

export interface LedgerBalance {
  /** Balance change over the completed contracts whose gain could be measured (overlaps counted once). */
  gain_auec: number | null;
  measured_contracts: number;
  /** Only with at least LEDGER_MIN_RATE_MS of contract time. */
  rate_auec_per_hour: number | null;
  confidence: "mesure_brute";
  mixed_flows_possible: true;
}

export interface LedgerPlanCompare {
  expected_auec: number;
  /** Measured gain of the latest completed contract; null when none could be measured. */
  measured_auec: number | null;
  ratio: number | null;
  contract_id: string | null;
}

export interface LedgerPayload {
  v: 1;
  status: LedgerStatus;
  as_of: string | null;
  partial: boolean;
  contracts_total: number;
  contracts: ContractView[];
  totals: LedgerTotals;
  /** Present only when the poll asked for the balance. */
  balance?: LedgerBalance;
  plan_compare?: LedgerPlanCompare;
  /**
   * The commerce section (tradeRun.ts): present only when a trade journal feeds the dashboard. Every amount of aUEC
   * in it sits under `runs[].money`, built ONLY when the poll asked for the balance.
   */
  trade?: TradeSection;
  /**
   * Where the money went (balanceMovements.ts): the balance changes of the game session, each with at most one cause
   * and a confidence. Present ONLY when the poll asked for the balance (every figure in it is derived from it).
   */
  movements?: MovementsSection;
  /**
   * How the player's own saved runs compare with their plans (providers/sessions/calibration.ts): ratios, fee rate and
   * the number of runs behind each. Every figure is derived from the balance: present ONLY when the poll asked for it.
   */
  calibration?: CalibrationSection;
  /** Present only when the payload had to be cut to stay bounded. */
  truncated?: string;
}

/** What the ledger and the commerce model take from the plan (dashboard/plan.ts has the full, cleaned one). */
export type PlanForLedger = TradePlan;

export interface LedgerInput {
  base: LedgerBase;
  history: readonly BalancePoint[];
  includeBalance: boolean;
  plan?: PlanForLedger | undefined;
  /** The transactions of the trade journal; absent: no journal, no `trade` section. */
  trades?: readonly Transaction[] | undefined;
  /** Insurance, hangar and session events of the log (ledgerService.movementEvents()); absent: none known. */
  movementEvents?: readonly MovementEvent[] | undefined;
  /** The route calibration (sessions); used only with the balance. */
  calibration?: CalibrationSection | undefined;
  nowMs: number;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function contractView(c: Contract, gain: Gain | undefined): ContractView {
  const duration =
    c.acceptedMs !== null && c.endedMs !== null && c.endedMs >= c.acceptedMs
      ? c.endedMs - c.acceptedMs
      : null;
  return {
    id: c.id,
    title: c.title,
    state: c.state,
    accepted_at: iso(c.acceptedMs),
    ended_at: iso(c.endedMs),
    duration_ms: duration,
    steps: c.steps.slice(0, LEDGER_MAX_STEPS),
    steps_total: c.stepsTotal,
    steps_done: Math.min(c.objectivesDone, c.stepsTotal),
    steps_done_is_estimate: true,
    ...(gain ? { gain } : {}),
  };
}

/** The contracts to return: every active one first (up to the cap), then the newest others, newest first. */
function selectContracts(all: readonly Contract[]): Contract[] {
  const newestFirst = [...all].reverse();
  const active = newestFirst.filter((c) => !isEnded(c)).slice(0, LEDGER_MAX_CONTRACTS);
  const others = newestFirst
    .filter((c) => isEnded(c))
    .slice(0, LEDGER_MAX_CONTRACTS - active.length);
  const picked = new Set<Contract>([...active, ...others]);
  return newestFirst.filter((c) => picked.has(c));
}

function totalsOf(all: readonly Contract[]): LedgerTotals {
  const done = all.filter((c) => c.state === "completed");
  const spans = done
    .filter((c) => c.acceptedMs !== null && c.endedMs !== null && c.endedMs >= c.acceptedMs)
    .map((c) => [c.acceptedMs as number, c.endedMs as number] as [number, number]);
  return {
    completed: done.length,
    abandoned: all.filter((c) => c.state === "abandoned").length,
    failed: all.filter((c) => c.state === "failed").length,
    duration_ms: mergeIntervals(spans).reduce((sum, [s, e]) => sum + (e - s), 0),
  };
}

function balanceOf(
  all: readonly Contract[],
  gains: Map<Contract, Gain>,
  history: readonly BalancePoint[],
): LedgerBalance {
  const measured = all.filter(
    (c) => gains.get(c)?.auec !== undefined && gains.get(c)?.auec !== null,
  );
  const settle = mergeIntervals(
    measured.map((c) => [c.acceptedMs as number, (c.endedMs as number) + LEDGER_SETTLE_MS]),
  );
  let total: number | null = null;
  for (const [s, e] of settle) {
    const a = balanceAt(history, s);
    const b = balanceAt(history, e);
    if (a !== null && b !== null) total = (total ?? 0) + (b - a);
  }
  const span = mergeIntervals(
    measured.map((c) => [c.acceptedMs as number, c.endedMs as number] as [number, number]),
  ).reduce((sum, [s, e]) => sum + (e - s), 0);
  const rate =
    total !== null && span >= LEDGER_MIN_RATE_MS ? Math.round(total / (span / 3_600_000)) : null;
  return {
    gain_auec: total,
    measured_contracts: measured.length,
    rate_auec_per_hour: rate,
    confidence: "mesure_brute",
    mixed_flows_possible: true,
  };
}

function planCompare(
  plan: PlanForLedger | undefined,
  all: readonly Contract[],
  gains: Map<Contract, Gain>,
): LedgerPlanCompare | undefined {
  const expected = plan?.expected_profit_auec;
  if (typeof expected !== "number" || !Number.isFinite(expected)) return undefined;
  const latest = [...all]
    .filter((c) => typeof gains.get(c)?.auec === "number")
    .sort((a, b) => (a.endedMs ?? 0) - (b.endedMs ?? 0))
    .pop();
  const measured = latest ? (gains.get(latest)?.auec ?? null) : null;
  return {
    expected_auec: expected,
    measured_auec: measured,
    ratio:
      measured !== null && expected > 0 ? Math.round((measured / expected) * 1000) / 1000 : null,
    contract_id: latest ? latest.id : null,
  };
}

/** Cuts the payload to `maxChars` serialised: fewer steps, then fewer contracts. Says so in `truncated`. */
export function boundLedger(
  payload: LedgerPayload,
  maxChars: number = LEDGER_BUDGET_CHARS,
): LedgerPayload {
  let out = payload;
  const notes: string[] = [];
  const size = (p: LedgerPayload) => JSON.stringify(p).length;
  if (size(out) > maxChars && out.calibration) {
    const { calibration: _dropped, ...rest } = out;
    void _dropped;
    out = rest;
    notes.push("calibration dropped");
  }
  if (size(out) > maxChars && out.movements && out.movements.listed.length > 10) {
    out = {
      ...out,
      movements: { ...out.movements, listed: out.movements.listed.slice(0, 10), truncated: true },
    };
    notes.push("movements cut to 10");
  }
  if (size(out) > maxChars) {
    out = { ...out, contracts: out.contracts.map((c) => ({ ...c, steps: c.steps.slice(0, 3) })) };
    notes.push("steps cut to 3");
  }
  for (let i = 0; i < 8 && size(out) > maxChars && out.contracts.length > 0; i++) {
    out = { ...out, contracts: out.contracts.slice(0, Math.floor(out.contracts.length / 2)) };
    notes.push("contracts halved");
  }
  return notes.length ? { ...out, truncated: notes.join("; ") } : out;
}

export function buildLedgerPayload(input: LedgerInput): LedgerPayload {
  const { base, history, includeBalance, nowMs } = input;
  const all = base.contracts;
  const gains = new Map<Contract, Gain>();
  if (includeBalance) {
    for (const c of all) {
      if (c.state === "completed") gains.set(c, measureGain(c, all, history, nowMs));
    }
  }
  const shown = selectContracts(all);
  const payload: LedgerPayload = {
    v: 1,
    status: base.status,
    as_of: iso(base.asOf),
    partial: base.partial,
    contracts_total: all.length,
    contracts: shown.map((c) => contractView(c, gains.get(c))),
    totals: totalsOf(all),
  };
  if (includeBalance && base.status === "ok") {
    payload.balance = balanceOf(all, gains, history);
    const compare = planCompare(input.plan, all, gains);
    if (compare) payload.plan_compare = compare;
  }
  if (input.trades !== undefined) {
    payload.trade = buildTradeSection({
      transactions: input.trades,
      history,
      includeBalance,
      plan: input.plan,
      nowMs,
    });
  }
  if (includeBalance && base.status === "ok") {
    // Where the money went: only with the balance, from the same history the figures above come from.
    const sources = {
      history,
      transactions: input.trades,
      contracts: all.flatMap((c) =>
        c.endedMs === null ? [] : [{ state: c.state, endedMs: c.endedMs, title: c.title }],
      ),
      events: input.movementEvents ?? [],
    };
    if (payload.trade) payload.trade = withDecompositions(payload.trade, sources);
    const movements = movementsSectionFor(sources, nowMs);
    if (movements) payload.movements = movements;
  }
  // The calibration is derived from the balance too: never in an answer built without it, whatever the caller passed.
  if (includeBalance && input.calibration && input.calibration.groups.length > 0) {
    payload.calibration = input.calibration;
  }
  return boundLedger(payload);
}
