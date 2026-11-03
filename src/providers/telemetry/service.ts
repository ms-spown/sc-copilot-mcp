import { decodeFrame } from "./decode.js";
import { EventBuffer, type TelemetryEvent } from "./events.js";
import {
  DEFAULT_THRESHOLDS,
  TelemetryHandler,
  type TelemetryState,
  type Thresholds,
} from "./handler.js";
import { NOT_IN_STREAM, normalizeFrame } from "./normalize.js";
import {
  GAME_ENDPOINT,
  GrpcStreamReader,
  type Endpoint,
  type ReaderOptions,
  type ReaderState,
} from "./reader.js";

/**
 * The one reader of the process: started on the first request, stopped after a quiet period, state in memory only.
 * Frames are never logged, never written to disk, never sent anywhere.
 */

export type TelemetryStateName =
  "off" | "waiting" | "game_without_telemetry" | "connected" | "live" | "incompatible";

/** What Game.log says about the game, when the log is configured. Null when unknown. */
export interface GameLogHint {
  running: boolean;
  /** The "Service ... registered" line is in the log of this run. */
  telemetryRegistered: boolean;
}

export interface TelemetryServiceOptions {
  /** TESTS ONLY. Production never passes it: the address is fixed in reader.ts. */
  endpointForTests?: Endpoint;
  reader?: ReaderOptions;
  /** Stop reading after this long without a request. Default 5 minutes. */
  idleMs?: number;
  /** A frame older than this no longer counts as "live". Default 5 seconds. */
  liveWindowMs?: number;
  now?: () => number;
  gameLogHint?: () => Promise<GameLogHint | null>;
  thresholds?: Thresholds;
}

export const DEFAULT_IDLE_MS = 5 * 60 * 1000;
export const DEFAULT_LIVE_WINDOW_MS = 5000;
/** This many bad frames in a row, and the stream is reported incompatible. */
export const INCOMPATIBLE_AFTER_BAD_FRAMES = 5;

export interface TelemetryStatusReport {
  state: TelemetryStateName;
  /** One sentence on why. */
  cause: string;
  /** Milliseconds since the last frame; absent before the first. */
  last_frame_age_ms?: number;
  frames_received: number;
  frames_rejected: number;
  reconnects: number;
  /** Fields a newer game sends that this schema does not know ("Message.number"). Numbers only. */
  unknown_fields: string[];
  /** Known fields that arrived in a shape the schema does not allow. */
  anomalies: string[];
  /** What the stream does not contain at all. */
  not_in_stream: readonly string[];
  /** Reading stops after this much quiet. */
  idle_stop_ms: number;
}

export interface TelemetrySnapshot {
  state: TelemetryState;
  frame_age_ms: number;
  received_at: string;
  /** From the first balance seen since the reader started, or since the last reset. */
  uec_session?: { start: number; current: number; delta: number; since: string };
}

/** A local program on the port could send endless distinct field numbers: keep only the first few. */
const MAX_NOTES = 64;
const addBounded = (set: Set<string>, value: string) => {
  if (set.size < MAX_NOTES) set.add(value);
};

export class TelemetryService {
  readonly events = new EventBuffer();
  private reader: GrpcStreamReader | null = null;
  private handler: TelemetryHandler;
  private readerState: ReaderState = "stopped";
  private readerDetail = "";
  private idleTimer: NodeJS.Timeout | null = null;
  private lastTouch = 0;
  private lastFrameAt: number | null = null;
  private frames = 0;
  private rejected = 0;
  private badStreak = 0;
  private reconnects = 0;
  private everLive = false;
  private unknown = new Set<string>();
  private anomalies = new Set<string>();
  private uecBaseline: { start: number; since: number } | null = null;
  private hint: GameLogHint | null = null;
  private hintAt = 0;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly liveWindowMs: number;
  private readonly thresholds: Thresholds;

  constructor(private options: TelemetryServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.liveWindowMs = options.liveWindowMs ?? DEFAULT_LIVE_WINDOW_MS;
    this.thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
    this.handler = new TelemetryHandler(this.thresholds, this.events);
  }

