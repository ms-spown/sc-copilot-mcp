import { EventBuffer, type EventType } from "./events.js";
import type { NormalizedFrame, Pilot, Ship, Weapons } from "./normalize.js";

/**
 * Frames in, smoothed state and debounced events out. Applies the quirks of the field test once.
 * Logic ported from Wingman's handler.py (GPLv3, credited in THIRD_PARTY.md) and rewritten for this server.
 * Times are milliseconds.
 */

const EVA_STABLE_MS = 1500;
const JUMP_ON_MS = 1500;
/** THR drops to NOMINAL for several seconds in the middle of a jump. */
const JUMP_OFF_MS = 8000;
const UEC_QUIET_MS = 5000;
const EXHAUSTED_BPM = 170;
const EXHAUSTED_SPIKES = 2;
const EXHAUSTED_WINDOW_MS = 10_000;
const RECOVERED_BPM = 150;
const RESPAWN_HEALTH = 0.9;
/** Seated with no vehicle frame this long = a ground vehicle (in ships the vehicle frame lags by 6 to 9 s). */
const GROUND_VEHICLE_AFTER_MS = 12_000;
/**
 * A section (ship, pilot, weapons) missing from a frame keeps its last value for this long. A frame that only
 * carries another section, or only something we ignore (force feedback), must not wipe the state or fake "left
 * the ship"; a section silent for longer than this really is gone.
 */
const SECTION_TTL_MS = 3000;
/** Countermeasure kinds tracked at once. */
const MAX_COUNTERMEASURE_KINDS = 8;

export interface Thresholds {
  health_low: number;
  oxygen_low: number;
  hunger_low: number;
  thirst_low: number;
  hydrogen_low: number;
  /** "Low" means this many countermeasure bursts or fewer are left. */
  countermeasure_bursts: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  health_low: 0.3,
  oxygen_low: 0.2,
  hunger_low: 0.25,
  thirst_low: 0.25,
  hydrogen_low: 0.15,
  countermeasure_bursts: 3,
};

/** The latest smoothed state: a normalised frame plus what only the history can tell. */
export interface TelemetryState extends Omit<NormalizedFrame, "derived"> {
  derived: NormalizedFrame["derived"] & {
    in_jump: boolean;
    /** Health is 0: down or dead. The stream cannot tell which, nor distinguish a revive from a respawn. */
    health_zero: boolean;
    ground_vehicle?: string;
  };
  countermeasure_burst: Record<string, number>;
}

/** A boolean that only counts as changed after holding the new value for a while. */
class Hold {
  value = false;
  private pending: boolean | null = null;
  private since = 0;
  /** False until a value was seen or reset: the first value is a baseline, never a change. */
  private seen = false;

  constructor(
    private onMs: number,
    private offMs = 0,
  ) {}

  reset(value: boolean): void {
    this.value = value;
    this.pending = null;
    this.seen = true;
  }

  /** The confirmed new value when it just changed, otherwise undefined. */
  update(raw: boolean, t: number): boolean | undefined {
    if (!this.seen) {
      this.reset(raw);
      return undefined;
    }
    if (raw === this.value) {
      this.pending = null;
      return undefined;
    }
    if (this.pending !== raw) {
      this.pending = raw;
      this.since = t;
    }
    if (t - this.since >= (raw ? this.onMs : this.offMs)) {
      this.value = raw;
      this.pending = null;
      return raw;
    }
    return undefined;
  }
}

type HoldName =
  | "powerplant"
  | "engines_off"
  | "engines_damaged"
  | "shields_down"
  | "weapons_major"
  | "boost_critical"
  | "landed"
  | "quantum"
  | "jump"
  | "prox"
  | "hit"
  | "lock";

const shipHolds = (): Record<HoldName, Hold> => ({
  powerplant: new Hold(1000, 1000),
  engines_off: new Hold(1000),
  engines_damaged: new Hold(1000),
  shields_down: new Hold(1500, 3000),
  weapons_major: new Hold(1000),
  boost_critical: new Hold(300),
  landed: new Hold(1000, 1000),
  quantum: new Hold(1000, 1000),
  jump: new Hold(JUMP_ON_MS, JUMP_OFF_MS),
  prox: new Hold(200),
  hit: new Hold(0),
  lock: new Hold(1000),
});

