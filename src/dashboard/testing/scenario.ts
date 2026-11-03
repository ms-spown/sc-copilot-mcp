/**
 * TEST SUPPORT (also used by scripts/dashboard-preview.mjs): a made-up flight that plays through the REAL
 * normaliser and event handler, so the poll answers have exactly the shape and the debouncing of production.
 * Frames are hand-made decoded objects. No real frame, no network, no Node-only module: the browser imports it.
 *
 * Timeline (seconds): 0-3 no signal yet, 3-6 connected without frames, 6-12 on foot, 12-16 seated in a landed
 * ship, 16 take-off and climb, 30-48 cruise, 48-60 quantum jump, 60-80 combat (shields down, hostile lock,
 * countermeasures spent, health drops), 80-90 landing, 90 a sale (the balance jumps), 100-110 the stream is cut.
 */
import { EventBuffer } from "../../providers/telemetry/events.js";
import { DEFAULT_THRESHOLDS, TelemetryHandler } from "../../providers/telemetry/handler.js";
import { NOT_IN_STREAM, normalizeFrame } from "../../providers/telemetry/normalize.js";
import type {
  TelemetrySnapshot,
  TelemetryStatusReport,
} from "../../providers/telemetry/service.js";
import {
  buildPoll,
  summarizeSession,
  type PollResult,
  type SessionMarker,
  type SessionState,
} from "../poll.js";
import { POLL_EVENT_COUNT } from "../constants.js";

type Frame = Record<string, unknown>;

const lerp = (a: number, b: number, k: number) => a + (b - a) * Math.min(1, Math.max(0, k));
const ramp = (t: number, t0: number, t1: number, a: number, b: number) =>
  lerp(a, b, (t - t0) / (t1 - t0));

