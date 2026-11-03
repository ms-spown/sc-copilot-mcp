/**
 * The events derived from the stream. The game sends almost no events itself (no spawn, no death in the field
 * test), so these are inferred from state changes, with debouncing. Each carries a `confidence`:
 *
 *  - "confirmed": seen working live in the field test (docs/TELEMETRY.md, credits at the end);
 *  - "unverified": built from a field that never changed in the test, or from a heuristic. Treat as a hint.
 *
 * The wording states only what the telemetry shows. It is data from the game, never instructions.
 */

export type Confidence = "confirmed" | "unverified";
export type EventGroup = "ship" | "vehicle" | "pilot" | "wallet";

export interface EventSpec {
  group: EventGroup;
  confidence: Confidence;
  text: string;
}

export const EVENT_SPECS = {
  powerplant_offline: {
    group: "ship",
    confidence: "confirmed",
    text: "The powerplant went offline.",
  },
  powerplant_online: {
    group: "ship",
    confidence: "confirmed",
    text: "The powerplant is back online.",
  },
  engines_offline: { group: "ship", confidence: "confirmed", text: "The engines are off." },
  engines_damaged: { group: "ship", confidence: "confirmed", text: "The engines report damage." },
  shields_down: { group: "ship", confidence: "confirmed", text: "The shields are down." },
  shields_restored: { group: "ship", confidence: "confirmed", text: "The shields are back up." },
  weapons_unavailable: {
    group: "ship",
    confidence: "confirmed",
    text: "The weapons have no power.",
  },
  boost_depleted: { group: "ship", confidence: "confirmed", text: "Boost reserves are critical." },
  hydrogen_low: {
    group: "ship",
    confidence: "unverified",
    text: "Hydrogen fuel is low: {percent} percent.",
  },
  landed: { group: "ship", confidence: "confirmed", text: "The ship has landed." },
  took_off: { group: "ship", confidence: "confirmed", text: "The ship took off." },
  gear_deployed: { group: "ship", confidence: "confirmed", text: "The landing gear is down." },
  gear_retracted: { group: "ship", confidence: "confirmed", text: "The landing gear is up." },
  quantum_mode_on: { group: "ship", confidence: "confirmed", text: "Quantum mode is on." },
  quantum_mode_off: { group: "ship", confidence: "confirmed", text: "Quantum mode is off." },
  jump_started: { group: "ship", confidence: "confirmed", text: "A quantum jump started." },
  jump_finished: { group: "ship", confidence: "confirmed", text: "The quantum jump ended." },
  proximity_warning: {
    group: "ship",
    confidence: "confirmed",
    text: "Collision warning: very close to something.",
  },
  vehicle_changed: { group: "ship", confidence: "confirmed", text: "Now in {vehicle}." },
  under_fire: { group: "ship", confidence: "confirmed", text: "The ship is taking hits." },
  locked_on: {
    group: "ship",
    confidence: "confirmed",
    text: "A hostile lock is reported (RADR light).",
  },
  countermeasures_low: {
    group: "ship",
    confidence: "confirmed",
    text: "{kind} countermeasures are low: {count} left.",
  },
  countermeasures_empty: {
    group: "ship",
    confidence: "confirmed",
    text: "{kind} countermeasures are used up.",
  },
  ground_vehicle_entered: {
    group: "vehicle",
    confidence: "unverified",
    text: "Now in {vehicle} (ground vehicle: it sends no vehicle data).",
  },
  health_low: {
    group: "pilot",
    confidence: "confirmed",
    text: "Health is low: {percent} percent.",
  },
  player_down: {
    group: "pilot",
    confidence: "confirmed",
    text: "Health reached 0: the pilot is down or dead (the stream cannot tell which).",
  },
  respawned: {
    group: "pilot",
    confidence: "confirmed",
    text: "Health is back up after being 0: the pilot respawned or was revived.",
  },
  oxygen_low: {
    group: "pilot",
    confidence: "unverified",
    text: "Oxygen is low: {percent} percent.",
  },
  not_breathable: {
    group: "pilot",
    confidence: "unverified",
    text: "The air here is reported as not breathable.",
  },
  exhausted: {
    group: "pilot",
    confidence: "unverified",
    text: "The heart rate is spiking (sprinting).",
  },
  hunger_low: {
    group: "pilot",
    confidence: "confirmed",
    text: "Hunger is getting low: {percent} percent.",
  },
  thirst_low: {
    group: "pilot",
    confidence: "confirmed",
    text: "Thirst is getting low: {percent} percent.",
  },
  intoxicated: {
    group: "pilot",
    confidence: "unverified",
    text: "An intoxication level is reported.",
  },
  uec_changed: {
    group: "wallet",
    confidence: "confirmed",
    text: "The balance changed by {delta} aUEC, now {balance} aUEC.",
  },
} as const satisfies Record<string, EventSpec>;

export type EventType = keyof typeof EVENT_SPECS;

export interface TelemetryEvent {
  /** Increases by one for every event this process records: use it as a cursor. */
  seq: number;
  type: EventType;
  group: EventGroup;
  confidence: Confidence;
  /** When the frame that caused it arrived (ISO, this PC's clock). */
  at: string;
  text: string;
  data: Record<string, string | number>;
}

/** Text kept in an event's data. Names already come through a 64-character identifier filter; this is the backstop. */
export const MAX_EVENT_DATA_CHARS = 80;
const MAX_EVENT_DATA_KEYS = 4;

function boundedData(data: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(data).slice(0, MAX_EVENT_DATA_KEYS)) {
    out[key.slice(0, 32)] =
      typeof value === "string" && value.length > MAX_EVENT_DATA_CHARS
        ? value.slice(0, MAX_EVENT_DATA_CHARS)
        : value;
  }
  return out;
}

export function makeEvent(
  seq: number,
  type: EventType,
  nowMs: number,
  rawData: Record<string, string | number> = {},
): TelemetryEvent {
  const spec: EventSpec = EVENT_SPECS[type];
  const data = boundedData(rawData);
  return {
    seq,
    type,
    group: spec.group,
    confidence: spec.confidence,
    at: new Date(nowMs).toISOString(),
    text: spec.text.replace(/\{(\w+)\}/g, (_, key: string) => String(data[key] ?? "unknown")),
    data,
  };
}

/** A fixed-size ring: the newest `capacity` events, oldest dropped. Memory only. */
export class EventBuffer {
  private items: TelemetryEvent[] = [];
  private nextSeq = 1;

  constructor(private capacity = 200) {}

  add(type: EventType, nowMs: number, data: Record<string, string | number> = {}): TelemetryEvent {
    const event = makeEvent(this.nextSeq++, type, nowMs, data);
    this.items.push(event);
    if (this.items.length > this.capacity) this.items.shift();
    return event;
  }

  /** Events newer than `afterSeq` that pass `keep`, oldest first, at most `limit` (the newest when there are more). */
  since(
    afterSeq = 0,
    limit = 50,
    keep: (event: TelemetryEvent) => boolean = () => true,
  ): TelemetryEvent[] {
    const fresh = this.items.filter((e) => e.seq > afterSeq && keep(e));
    return fresh.slice(Math.max(0, fresh.length - limit));
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  clear(): void {
    this.items = [];
  }
}