const GEAR_DOWN = new Set(["deploying", "deployed", "retracting"]);
const HIT_STATES = new Set(["major_flashing", "major_on", "minor_flashing", "minor_on"]);

const light = (ship: Ship, name: string): string => ship.warning_lights?.[name] ?? "unspecified";

/** The signals the holds track, or undefined for a signal this frame does not carry (so it cannot "change"). */
function signals(ship: Ship): Record<HoldName, boolean | undefined> {
  const power = ship.power;
  const hasLights = ship.warning_lights !== undefined;
  const weightless = Math.abs(ship.instruments?.g?.current ?? 1) < 0.05;
  return {
    powerplant: power ? power["powerplants"] : undefined,
    engines_off: power ? power["powerplants"] === true && power["engines"] === false : undefined,
    engines_damaged: hasLights ? light(ship, "thr") === "minor_on" : undefined,
    shields_down: hasLights ? light(ship, "shld") === "major_on" : undefined,
    // WPN MAJOR only (no power): MINOR also stays on while landed with the guns firing normally.
    weapons_major: hasLights ? light(ship, "wpn") === "major_on" : undefined,
    boost_critical: ship.instruments ? ship.instruments.boost.critical : undefined,
    landed: ship.landed,
    quantum: hasLights ? light(ship, "qdrv") === "nominal" : undefined,
    jump:
      hasLights && ship.instruments && ship.landed !== undefined
        ? light(ship, "thr") === "major_on" && weightless && !ship.landed
        : undefined,
    prox: hasLights
      ? light(ship, "prox") === "major_on" && !GEAR_DOWN.has(ship.gear ?? "")
      : undefined,
    hit: hasLights ? HIT_STATES.has(light(ship, "hit")) : undefined,
    lock: hasLights ? light(ship, "radr") === "major_on" : undefined,
  };
}

const HOLD_EVENTS: Record<HoldName, [EventType, EventType | null]> = {
  powerplant: ["powerplant_online", "powerplant_offline"],
  engines_off: ["engines_offline", null],
  engines_damaged: ["engines_damaged", null],
  shields_down: ["shields_down", "shields_restored"],
  weapons_major: ["weapons_unavailable", null],
  boost_critical: ["boost_depleted", null],
  landed: ["landed", "took_off"],
  quantum: ["quantum_mode_on", "quantum_mode_off"],
  jump: ["jump_started", "jump_finished"],
  prox: ["proximity_warning", null],
  hit: ["under_fire", null],
  lock: ["locked_on", null],
};

export class TelemetryHandler {
  private state: TelemetryState | null = null;
  private locomotion = "unspecified";
  private locomotionPending: { value: string; since: number } | null = null;
  private vehicleKey: string | null = null;
  private lastVehicleName: string | null = null;
  private holds = shipHolds();
  private downHold = new Hold(1000);
  private breathlessHold = new Hold(2000, 2000);
  private pilotSeen = false;
  private firstFrameAt: number | null = null;
  private seatWithoutVehicle: { seat: string; since: number } | null = null;
  private groundVehicle: string | null = null;
  private spikes: { t: number; kind: "high" | "low" }[] = [];
  private dead = false;
  private armed = new Map<string, boolean>();
  private gear: string | undefined;
  private cm = new Map<string, { count: number; burst: number }>();
  private uec: number | null = null;
  private uecPending: { before: number; last: number } | null = null;
  private last: {
    ship?: { v: Ship; t: number };
    pilot?: { v: Pilot; t: number };
    weapons?: { v: Weapons; t: number };
  } = {};

  /** `events` can outlive the handler: a new handler (new stream) keeps appending to the same ring. */
  constructor(
    private thresholds: Thresholds = DEFAULT_THRESHOLDS,
    readonly events: EventBuffer = new EventBuffer(),
  ) {}

