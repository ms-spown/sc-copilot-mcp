import fs from "node:fs/promises";
import type { LedgerService } from "../../dashboard/ledgerService.js";
import type { TradePlan } from "../../dashboard/tradeRun.js";
import type { ConnectionInfo } from "../gamelog/connectionState.js";
import type { GameLog } from "../gamelog/reader.js";
import type { Telemetry } from "../telemetry/index.js";
import { createGameLogHint } from "../telemetry/gamelogHint.js";
import type { GameLogHint } from "../telemetry/service.js";
import type { SessionsConfig } from "./config.js";
import {
  cloneLight,
  endCurrent,
  ensureCurrent,
  latest,
  needsEnsure,
  observe,
  setNote,
  startNew,
  type Observation,
  type ReduceConfig,
  type ReduceResult,
} from "./reducer.js";
import {
  aggregate,
  aggregateWithoutMoney,
  MONEY_WITHHELD_NOTE,
  summarizeSession,
  withoutMoney,
  type SessionSummary,
} from "./stats.js";
import type { SessionStore } from "./store.js";
import type { TripInput } from "./types.js";
import type { Session, StoreState } from "./types.js";
import type { TripSource } from "./trips.js";

/**
 * The session manager: the one object that turns what the server sees (the game's log, the telemetry stream, the
 * ledger's contracts) into the session file, and answers the tools and the dashboard from it.
 *
 * What it watches, and why that is a deliberate change of behaviour (documented in docs/TELEMETRY.md): the starting
 * balance cannot be recovered from Game.log, so to capture it the server must be watching when the game starts. While
 * the game is believed to run, the manager touches the telemetry reader so it stays alive (the reader's own five-minute
 * idle stop only applies once the game is gone). How "believed to run" is decided, cheaply:
 *  - Game.log is configured: its modification date is recent (one `stat`) and the connection state is not `closed`;
 *  - or a dashboard poll / session tool touched the manager in the last ten minutes (`poke`), and the stream says it is
 *    connected or live.
 * Without Game.log the server does NOT probe the port on a timer: it keeps today's lazy behaviour and the start balance
 * is then the one first seen. It never calls `telemetry.stop()`. Everything stays on this PC, opt-in via SC_TELEMETRY=on.
 */

export const TICK_MS = 5_000;
export const IDLE_TICK_MS = 20_000;
/** A poke from a View or a tool keeps the manager "interested" this long. */
export const POKE_WINDOW_MS = 10 * 60_000;
/** After the last sighting, contracts that settle late are still collected for this long. */
export const COLLECT_GRACE_MS = 2 * 60_000;
/** A balance seen longer ago than this is not offered as "the balance now" to a new session. */
const BALANCE_FRESH_MS = 60_000;

export interface GameInfo {
  version: string | null;
  channel: "live" | "ptu" | "unknown";
}

/** Game.log written within this long means "the game is running". */
export const GAME_RUNNING_WINDOW_MS = 5 * 60_000;

/**
 * "Is the game running?", from ONE `stat` of Game.log: its modification date is recent. Null when the log is not
 * configured or cannot be read. Cheaper than telemetry's own hint (which also reads the head of the file).
 */
export function createGameRunning(gameLog: GameLog, now: () => number = Date.now) {
  // Whether the game registered the telemetry service (the existing hint, which reads the head of the log) is asked
  // only while the game runs, once per log file once it is true, and at most every 30 s while it is not yet.
  const registration = createGameLogHint(gameLog, now);
  let known: { birth: number; registered: boolean; at: number } | null = null;
  return async (): Promise<GameLogHint | null> => {
    if (!gameLog.configured) return null;
    try {
      const s = await fs.stat(gameLog.source().file);
      const running = now() - s.mtimeMs < GAME_RUNNING_WINDOW_MS;
      if (!running) return { running: false, telemetryRegistered: known?.registered ?? false };
      if (
        !known ||
        known.birth !== s.birthtimeMs ||
        (!known.registered && now() - known.at >= 30_000)
      ) {
        const h = await registration().catch(() => null);
        known = { birth: s.birthtimeMs, registered: h?.telemetryRegistered === true, at: now() };
      }
      return { running: true, telemetryRegistered: known.registered };
    } catch {
      return null;
    }
  };
}

/** The game's version and channel from the head of Game.log, cached a minute. Null when the log is not configured. */
export function createGameInfo(gameLog: GameLog, now: () => number = Date.now) {
  let cached: { at: number; info: GameInfo | null } | null = null;
  return async (): Promise<GameInfo | null> => {
    if (!gameLog.configured) return null;
    if (cached && now() - cached.at < 60_000) return cached.info;
    const info: GameInfo | null = await gameLog.read("current", 64 * 1024).then(
      (r) => {
        const s = r.parsed.session;
        return {
          version: s.game_version
            ? `${s.game_version}${s.build ? ` (build ${s.build})` : ""}`
            : null,
          channel: s.channel,
        };
      },
      () => null,
    );
    cached = { at: now(), info };
    return info;
  };
}