  /** Lazy start and keep-alive: every request that needs the stream calls this. */
  ensureStarted(): void {
    this.lastTouch = this.now();
    if (!this.reader) {
      // Events of a reader that has been replaced (stop() then a new request) must not touch the new one.
      const reader: GrpcStreamReader = new GrpcStreamReader(
        {
          onMessage: (bytes) => {
            if (this.reader === reader) this.onMessage(bytes);
          },
          onState: (state, detail) => {
            if (this.reader === reader) this.onReaderState(state, detail);
          },
        },
        this.options.endpointForTests ?? GAME_ENDPOINT,
        this.options.reader,
      );
      this.reader = reader;
      reader.start();
    }
    this.armIdleTimer();
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.now() - this.lastTouch >= this.idleMs) void this.stop();
      else this.armIdleTimer();
    }, this.idleMs);
    this.idleTimer.unref();
  }

  /** Stops the reader and forgets the live state. The event ring and counters stay until the process ends. */
  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const reader = this.reader;
    this.reader = null;
    this.readerState = "stopped";
    this.everLive = false;
    if (reader) await reader.stop();
  }

  private onReaderState(state: ReaderState, detail?: string): void {
    const previous = this.readerState;
    this.readerState = state;
    this.readerDetail = detail ?? "";
    if (state === "connected" && previous !== "live") {
      // A new stream (game started, or restarted): fresh baselines, same event ring.
      this.handler = new TelemetryHandler(this.thresholds, this.events);
      this.badStreak = 0;
      this.uecBaseline = null;
      if (this.everLive) this.reconnects++;
    }
    if (state === "live") this.everLive = true;
  }

  private onMessage(bytes: Uint8Array): void {
    const t = this.now();
    try {
      const { frame, report } = decodeFrame(bytes);
      for (const u of report.unknown) addBounded(this.unknown, u);
      for (const a of report.anomalies) addBounded(this.anomalies, a);
      const known = Object.keys(frame).length > 0 || bytes.length === 0;
      const bad = report.anomalies.length > 0 || (bytes.length > 0 && !known);
      this.badStreak = bad ? this.badStreak + 1 : 0;
      if (bad) this.rejected++;
      if (known) {
        const normalized = normalizeFrame(frame);
        this.handler.update(normalized, t);
        const balance = normalized.pilot?.uec_balance;
        if (typeof balance === "number" && !this.uecBaseline) {
          this.uecBaseline = { start: balance, since: t };
        }
      }
    } catch {
      // Not a well-formed message. Never log the bytes.
      this.rejected++;
      this.badStreak++;
      return;
    }
    this.frames++;
    this.lastFrameAt = t;
  }

  private async refreshHint(): Promise<void> {
    if (!this.options.gameLogHint || this.now() - this.hintAt < 15_000) return;
    this.hintAt = this.now();
    try {
      this.hint = await this.options.gameLogHint();
    } catch {
      this.hint = null;
    }
  }

  /** Where the stream stands. Starts the reader when asked (the default), as any request does. */
  async status(start = true): Promise<TelemetryStatusReport> {
    if (start) this.ensureStarted();
    const frameAge = this.lastFrameAt === null ? undefined : this.now() - this.lastFrameAt;
    let state: TelemetryStateName;
    let cause: string;
    const incompatible =
      this.readerState === "incompatible" || this.badStreak >= INCOMPATIBLE_AFTER_BAD_FRAMES;
    if (incompatible) {
      state = "incompatible";
      cause =
        this.badStreak >= INCOMPATIBLE_AFTER_BAD_FRAMES
          ? "The game sends frames this version of the server cannot read: a game patch probably changed the telemetry schema."
          : `The game answered on the telemetry port but not as expected (${this.readerDetail}). A game patch probably changed it.`;
    } else if (
      this.readerState === "live" &&
      frameAge !== undefined &&
      frameAge <= this.liveWindowMs
    ) {
      state = "live";
      cause = "Frames are arriving.";
    } else if (this.readerState === "live" || this.readerState === "connected") {
      state = "connected";
      cause =
        "Connected to the game, no recent frames: menus or loading screens send none until the character has spawned.";
    } else {
      await this.refreshHint();
      if (this.hint?.running && !this.hint.telemetryRegistered) {
        state = "game_without_telemetry";
        cause =
          "The game is running but its Game.log has no telemetry service line: it was started without GRPC_CLIENT_SERVER_ENABLED. Quit the RSI Launcher completely (tray icon too) and start it again.";
      } else {
        state = "waiting";
        cause =
          "Nothing answers on the telemetry port: the game is not running, or it was started without the game-side setting.";
      }
    }
    return {
      state,
      cause,
      ...(frameAge !== undefined ? { last_frame_age_ms: frameAge } : {}),
      frames_received: this.frames,
      frames_rejected: this.rejected,
      reconnects: this.reconnects,
      unknown_fields: [...this.unknown].slice(0, 20),
      anomalies: [...this.anomalies].slice(0, 20),
      not_in_stream: NOT_IN_STREAM,
      idle_stop_ms: this.idleMs,
    };
  }

  /** The latest state with its age, or null before the first frame. Starts the reader. */
  snapshot(): TelemetrySnapshot | null {
    this.ensureStarted();
    const state = this.handler.latest;
    if (!state || this.lastFrameAt === null) return null;
    const balance = state.pilot?.uec_balance;
    return {
      state,
      frame_age_ms: this.now() - this.lastFrameAt,
      received_at: new Date(this.lastFrameAt).toISOString(),
      ...(this.uecBaseline && typeof balance === "number"
        ? {
            uec_session: {
              start: this.uecBaseline.start,
              current: balance,
              delta: balance - this.uecBaseline.start,
              since: new Date(this.uecBaseline.since).toISOString(),
            },
          }
        : {}),
    };
  }

  /** Restart the balance delta from the current balance. */
  resetUecDelta(): void {
    const balance = this.handler.latest?.pilot?.uec_balance;
    this.uecBaseline = typeof balance === "number" ? { start: balance, since: this.now() } : null;
  }

  recentEvents(afterSeq = 0, limit = 50): { events: TelemetryEvent[]; last_seq: number } {
    this.ensureStarted();
    return { events: this.events.since(afterSeq, limit), last_seq: this.events.lastSeq };
  }
}
