import type { Telemetry } from "../providers/telemetry/index.js";
import { POLL_CACHE_MS, POLL_EVENT_COUNT } from "./constants.js";
import { buildLedgerPayload, EMPTY_LEDGER, type PlanForLedger } from "./ledger.js";
import type { LedgerService } from "./ledgerService.js";
import {
  boundPoll,
  buildPoll,
  EMPTY_SESSION,
  offPoll,
  tailorPoll,
  type PollRequest,
  type PollResult,
  type SessionMarker,
  type SessionState,
} from "./poll.js";
import type { ShipSpecsResolver } from "./specs.js";

/**
 * The server side of the live dashboard: one poll answer shared by every View, and the session markers.
 *
 * - Everything is in memory. Nothing is written to disk, no frame is kept.
 * - The poll never starts the reader while telemetry is off: it answers `off` without calling the service.
 * - The answer is cached for POLL_CACHE_MS and in-flight requests are shared, so N Views cost one read. The cache
 *   key is `include_balance`, so a balance is never handed to a View that did not ask for it. What each View
 *   already holds (events, unchanged sections, the static list) is cut AFTER the cache (tailorPoll): the cache key
 *   never depends on it.
 * - It never sends anything to the game. The markers are this process's own bookkeeping.
 */

export type MarkAction = "start" | "end" | "reset_delta";

export interface MarkResult {
  ok: boolean;
  action: MarkAction;
  message: string;
  session: { started_at: string | null; ended_at: string | null; markers: SessionMarker[] };
}

/** Event types the session summary needs. */
const SESSION_TYPES = new Set(["took_off", "landed", "jump_started"]);
const MAX_MARKERS = 60;

export class DashboardService {
  private session: SessionState = { ...EMPTY_SESSION, markers: [] };
  private cache = new Map<boolean, { at: number; result: Promise<PollResult> }>();

  private plan: PlanForLedger | undefined;

  constructor(
    private readonly telemetry: Telemetry | undefined,
    private readonly now: () => number = Date.now,
    /** Looks up the wiki sheet of the flown ship in the background (specs.ts). Absent: no `specs` in the answer. */
    private readonly specs?: ShipSpecsResolver,
    /** The transport ledger's reader (ledgerService.ts). Without one the ledger says it is off. */
    private readonly ledger?: LedgerService,
  ) {}

  get enabled(): boolean {
    return this.telemetry?.enabled === true;
  }

  /** The route plan Claude passed when it opened the dashboard (memory only), for the ledger's planned/measured. */
  setPlan(plan: PlanForLedger | undefined): void {
    this.plan = plan;
    this.cache.clear();
  }

  /** The answer for one View: the shared answer, cut to what that View still needs. */
  async poll(request: PollRequest): Promise<PollResult> {
    return tailorPoll(await this.shared(request.includeBalance), request);
  }

  /** The shared answer (cached half a second), complete. */
  private shared(includeBalance: boolean): Promise<PollResult> {
    const t = this.now();
    const hit = this.cache.get(includeBalance);
    if (hit && t - hit.at >= 0 && t - hit.at < POLL_CACHE_MS) return hit.result;
    const result = this.build(includeBalance, t);
    this.cache.set(includeBalance, { at: t, result });
    // A failed read must not be served again for half a second.
    result.catch(() => {
      if (this.cache.get(includeBalance)?.result === result) this.cache.delete(includeBalance);
    });
    return result;
  }

  private async build(includeBalance: boolean, nowMs: number): Promise<PollResult> {
    const telemetry = this.telemetry;
    if (!telemetry || !telemetry.enabled) return offPoll(nowMs, this.session);
    const status = await telemetry.status(true);
    const snapshot = await telemetry.snapshot();
    const recent = await telemetry.events(
      0,
      POLL_EVENT_COUNT,
      (e) => includeBalance || e.type !== "uec_changed",
    );
    const { startedAt, startSeq, endSeq } = this.session;
    let sessionEvents: typeof recent.events = [];
    if (startedAt !== null) {
      const all = await telemetry.events(
        startSeq,
        200,
        (e) => SESSION_TYPES.has(e.type) && (endSeq === null || e.seq <= endSeq),
      );
      sessionEvents = all.events;
    }
    // Only reached with telemetry on (the off answer returned above). Answers from memory: it never waits for the wiki.
    const className = snapshot?.state.ship?.class_name;
    const specs = className ? this.specs?.current(className, nowMs) : undefined;
    // The ledger is built for THIS balance choice: the shared answer (and its hash) never mixes the two.
    const ledger = await this.ledgerPayload(telemetry, includeBalance, nowMs);
    const answer = buildPoll({
      status,
      snapshot,
      ...(specs ? { specs } : {}),
      ledger,
      events: recent.events,
      lastSeq: recent.last_seq,
      sessionEvents,
      session: this.session,
      includeBalance,
      nowMs,
    });
    return boundPoll(answer);
  }

  /** The ledger as last computed (never waits for the log), with balance figures only when asked. */
  private async ledgerPayload(telemetry: Telemetry, includeBalance: boolean, nowMs: number) {
    const base = this.ledger ? this.ledger.state() : EMPTY_LEDGER;
    const history =
      includeBalance && telemetry.balanceHistory ? await telemetry.balanceHistory() : [];
    return buildLedgerPayload({ base, history, includeBalance, plan: this.plan, nowMs });
  }

  /** Session markers. Memory only. Never sent to the game. */
  async mark(action: MarkAction): Promise<MarkResult> {
    const t = this.now();
    const done = (ok: boolean, message: string): MarkResult => ({
      ok,
      action,
      message,
      session: {
        started_at:
          this.session.startedAt === null ? null : new Date(this.session.startedAt).toISOString(),
        ended_at:
          this.session.endedAt === null ? null : new Date(this.session.endedAt).toISOString(),
        markers: this.session.markers,
      },
    });
    const telemetry = this.telemetry;
    if (!telemetry || !telemetry.enabled)
      return done(false, "Telemetry is off: no marker was set.");
    const push = (kind: SessionMarker["kind"]) => {
      this.session.markers = [
        ...this.session.markers,
        { kind, at: new Date(t).toISOString() },
      ].slice(-MAX_MARKERS);
    };
    this.cache.clear();
    if (action === "start") {
      const { last_seq } = await telemetry.events(0, 1);
      await telemetry.resetUecDelta();
      this.session = {
        ...this.session,
        startedAt: t,
        endedAt: null,
        startSeq: last_seq,
        endSeq: null,
      };
      push("start");
      return done(true, "Session started: counters and the balance change restart from now.");
    }
    if (action === "end") {
      if (this.session.startedAt === null || this.session.endedAt !== null) {
        return done(false, "No session is running.");
      }
      const { last_seq } = await telemetry.events(0, 1);
      this.session = { ...this.session, endedAt: t, endSeq: last_seq };
      push("end");
      return done(true, "Session ended.");
    }
    await telemetry.resetUecDelta();
    push("reset_delta");
    return done(true, "Balance change reset to zero.");
  }
}