  /** The latest state; a new object per frame that is never changed afterwards. */
  get latest(): TelemetryState | null {
    return this.state;
  }

  update(frame: NormalizedFrame, t: number): void {
    if (this.firstFrameAt === null) this.firstFrameAt = t;
    if (frame.pilot) {
      // A frame without the `state` part has no locomotion to report: that is not "unspecified".
      if (frame.pilot.locomotion !== undefined) {
        frame.pilot.locomotion = this.smoothLocomotion(frame.pilot.locomotion, t);
      }
      this.last.pilot = { v: frame.pilot, t };
      this.pilotEvents(frame.pilot, t);
    }
    const fresh = <T>(entry: { v: T; t: number } | undefined): T | null =>
      entry && t - entry.t <= SECTION_TTL_MS ? entry.v : null;

    if (frame.ship) {
      this.last.ship = { v: frame.ship, t };
      this.shipEvents(frame.ship, t);
      this.seatWithoutVehicle = null;
      this.groundVehicle = null;
    } else if (!fresh(this.last.ship)) {
      this.vehicleKey = null;
      this.groundVehicleEvents(fresh(this.last.pilot), t);
    }
    if (frame.weapons) {
      this.last.weapons = { v: frame.weapons, t };
      this.countermeasureEvents(frame.weapons, t);
    }

    const ship = fresh(this.last.ship);
    const inJump = ship ? this.holds.jump.value : false;
    const inPlanet = ship?.instruments?.altitude_m !== undefined;
    const derived: TelemetryState["derived"] = {
      in_planet_frame: inPlanet,
      heading_valid: inPlanet && !inJump,
      radar_valid: ship?.instruments?.radar_altitude_m !== undefined,
      in_quantum_mode: ship?.warning_lights?.["qdrv"] === "nominal",
      in_jump: inJump,
      health_zero: this.dead,
    };
    if (this.groundVehicle) derived.ground_vehicle = this.groundVehicle;
    if (ship?.instruments && !derived.heading_valid) {
      delete ship.instruments.heading_deg; // frozen during a jump, meaningless outside a planet frame
    }
    this.state = {
      pilot: fresh(this.last.pilot),
      ship,
      weapons: fresh(this.last.weapons),
      game_events: frame.game_events,
      broken: frame.broken,
      derived,
      countermeasure_burst: Object.fromEntries([...this.cm].map(([k, v]) => [k, v.burst])),
    };
  }

  // --- pilot ----------------------------------------------------------------------------------------------

  /** On foot <-> EVA flickers many times a second at a ship's door; other changes are taken at once. */
  private smoothLocomotion(raw: string, t: number): string {
    if (raw === this.locomotion) {
      this.locomotionPending = null;
      return raw;
    }
    const footEva = (v: string) => v === "on_foot" || v === "eva";
    if (footEva(raw) && footEva(this.locomotion)) {
      if (this.locomotionPending?.value !== raw) this.locomotionPending = { value: raw, since: t };
      if (t - this.locomotionPending.since < EVA_STABLE_MS) return this.locomotion;
    }
    this.locomotion = raw;
    this.locomotionPending = null;
    return raw;
  }

  /** True once when `value` drops below `limit`; re-armed when it is back above. */
  private crossedBelow(key: string, value: number, limit: number): boolean {
    const armed = this.armed.get(key) ?? value >= limit;
    if (value >= limit) {
      this.armed.set(key, true);
      return false;
    }
    this.armed.set(key, false);
    return armed;
  }