/** The frame the game would send at `t` seconds, or null when it sends none. */
export function frameAt(t: number): Frame | null {
  if (t < 6 || (t >= 100 && t < 110)) return null;
  const health = t < 60 ? 1 : t < 80 ? ramp(t, 60, 78, 1, 0.35) : 0.35;
  const hunger = ramp(t, 6, 120, 0.92, 0.86);
  const thirst = ramp(t, 6, 120, 0.88, 0.78);
  const uec = t < 90 ? 250_000 : 434_500;
  const onFoot = t < 12;
  const actor = {
    vitals: {
      health: { current: health * 100, max: 100 },
      hunger: { current: hunger * 100, max: 100 },
      thirst: { current: thirst * 100, max: 100 },
      heart_rate: t >= 60 && t < 78 ? 118 : 72,
    },
    state: {
      locomotion: onFoot ? "on_foot" : "seated",
      crew_role: "pilot",
      seat_name: onFoot ? "" : "seat_pilot",
      uec_balance: uec,
    },
    environment: { breathable_atmosphere: true, external_temperature: 21 },
  };
  if (onFoot) return { actor };

  const landed = t < 16 || t >= 82;
  const jump = t >= 50 && t < 58;
  const quantum = t >= 48 && t < 60;
  const combat = t >= 62 && t < 76;
  const shieldsDown = t >= 64 && t < 76;
  const lock = t >= 66 && t < 72;
  const speed = landed
    ? 0
    : jump
      ? 12_000
      : t < 30
        ? ramp(t, 16, 30, 0, 190)
        : t < 48
          ? 200 + 20 * Math.sin(t / 3)
          : t < 80
            ? ramp(t, 60, 80, 210, 60)
            : 40;
  const hydrogen = t < 16 ? 0.9 : t < 80 ? ramp(t, 16, 80, 0.9, 0.48) : 0.48;
  const inPlanet = !quantum && !jump && t >= 14;
  const altitude = landed ? 12 : t < 30 ? ramp(t, 16, 30, 12, 2500) : ramp(t, 30, 80, 2500, 900);
  const instruments: Frame = {
    speed,
    hydrogen_fuel: hydrogen,
    g_meter: { current: jump ? 0 : 1 + (combat ? 0.4 * Math.sin(t * 2) : 0), max: 9 },
    boost: { engaged: false, output: 0, reserves: combat ? 0.35 : 0.9, critical: false },
    vertical_speed_indicator: landed ? 0 : t < 30 ? ramp(t, 16, 30, 30, 0) : -4,
    atmospheric_density: inPlanet ? 0.8 : 0,
    quantum_fuel: 0,
    ...(inPlanet ? { altitude, radar_altitude: altitude, heading: (t * 6) % 360 } : {}),
  };
  const mode = { enabled: true, active: true };
  const light = (state: string) => state;
  const vehicle = {
    state: {
      name: "DRAK_Cutter_907038284543",
      class_name: "DRAK_Cutter",
      type: "spaceship",
      lights_enabled: true,
      flight: {
        state: {
          is_landed: landed,
          gear: landed ? "deployed" : t < 18 ? "retracting" : "retracted",
        },
        settings: {
          ifcs_coupled: mode,
          ifcs_esp: { enabled: true, active: false },
          ifcs_g_safe: mode,
          ifcs_speed_limiter: { enabled: true, active: !quantum },
          ifcs_cruise_mode: { enabled: true, active: false },
          ifcs_gravity_compensation: { enabled: true, active: true },
        },
        instruments,
      },
      power: {
        powerplants: true,
        engines: true,
        weapons: true,
        coolers: true,
        life_support: true,
        gravity_generators: true,
        sensors: true,
        shield_generators: !quantum,
        shield_emitters: !quantum,
      },
      annunciators: {
        pwr: light("nominal"),
        wpn: light("minor_on"),
        thr: light(t >= 50 && t < 55 ? "major_on" : "nominal"),
        shld: light(shieldsDown ? "major_on" : quantum ? "off" : "nominal"),
        cool: light("off"),
        qdrv: light(quantum ? "nominal" : "off"),
        radr: light(lock ? "major_on" : "off"),
        prox: light("off"),
        hit: light(combat && Math.floor(t) % 9 < 6 ? "major_on" : "off"),
        misl: light("off"),
      },
    },
  };
  const decoys = t < 62 ? 8 : t < 70 ? 8 - Math.floor((t - 62) / 2) : 4;
  const weapons = {
    settings: { gimbals_locked: false },
    weapons: [
      { name: "KLWE_LaserRepeater_S3_1001", is_powered: true, ready_to_fire: !landed },
      { name: "KLWE_LaserRepeater_S3_1002", is_powered: true, ready_to_fire: !landed },
      {
        name: "BEHR_BallisticGatling_S2_1003",
        is_powered: !combat || t < 74,
        ready_to_fire: !landed,
      },
    ],
    countermeasures: [
      { type: "decoy", amount: decoys },
      { type: "noise", amount: 6 },
    ],
  };
  // In ships the vehicle frame lags the pilot's by several seconds.
  return t < 14 ? { actor } : { actor, vehicle, weapons };
}

export type ForcedState = "off" | "waiting" | "game_without_telemetry" | "incompatible" | null;

export const SCENARIO_SECONDS = 120;

export class Scenario {
  private events = new EventBuffer();
  private handler = new TelemetryHandler(DEFAULT_THRESHOLDS, this.events);
  private lastFrameAt: number | null = null;
  private fedUntil = -1;
  private frames = 0;
  private baseline: { start: number; since: number } | null = null;
  private session: SessionState = {
    startedAt: null,
    endedAt: null,
    startSeq: 0,
    endSeq: null,
    markers: [],
  };
  /** Force a stream state to preview it. null: follow the story. */
  forced: ForcedState = null;
  /** Stop delivering frames (the stream is cut) without ending the story. */
  cut = false;
  /** Virtual time in milliseconds from the start of the story. */
  t = 0;

  constructor(readonly epoch: number = Date.UTC(2026, 10, 3, 18, 0, 0)) {}

  get now(): number {
    return this.epoch + this.t;
  }

  /** Moves the story to `ms`, feeding a frame every 250 ms. */
  advanceTo(ms: number): void {
    this.t = Math.max(this.t, ms);
    while (this.fedUntil + 250 <= this.t) {
      this.fedUntil += 250;
      if (this.fedUntil < 0) continue;
      const loopT = (this.fedUntil / 1000) % SCENARIO_SECONDS;
      if (this.cut || this.forced) continue;
      const frame = frameAt(loopT);
      if (!frame) continue;
      const time = this.epoch + this.fedUntil;
      this.handler.update(normalizeFrame(frame), time);
      this.lastFrameAt = time;
      this.frames++;
      const balance = this.handler.latest?.pilot?.uec_balance;
      if (typeof balance === "number" && !this.baseline) {
        this.baseline = { start: balance, since: time };
      }
    }
  }