export interface ManagerDeps {
  telemetry: Telemetry;
  store: SessionStore;
  config: SessionsConfig;
  trips?: TripSource;
  /** The ONE reader of the contracts in Game.log; the dashboard shares it instead of following the log twice. */
  ledger?: LedgerService;
  /** Game.log's freshness (telemetry/gamelogHint.ts). Absent or null: the log is not configured. */
  gameHint?: () => Promise<GameLogHint | null>;
  connection?: { current(): Promise<ConnectionInfo | null> };
  gameInfo?: () => Promise<GameInfo | null>;
  now?: () => number;
  newId?: () => string;
}

/** The route plan Claude passed (the commerce model's own shape, dashboard/tradeRun.ts). */
export type PlanForTrips = TradePlan;

/** What the dashboard receives in its poll: small, and without any aUEC figure unless the balance was asked for. */
export interface SessionBar {
  v: 1;
  status: "ok" | "off" | "readonly" | "degraded";
  notice: string | null;
  gap_hours: number;
  /** The last session (open, or ended and not yet replaced). Null before the first one. */
  current: (Omit<SessionSummary, "money"> & { money: SessionSummary["money"] | "withheld" }) | null;
  /** True when the session is open but quiet for longer than the gap: the next play period starts a new one. */
  stale: boolean;
}

export class SessionManager {
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private finalCollect = false;
  /** The last change reached the disk (false: it is only in memory, see the store's notice). */
  private lastSaved = true;
  private ticking: Promise<void> | null = null;
  private lastTickAt = 0;
  private lastPokeAt = -Infinity;
  private lastRunningAt = -Infinity;
  private lastBalance: { value: number; at: number } | null = null;
  /** A tick has seen no balance since this process began: a balance that appears now is a real start. */
  private sawNoBalance = false;
  private plan: PlanForTrips | undefined;
  private readonly now: () => number;
  private readonly rc: ReduceConfig;
  /** For tests and diagnostics. */
  ticks = 0;
  lastError: string | null = null;

  constructor(private readonly deps: ManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.rc = { gapMs: deps.config.gapMs, ...(deps.newId ? { newId: deps.newId } : {}) };
  }

  get ledger(): LedgerService | undefined {
    return this.deps.ledger;
  }

  get enabled(): boolean {
    return this.deps.config.enabled && this.deps.telemetry.enabled && !this.closed;
  }

  get gapHours(): number {
    return Math.round((this.deps.config.gapMs / 3_600_000) * 100) / 100;
  }

  get notice(): string | null {
    return this.deps.store.notice;
  }

  // -------------------------------------------------------------------------------------------
  // The watching loop
  // -------------------------------------------------------------------------------------------

  /** Starts the timer. Every timer is unref'd: it never keeps the process alive. */
  start(): void {
    if (!this.enabled || this.timer) return;
    this.schedule(1000);
  }

  /**
   * Looks at the game and saves what it shows, NOW and completely: the contracts and the trade runs are re-read from the
   * log at once (not from the cache of the last few seconds) and a trip whose result is still settling is kept with an
   * unknown result rather than lost. Before "Nouvelle session", "Terminer" and a clean shutdown.
   */
  async flush(): Promise<void> {
    if (!this.enabled) return;
    await this.ticking?.catch(() => undefined);
    await this.deps.ledger?.refreshNow().catch(() => undefined);
    this.finalCollect = true;
    try {
      await this.tick();
    } finally {
      this.finalCollect = false;
    }
  }

  async close(): Promise<void> {
    await this.flush().catch(() => undefined);
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.ticking?.catch(() => undefined);
  }