  private pilotEvents(pilot: Pilot, t: number): void {
    const breathable = pilot.breathable_atmosphere;
    const heart = pilot.heart_rate_bpm;
    if (!this.pilotSeen) {
      // The first frame (start, or reconnecting mid-session) is the baseline: no event for a state already there.
      this.pilotSeen = true;
      this.breathlessHold.reset(breathable === false);
      this.armed.set("exhausted", (heart ?? 0) < RECOVERED_BPM);
      // Already down, or already drunk, when we start reading: that is the baseline, not news.
      if (pilot.health?.percent !== undefined && pilot.health.percent <= 0) {
        this.dead = true;
        this.downHold.reset(true);
      }
      const startIntox = pilot.unverified["intoxication_level"];
      if (typeof startIntox === "number" && startIntox > 0) this.armed.set("sober", false);
    }
    const health = pilot.health?.percent;
    if (health !== undefined) {
      if (this.downHold.update(health <= 0, t)) {
        this.dead = true;
        this.events.add("player_down", t);
      }
      if (this.dead && health >= RESPAWN_HEALTH) {
        this.dead = false;
        this.downHold.reset(false);
        this.armed.set("health", true);
        this.events.add("respawned", t);
      }
      if (health > 0 && this.crossedBelow("health", health, this.thresholds.health_low)) {
        this.events.add("health_low", t, { percent: Math.round(health * 100) });
      }
    }
    const lows: [string, number | undefined, number, EventType][] = [
      [
        "oxygen",
        (pilot.unverified["oxygen"] as { percent?: number } | undefined)?.percent,
        this.thresholds.oxygen_low,
        "oxygen_low",
      ],
      ["hunger", pilot.hunger?.percent, this.thresholds.hunger_low, "hunger_low"],
      ["thirst", pilot.thirst?.percent, this.thresholds.thirst_low, "thirst_low"],
    ];
    for (const [key, value, limit, type] of lows) {
      if (value !== undefined && this.crossedBelow(key, value, limit)) {
        this.events.add(type, t, { percent: Math.round(value * 100) });
      }
    }
    if (breathable !== undefined && this.breathlessHold.update(!breathable, t)) {
      this.events.add("not_breathable", t);
    }
    if (heart !== undefined) this.exhaustionEvents(heart, t);
    const intox = pilot.unverified["intoxication_level"];
    if (typeof intox === "number") {
      if (intox > 0 && (this.armed.get("sober") ?? true)) {
        this.armed.set("sober", false);
        this.events.add("intoxicated", t);
      } else if (intox === 0) {
        this.armed.set("sober", true);
      }
    }
    if (typeof pilot.uec_balance === "number") this.uecEvents(pilot.uec_balance, t);
  }

  /** Heart rate only touches 170+ in ~0.3 s spikes while sprinting flat out (measured). */
  private exhaustionEvents(rate: number, t: number): void {
    if (rate < RECOVERED_BPM) {
      this.spikes = [];
      this.armed.set("exhausted", true);
      return;
    }
    const last = this.spikes[this.spikes.length - 1];
    if (rate >= EXHAUSTED_BPM && (!last || last.kind !== "high")) {
      this.spikes.push({ t, kind: "high" });
    } else if (rate < EXHAUSTED_BPM && last?.kind === "high") {
      this.spikes.push({ t, kind: "low" });
    }
    this.spikes = this.spikes.filter((s) => t - s.t <= EXHAUSTED_WINDOW_MS);
    const highs = this.spikes.filter((s) => s.kind === "high").length;
    if (highs >= EXHAUSTED_SPIKES && (this.armed.get("exhausted") ?? true)) {
      this.armed.set("exhausted", false);
      this.events.add("exhausted", t);
    }
  }

  /** Purchases arrive one item every ~2 s: report the total once the balance has settled. */
  private uecEvents(balance: number, t: number): void {
    if (this.uec === null) {
      this.uec = balance;
      return;
    }
    if (balance !== this.uec) {
      this.uecPending = { before: this.uecPending?.before ?? this.uec, last: t };
      this.uec = balance;
      return;
    }
    if (this.uecPending && t - this.uecPending.last >= UEC_QUIET_MS) {
      const { before } = this.uecPending;
      this.uecPending = null;
      if (balance !== before) {
        const delta = balance - before;
        this.events.add("uec_changed", t, {
          delta: `${delta > 0 ? "+" : ""}${delta}`,
          balance,
        });
      }
    }
  }

  // --- vehicle --------------------------------------------------------------------------------------------