  private status(): TelemetryStatusReport {
    const storyT = (this.t / 1000) % SCENARIO_SECONDS;
    const age = this.lastFrameAt === null ? undefined : this.now - this.lastFrameAt;
    let state: TelemetryStatusReport["state"];
    let cause: string;
    if (this.forced) {
      state = this.forced;
      cause = `forced for the preview: ${this.forced}`;
    } else if (age !== undefined && age <= 5000) {
      state = "live";
      cause = "Frames are arriving.";
    } else if (storyT >= 3 || this.frames > 0) {
      state = "connected";
      cause = "Connected to the game, no recent frames.";
    } else {
      state = "waiting";
      cause = "No telemetry for now.";
    }
    return {
      state,
      cause,
      ...(age !== undefined ? { last_frame_age_ms: age } : {}),
      frames_received: this.frames,
      frames_rejected: 0,
      reconnects: 0,
      unknown_fields: [],
      anomalies: [],
      not_in_stream: NOT_IN_STREAM,
      idle_stop_ms: 300_000,
    };
  }

  private snapshot(): TelemetrySnapshot | null {
    const state = this.handler.latest;
    if (!state || this.lastFrameAt === null || this.forced) return null;
    const balance = state.pilot?.uec_balance;
    return {
      state,
      frame_age_ms: this.now - this.lastFrameAt,
      received_at: new Date(this.lastFrameAt).toISOString(),
      ...(this.baseline && typeof balance === "number"
        ? {
            uec_session: {
              start: this.baseline.start,
              current: balance,
              delta: balance - this.baseline.start,
              since: new Date(this.baseline.since).toISOString(),
            },
          }
        : {}),
    };
  }

  /** What sc_live_poll would answer at the current virtual time. */
  poll(includeBalance: boolean): PollResult {
    const keep = (e: { type: string }) => includeBalance || e.type !== "uec_changed";
    const status = this.status();
    const snapshot = this.snapshot();
    const recent = this.events.since(0, POLL_EVENT_COUNT, keep);
    const { startedAt, startSeq, endSeq } = this.session;
    const sessionEvents =
      startedAt === null
        ? []
        : this.events.since(
            startSeq,
            200,
            (e) =>
              ["took_off", "landed", "jump_started"].includes(e.type) &&
              (endSeq === null || e.seq <= endSeq),
          );
    const result = buildPoll({
      status,
      snapshot,
      events: recent,
      lastSeq: this.events.lastSeq,
      sessionEvents,
      session: this.session,
      includeBalance,
      nowMs: this.now,
    });
    return this.forced === "off" ? { ...result, enabled: false } : result;
  }

  /** sc_live_mark. */
  mark(action: "start" | "end" | "reset_delta"): Record<string, unknown> {
    const at = new Date(this.now).toISOString();
    const push = (kind: SessionMarker["kind"]) => {
      this.session = { ...this.session, markers: [...this.session.markers, { kind, at }] };
    };
    if (action === "start") {
      this.session = {
        ...this.session,
        startedAt: this.now,
        endedAt: null,
        startSeq: this.events.lastSeq,
        endSeq: null,
      };
      const balance = this.handler.latest?.pilot?.uec_balance;
      this.baseline = typeof balance === "number" ? { start: balance, since: this.now } : null;
      push("start");
      return {
        ok: true,
        action,
        message: "Session started: counters and the balance change restart from now.",
      };
    }
    if (action === "end") {
      if (this.session.startedAt === null || this.session.endedAt !== null) {
        return { ok: false, action, message: "No session is running." };
      }
      this.session = { ...this.session, endedAt: this.now, endSeq: this.events.lastSeq };
      push("end");
      return { ok: true, action, message: "Session ended." };
    }
    const balance = this.handler.latest?.pilot?.uec_balance;
    this.baseline = typeof balance === "number" ? { start: balance, since: this.now } : null;
    push("reset_delta");
    return { ok: true, action, message: "Balance change reset to zero." };
  }

  summary() {
    return summarizeSession([], this.session, this.now, false);
  }
}