  private schedule(ms: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => {
        const running = this.now() - this.lastRunningAt < COLLECT_GRACE_MS;
        this.schedule(running ? TICK_MS : IDLE_TICK_MS);
      });
    }, ms);
    this.timer.unref();
  }

  /** A View or a tool is looking: watch now (without waiting), and for the next ten minutes. */
  poke(): void {
    if (!this.enabled) return;
    this.lastPokeAt = this.now();
    if (this.now() - this.lastTickAt >= 3000 && !this.ticking) void this.tick();
  }

  /** One look at the game, and one change of the file if it showed something. Never throws. */
  tick(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const run = this.look()
      .catch((e: unknown) => {
        // A busy or unwritable file is retried at the next tick; the server never fails because of it.
        this.lastError = e instanceof Error ? e.message : "error";
      })
      .finally(() => {
        this.ticking = null;
      });
    this.ticking = run;
    return run;
  }

  private async look(): Promise<void> {
    const { telemetry, gameHint, connection, trips, gameInfo } = this.deps;
    const now = this.now();
    this.lastTickAt = now;
    this.ticks += 1;
    const hint = gameHint ? await gameHint().catch(() => null) : null;
    const conn = connection ? await connection.current().catch(() => null) : null;
    const interested = now - this.lastPokeAt < POKE_WINDOW_MS;
    // A game started WITHOUT the telemetry setting (no registration line in its log) never gets a reader from us:
    // it would retry all game long for nothing.
    const logSaysRunning =
      hint?.running === true && hint.telemetryRegistered !== false && conn?.state !== "closed";

    let streamRunning = false;
    let balance: number | null = null;
    if (logSaysRunning || interested) {
      // A peek first: it starts nothing. Then a touch, which keeps a running reader alive.
      const status = await telemetry.status(false);
      streamRunning = status.state === "live" || status.state === "connected";
      if (logSaysRunning || streamRunning) {
        const snap = await telemetry.snapshot();
        const b = snap?.state.pilot?.uec_balance;
        balance = typeof b === "number" && Number.isFinite(b) ? b : null;
      }
    }
    const running = logSaysRunning || streamRunning;
    if (running) this.lastRunningAt = now;

    const freshStart = balance !== null && this.sawNoBalance;
    if (balance === null) this.sawNoBalance = true;
    else {
      this.lastBalance = { value: balance, at: now };
      this.sawNoBalance = false;
    }

    let collected: Awaited<ReturnType<TripSource["collect"]>> = { trips: [], context: null };
    if (trips && (running || now - this.lastRunningAt < COLLECT_GRACE_MS)) {
      collected = await trips
        .collect(now, { final: this.finalCollect })
        .catch(() => ({ trips: [], context: null }));
    }
    const info = running && gameInfo ? await gameInfo().catch(() => null) : null;

    const obs: Observation = {
      now,
      running,
      balance,
      freshStart,
      connection: conn ? { state: conn.state, since: conn.since } : null,
      game: info,
      trips: collected.trips.map((t) => this.withPlan(t)),
      context: collected.context,
    };
    await this.apply((s) => observe(s, obs, this.rc));
  }

  /** A trip whose goods are those of the route Claude put on the dashboard carries the planned profit. */
  private withPlan(t: TripInput): TripInput {
    // A trip that already carries its plan (the commerce model matched it) keeps it.
    if (t.planned_profit_auec !== undefined && t.planned_profit_auec !== null) return t;
    const p = this.plan;
    if (!p || typeof p.expected_profit_auec !== "number" || !p.commodity || !t.commodity) return t;
    return t.commodity.toLowerCase().includes(p.commodity.toLowerCase()) ||
      p.commodity.toLowerCase().includes(t.commodity.toLowerCase())
      ? { ...t, planned_profit_auec: p.expected_profit_auec }
      : t;
  }

  /** The plan now (for the commerce model, which matches it to a run). */
  get currentPlan(): PlanForTrips | undefined {
    return this.plan;
  }

  /** The route plan Claude passed when it opened the dashboard (memory only): marks the trips that follow. */
  setPlan(plan: PlanForTrips | undefined): void {
    this.plan = plan;
  }

  /**
   * Applies a reducer function: first to a copy of what is cached (nothing to write? nothing is locked or written),
   * then, if it changes something, to the freshest content of the file under the lock.
   */
  private async apply<T extends { changed: boolean }>(fn: (s: StoreState) => T): Promise<T> {
    const probe = fn(cloneLight(await this.deps.store.read()));
    if (!probe.changed) return probe;
    const { result, written } = await this.deps.store.transact((draft) => {
      const r = fn(draft);
      return { changed: r.changed, result: r };
    });
    this.lastSaved = written;
    return result;
  }

  // -------------------------------------------------------------------------------------------
  // What the tools and the dashboard read
  // -------------------------------------------------------------------------------------------

  private stale(s: Session | undefined, now: number): boolean {
    if (!s) return false;
    const since = Math.max(Date.parse(s.last_activity_at), s.ended_at ? Date.parse(s.ended_at) : 0);
    return now - since > this.deps.config.gapMs;
  }

  private status(): SessionBar["status"] {
    if (!this.enabled) return "off";
    if (this.deps.store.readOnly) return "readonly";
    if (this.deps.store.notice?.startsWith("Sessions could not be saved")) return "degraded";
    return "ok";
  }

  /**
   * The session bar for the dashboard's poll. Attaches to the last session; after a break longer than the gap a new
   * (empty) one is made, as the player asked. Money only with `includeBalance`.
   */
  async bar(includeBalance: boolean): Promise<SessionBar> {
    const base = {
      v: 1 as const,
      gap_hours: this.gapHours,
    };
    if (!this.enabled) return { ...base, status: "off", notice: null, current: null, stale: false };
    this.poke();
    const now = this.now();
    try {
      if (needsEnsure(await this.deps.store.read(), now, this.rc))
        await this.apply((s) => ensureCurrent(s, now, this.rc));
    } catch {
      /* the file is busy: show what is there, the next poll tries again */
    }
    const state = await this.deps.store.read();
    const cur = latest(state);
    const summary = cur ? summarizeSession(cur) : null;
    return {
      ...base,
      status: this.status(),
      notice: this.deps.store.notice,
      current: summary ? (includeBalance ? summary : withoutMoney(summary)) : null,
      stale: !!cur && cur.ended_at === null && this.stale(cur, now),
    };
  }

  /** A session by id, or the last one; money only with `includeBalance`. */
  async session(
    id: string | undefined,
    includeBalance: boolean,
  ): Promise<{
    session: SessionBar["current"];
    recent_trips: Session["trips"];
    interruptions: Session["interruptions"];
    stale: boolean;
    open: boolean;
  } | null> {
    this.poke();
    const state = await this.deps.store.read();
    const s = id ? state.sessions.find((x) => x.id === id) : latest(state);
    if (!s) return null;
    const summary = summarizeSession(s);
    const trips = s.trips.slice(-10).map((t) => (includeBalance ? t : stripTripMoney(t)));
    return {
      session: includeBalance ? summary : withoutMoney(summary),
      recent_trips: trips,
      interruptions: s.interruptions.slice(-10),
      stale: s.ended_at === null && this.stale(s, this.now()),
      open: s.ended_at === null,
    };
  }

  async list(limit: number, includeBalance: boolean) {
    this.poke();
    const state = await this.deps.store.read();
    const rows = [...state.sessions]
      .reverse()
      .slice(0, limit)
      .map((s) => summarizeSession(s));
    return {
      total: state.sessions.length,
      sessions: rows.map((r) => (includeBalance ? r : withoutMoney(r))),
    };
  }

  async stats(last: number | undefined, includeBalance: boolean) {
    this.poke();
    const state = await this.deps.store.read();
    const a = aggregate(state.sessions, last ? { last } : {});
    // Sessions dropped to keep the file small are not in these figures: say so.
    const out = {
      ...(includeBalance ? a : aggregateWithoutMoney(a)),
      history_trimmed: state.dropped_sessions,
    };
    return out;
  }

  /** The balance seen a moment ago, if any (for a new session's start balance). */
  private freshBalance(): number | null {
    const b = this.lastBalance;
    return b && this.now() - b.at <= BALANCE_FRESH_MS ? b.value : null;
  }

  /** Whether the last change reached the disk, and the store's own sentence when something is wrong. */
  get persistence(): { saved: boolean; status: string } {
    return {
      saved: this.lastSaved && !this.deps.store.readOnly,
      status: this.deps.store.notice ?? "ok",
    };
  }

  async newSession(
    note?: string,
  ): Promise<{ summary: SessionSummary; previous: number | null; saved: boolean }> {
    await this.flush().catch(() => undefined); // the last trip of the session that closes is not lost
    const now = this.now();
    const prev = latest(await this.deps.store.read());
    const balance = this.freshBalance();
    const r = await this.apply((s) => startNew(s, now, this.rc, balance, note));
    return {
      summary: summarizeSession(r.current as Session),
      previous: prev ? prev.number : null,
      saved: this.persistence.saved,
    };
  }

  async endSession(
    note?: string,
  ): Promise<{ ended: boolean; summary: SessionSummary | null; saved: boolean }> {
    await this.flush().catch(() => undefined);
    const now = this.now();
    const r = await this.apply((s) => endCurrent(s, now, note));
    return {
      ended: r.ended,
      summary: r.ended && r.current ? summarizeSession(r.current) : null,
      saved: this.persistence.saved,
    };
  }

  async annotate(id: string, note: string): Promise<boolean> {
    const now = this.now();
    const { result } = await this.deps.store.transact((draft) => {
      const ok = setNote(draft, id, note, now);
      return { changed: ok, result: ok };
    });
    return result;
  }
}

const stripTripMoney = (t: Session["trips"][number]) => ({
  ...t,
  cost_auec: null,
  revenue_auec: null,
  fees_auec: null,
  gross_margin_auec: null,
  net_auec: null,
  net_kind: null,
  planned_profit_auec: null,
});

export { MONEY_WITHHELD_NOTE };
export type { ReduceResult };