  /** Ground vehicles send no vehicle frame: only the seat name ('RSI_Ursa_Rover_SCItem_Seat_Pilot_...') says. */
  private groundVehicleEvents(pilot: Pilot | null, t: number): void {
    const seat = pilot && pilot.locomotion === "seated" ? (pilot.seat ?? "") : "";
    if (!seat || !seat.includes("_SCItem")) {
      this.seatWithoutVehicle = null;
      this.groundVehicle = null;
      return;
    }
    if (this.seatWithoutVehicle?.seat !== seat) this.seatWithoutVehicle = { seat, since: t };
    const since = this.seatWithoutVehicle.since;
    const vehicle = seat.split("_SCItem", 1)[0] ?? seat;
    if (t - since < GROUND_VEHICLE_AFTER_MS || vehicle === this.groundVehicle) return;
    this.groundVehicle = vehicle;
    if (since === this.firstFrameAt) return; // already seated when the stream started: baseline
    this.events.add("ground_vehicle_entered", t, { vehicle: vehicle.replaceAll("_", " ") });
  }

  private shipEvents(ship: Ship, t: number): void {
    const key = ship.name;
    if (key !== this.vehicleKey) {
      if (this.lastVehicleName !== null && key !== this.lastVehicleName) {
        this.events.add("vehicle_changed", t, {
          vehicle: (ship.class_name ?? key).replaceAll("_", " "),
        });
      }
      this.vehicleKey = this.lastVehicleName = key;
      this.baseline(ship);
      return;
    }
    const now = signals(ship);
    for (const name of Object.keys(this.holds) as HoldName[]) {
      const raw = now[name];
      if (raw === undefined) continue;
      const changed = this.holds[name].update(raw, t);
      if (changed === undefined) continue;
      // Engines off while the powerplant just went off is the same fact: one event is enough.
      if (name === "engines_off" && !this.holds.powerplant.value) continue;
      const [on, off] = HOLD_EVENTS[name];
      const type = changed ? on : off;
      if (type) this.events.add(type, t);
    }
    this.deploymentEvents(ship, t);
    const hydrogen = ship.instruments?.hydrogen_fuel;
    if (
      hydrogen !== undefined &&
      hydrogen > 0 &&
      this.crossedBelow("hydrogen", hydrogen, this.thresholds.hydrogen_low)
    ) {
      this.events.add("hydrogen_low", t, { percent: Math.round(hydrogen * 100) });
    }
  }

  /** A new vehicle: take its current values silently, so getting in is not a burst of events. */
  private baseline(ship: Ship): void {
    this.holds = shipHolds();
    const now = signals(ship);
    for (const name of Object.keys(this.holds) as HoldName[]) {
      const raw = now[name];
      if (raw !== undefined) this.holds[name].reset(raw);
    }
    this.gear = ship.gear;
    this.cm.clear();
    this.armed.delete("hydrogen");
  }

  private deploymentEvents(ship: Ship, t: number): void {
    const gear = ship.gear;
    if (
      gear !== this.gear &&
      (gear === "deployed" || gear === "retracted") &&
      this.gear !== undefined
    ) {
      this.events.add(gear === "deployed" ? "gear_deployed" : "gear_retracted", t);
    }
    this.gear = gear;
  }

  // --- countermeasures ------------------------------------------------------------------------------------

  private countermeasureEvents(weapons: Weapons, t: number): void {
    for (const [kind, count] of Object.entries(weapons.countermeasures)) {
      const known = this.cm.get(kind);
      if (!known) {
        // The schema has two kinds; a program inventing more must not make this map (copied on every frame) grow.
        if (this.cm.size < MAX_COUNTERMEASURE_KINDS) this.cm.set(kind, { count, burst: 0 });
        continue;
      }
      const previous = known.count;
      if (count < previous) {
        known.burst = previous - count;
        const limit = known.burst * this.thresholds.countermeasure_bursts;
        const label = kind.charAt(0).toUpperCase() + kind.slice(1);
        if (count === 0) {
          this.events.add("countermeasures_empty", t, { kind: label });
        } else if (count <= limit && limit < previous) {
          this.events.add("countermeasures_low", t, { kind: label, count });
        }
      }
      known.count = count;
    }
  }
}
