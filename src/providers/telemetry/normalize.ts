import type { Decoded } from "./decode.js";

/**
 * One decoded frame -> a flat, honest state.
 *
 * The rule (proto3 leaves out every field at its default value):
 *  - a SECTION that is not in the frame is absent here (`null`), never a block of zeros;
 *  - a scalar missing inside a section that IS present has its default value: a landed ship sends no `speed`,
 *    which really is 0;
 *  - a field the game never fills is not reported as a value. It is listed in NEVER_FILLED, and only shown, under
 *    `unverified`, if a newer game starts to send it with a non-default value.
 *
 * Quirks come from the field test in docs/TELEMETRY.md. Logic ported in spirit from Wingman's normalize.py (GPLv3).
 */

/** Altitude above this (the game sends 3.4028235e38) means "not inside a planet's frame". */
export const NO_PLANET_ALTITUDE = 1e30;

/** What the stream does not contain, as listed in the field test. Shown to the user so nothing is guessed. */
export const NOT_IN_STREAM = [
  "position",
  "camera_direction",
  "shield_level",
  "hull_and_component_health",
  "heat",
  "ammo",
  "power_allocation",
  "quantum_fuel",
  "doors",
  "weapon_presets",
  "death_events",
  "force_feedback",
  "missiles",
] as const;

export interface Gauge {
  current: number;
  max: number;
  /** current / max, only when max > 0. */
  percent?: number;
}

export interface Pilot {
  locomotion?: string;
  crew_role?: string;
  seat?: string;
  /** aUEC. Number when it fits, otherwise a decimal string. */
  uec_balance?: number | string;
  health?: Gauge;
  hunger?: Gauge;
  thirst?: Gauge;
  heart_rate_bpm?: number;
  gravity_g?: number;
  pressure?: number;
  outside_temperature_c?: number;
  breathable_atmosphere?: boolean;
  /** Present in the stream but never seen changing in the field test: do not reason from them. */
  unverified: Record<string, number | boolean | Gauge>;
  /** Parts of the section the frame did not carry ("vitals", "state", "environment"). */
  parts_missing: string[];
}

export interface Ship {
  name: string;
  instance_id?: string;
  class_name?: string;
  /** From the class prefix (e.g. DRAK = Drake): the game's own `manufacturer` field is never filled. */
  manufacturer_derived?: string;
  type?: string;
  lights_on: boolean;
  landed?: boolean;
  gear?: string;
  vtol?: string;
  instruments?: {
    speed_ms: number;
    vertical_speed_ms: number;
    hydrogen_fuel: number;
    atmospheric_density: number;
    boost: { engaged: boolean; output: number; reserves: number; critical: boolean };
    g?: { current: number; max: number };
    /** Only inside a planet's frame; otherwise absent. */
    altitude_m?: number;
    radar_altitude_m?: number;
    /** Only inside a planet's frame and outside a quantum jump (set by the handler); otherwise absent. */
    heading_deg?: number;
  };
  flight_modes?: Record<string, { enabled: boolean; active: boolean }>;
  power?: Record<string, boolean>;
  warning_lights?: Record<string, string>;
  unverified: Record<string, unknown>;
  parts_missing: string[];
}

export interface Weapons {
  /** Present in the stream but never verified: only values the game sent (see coverage.ts). */
  unverified?: Record<string, boolean>;
  weapons: { name: string; instance_id?: string; powered: boolean; ready: boolean }[];
  gimbals_locked?: boolean;
  /** Only the types the frame lists. A type not listed is unknown, not zero. */
  countermeasures: Record<string, number>;
}

export interface NormalizedFrame {
  pilot: Pilot | null;
  ship: Ship | null;
  weapons: Weapons | null;
  /** Names of the game's own events in this frame (enter_seat, leave_seat...). */
  game_events: string[];
  derived: {
    in_planet_frame: boolean;
    heading_valid: boolean;
    radar_valid: boolean;
    in_quantum_mode: boolean;
  };
  /** Sections that could not be read; the rest of the frame still counts. */
  broken: string[];
}

export const MANUFACTURERS: Record<string, string> = {
  AEGS: "Aegis",
  ANVL: "Anvil",
  ARGO: "Argo",
  BANU: "Banu",
  CNOU: "Consolidated Outland",
  CRUS: "Crusader",
  DRAK: "Drake",
  ESPR: "Esperia",
  GAMA: "Gatac",
  GRIN: "Greycat",
  KRIG: "Kruger",
  MISC: "MISC",
  MRAI: "Mirai",
  ORIG: "Origin",
  RSI: "RSI",
  TMBL: "Tumbril",
  XIAN: "Aopoa",
  XNAA: "Aopoa",
  VNCL: "Vanduul",
};

const POWER_FLAGS = [
  "powerplants",
  "engines",
  "weapons",
  "coolers",
  "life_support",
  "gravity_generators",
  "sensors",
  "shield_generators",
  "shield_emitters",
];
const LIGHTS = ["pwr", "wpn", "thr", "shld", "cool", "qdrv", "radr", "prox", "hit", "misl"];
const MODES = [
  "ifcs_coupled",
  "ifcs_esp",
  "ifcs_gravity_compensation",
  "ifcs_g_safe",
  "ifcs_cruise_mode",
  "ifcs_speed_limiter",
  "ifcs_proximity_assist",
  "ifcs_proximity_assist_landing",
  "ifcs_stability",
  "ifcs_core",
  "ifcs_wind_compensation",
  "ifcs_command_behaviour",
];

// --- small readers over a Decoded message ---------------------------------------------------------------------

const msg = (d: Decoded | undefined, key: string): Decoded | undefined =>
  d && typeof d[key] === "object" && d[key] !== null && !Array.isArray(d[key])
    ? (d[key] as Decoded)
    : undefined;
const list = (d: Decoded | undefined, key: string): Decoded[] =>
  d && Array.isArray(d[key]) ? (d[key] as Decoded[]) : [];
const num = (d: Decoded | undefined, key: string): number => {
  const v = d?.[key];
  // NaN and Infinity are not measurements: they read as "not sent" (the default), never as a gauge or a speed.
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
};
const bool = (d: Decoded | undefined, key: string): boolean => d?.[key] === true;

/**
 * Names the game sends (ship, seat, weapon, class) are identifiers such as DRAK_Cutter_907038284543. They reach the
 * model as `structured`, so only that shape is let through: anything else (spaces, punctuation, a long sentence from
 * a local program pretending to be the game) is replaced, never passed on as text.
 */
export const UNRECOGNISED_NAME = "(unrecognised name)";
const GAME_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const gameId = (d: Decoded | undefined, key: string): string => {
  const v = typeof d?.[key] === "string" ? (d[key] as string) : "";
  return v === "" || GAME_ID.test(v) ? v : UNRECOGNISED_NAME;
};
const str = (d: Decoded | undefined, key: string): string =>
  typeof d?.[key] === "string" ? (d[key] as string) : "";
const enm = (d: Decoded | undefined, key: string): string | undefined =>
  typeof d?.[key] === "string" ? (d[key] as string) : undefined;

function gauge(d: Decoded | undefined): Gauge | undefined {
  if (!d) return undefined;
  const current = num(d, "current");
  const max = num(d, "max");
  return max > 0 ? { current, max, percent: current / max } : { current, max };
}

/** 'DRAK_Cutter_907038284543' -> ['DRAK_Cutter', '907038284543']; no numeric suffix -> [name, undefined]. */
export function splitInstance(name: string): [string, string | undefined] {
  const i = name.lastIndexOf("_");
  const tail = i > 0 ? name.slice(i + 1) : "";
  return tail !== "" && /^\d+$/.test(tail) ? [name.slice(0, i), tail] : [name, undefined];
}

// --- sections -------------------------------------------------------------------------------------------------

function readPilot(actor: Decoded): Pilot {
  const vitals = msg(actor, "vitals");
  const state = msg(actor, "state");
  const env = msg(actor, "environment");
  const pilot: Pilot = { unverified: {}, parts_missing: [] };
  if (!vitals) pilot.parts_missing.push("vitals");
  if (!state) pilot.parts_missing.push("state");
  if (!env) pilot.parts_missing.push("environment");

  if (state) {
    pilot.locomotion = enm(state, "locomotion") ?? "unspecified";
    pilot.crew_role = enm(state, "crew_role") ?? "unspecified";
    pilot.seat = gameId(state, "seat_name");
    const uec = state["uec_balance"];
    pilot.uec_balance =
      typeof uec === "bigint" ? uec.toString() : typeof uec === "number" ? uec : 0;
  }
  if (vitals) {
    const health = gauge(msg(vitals, "health"));
    // No gauge, or a gauge with max 0: the game did not report a health. Not a dead pilot.
    if (health && health.max > 0) pilot.health = health;
    const hunger = gauge(msg(vitals, "hunger"));
    if (hunger && hunger.max > 0) pilot.hunger = hunger;
    const thirst = gauge(msg(vitals, "thirst"));
    if (thirst && thirst.max > 0) pilot.thirst = thirst;
    pilot.heart_rate_bpm = num(vitals, "heart_rate");
    pilot.gravity_g = num(vitals, "gravity");
    pilot.pressure = num(vitals, "pressure");
    const oxygen = gauge(msg(vitals, "oxygen"));
    if (oxygen && oxygen.max > 0) pilot.unverified["oxygen"] = oxygen;
    const body = gauge(msg(vitals, "body_temperature"));
    if (body && body.max > 0) pilot.unverified["body_temperature"] = body;
    pilot.unverified["intoxication_level"] = num(vitals, "intoxication_level");
  }
  if (env) {
    pilot.outside_temperature_c = num(env, "external_temperature");
    pilot.breathable_atmosphere = bool(env, "breathable_atmosphere");
    pilot.unverified["ambient_radiation_rate"] = num(env, "ambient_radiation_rate");
  }
  return pilot;
}

function readShip(vehicle: Decoded): Ship | null {
  const state = msg(vehicle, "state");
  if (!state) return null;
  const name = gameId(state, "name");
  const [classFromName, instance] = splitInstance(name);
  const className = gameId(state, "class_name") || classFromName;
  const ship: Ship = {
    name,
    lights_on: bool(state, "lights_enabled"),
    unverified: {},
    parts_missing: [],
  };
  if (instance) ship.instance_id = instance;
  if (className) {
    ship.class_name = className;
    const maker = MANUFACTURERS[className.split("_", 1)[0] ?? ""];
    if (maker) ship.manufacturer_derived = maker;
  }
  const type = enm(state, "type");
  if (type) ship.type = type;

  const flight = msg(state, "flight");
  const flightState = msg(flight, "state");
  const settings = msg(flight, "settings");
  const instruments = msg(flight, "instruments");
  const lights = msg(state, "annunciators");
  const power = msg(state, "power");

  if (!flight) ship.parts_missing.push("flight");
  if (!power) ship.parts_missing.push("power");
  if (!lights) ship.parts_missing.push("annunciators");

  if (flightState) {
    ship.landed = bool(flightState, "is_landed");
    const gear = enm(flightState, "gear");
    const vtol = enm(flightState, "vtol");
    if (gear) ship.gear = gear;
    if (vtol) ship.vtol = vtol;
    // Sent only by ships that transform; never seen in the field test.
    const transformation = enm(flightState, "transformation");
    if (transformation) ship.unverified["transformation"] = transformation;
  }
  if (settings) {
    // The two flight settings that explain how boost interacts with the flight modes. The other booleans of the
    // section (HUD labels, course prediction, light amplification...) are display preferences: see coverage.ts.
    ship.unverified["flight_settings"] = {
      spacebreak_enables_boost: bool(settings, "ifcs_spacebreak_enables_boost"),
      g_safe_disabled_by_boost: bool(settings, "ifcs_g_safe_disabled_by_boost"),
    };
    ship.flight_modes = {};
    for (const key of MODES) {
      const a = msg(settings, key);
      ship.flight_modes[key.replace(/^ifcs_/, "")] = {
        enabled: bool(a, "enabled"),
        active: bool(a, "active"),
      };
    }
  }
  if (power) {
    ship.power = Object.fromEntries(POWER_FLAGS.map((f) => [f, bool(power, f)]));
  }
  if (lights) {
    ship.warning_lights = Object.fromEntries(
      LIGHTS.map((l) => [l, enm(lights, l) ?? "unspecified"]),
    );
  }
  if (instruments) {
    const boost = msg(instruments, "boost");
    const g = msg(instruments, "g_meter");
    const altitude = num(instruments, "altitude");
    const inPlanet = "altitude" in instruments && altitude < NO_PLANET_ALTITUDE;
    ship.instruments = {
      speed_ms: num(instruments, "speed"),
      vertical_speed_ms: num(instruments, "vertical_speed_indicator"),
      hydrogen_fuel: num(instruments, "hydrogen_fuel"),
      atmospheric_density: num(instruments, "atmospheric_density"),
      boost: {
        engaged: bool(boost, "engaged"),
        output: num(boost, "output"),
        reserves: num(boost, "reserves"),
        critical: bool(boost, "critical"),
      },
    };
    if (g) ship.instruments.g = { current: num(g, "current"), max: num(g, "max") };
    if (inPlanet) {
      ship.instruments.altitude_m = altitude;
      ship.instruments.heading_deg = num(instruments, "heading");
      // Equal to the altitude = no ground reading.
      if (num(instruments, "radar_altitude") !== altitude) {
        ship.instruments.radar_altitude_m = num(instruments, "radar_altitude");
      }
    }
    // The game never filled quantum fuel in the field test: only shown if a patch starts to.
    if (num(instruments, "quantum_fuel") > 0) {
      ship.unverified["quantum_fuel"] = num(instruments, "quantum_fuel");
    }
  }
  if (str(state, "manufacturer")) ship.unverified["manufacturer"] = gameId(state, "manufacturer");
  // Not in the verified list of the field test: also listed here (the plain fields stay, for compatibility).
  if (ship.lights_on) ship.unverified["lights_on"] = true;
  if (ship.instruments && ship.instruments.atmospheric_density > 0) {
    ship.unverified["atmospheric_density"] = ship.instruments.atmospheric_density;
  }
  if (msg(state, "doors")) ship.unverified["doors"] = msg(state, "doors");
  return ship;
}

function readWeapons(weapons: Decoded): Weapons {
  const settings = msg(weapons, "settings");
  const out: Weapons = {
    weapons: list(weapons, "weapons").map((w) => {
      const [name, instance] = splitInstance(gameId(w, "name"));
      return {
        name,
        ...(instance ? { instance_id: instance } : {}),
        powered: bool(w, "is_powered"),
        ready: bool(w, "ready_to_fire"),
      };
    }),
    countermeasures: {},
  };
  if (settings) {
    out.gimbals_locked = bool(settings, "gimbals_locked");
    // Not in the verified list of the field test: mirrored under `unverified` when the game sends it.
    if (out.gimbals_locked) out.unverified = { gimbals_locked: true };
  }
  for (const cm of list(weapons, "countermeasures")) {
    const kind = enm(cm, "type");
    if (kind && kind !== "unspecified") out.countermeasures[kind] = num(cm, "amount");
  }
  return out;
}

function section<T>(read: () => T, broken: string[], name: string): T | null {
  try {
    return read();
  } catch (error) {
    broken.push(`${name}: ${error instanceof Error ? error.name : "error"}`);
    return null;
  }
}

/** The state of one frame, with the derived flags that need only this frame. */
export function normalizeFrame(frame: Decoded): NormalizedFrame {
  const broken: string[] = [];
  const vehicleFrame = msg(frame, "vehicle");
  const actorFrame = msg(frame, "actor");
  const weaponsFrame = msg(frame, "weapons");
  const eventsFrame = msg(frame, "events");

  const ship = vehicleFrame ? section(() => readShip(vehicleFrame), broken, "vehicle") : null;
  const pilot = actorFrame ? section(() => readPilot(actorFrame), broken, "actor") : null;
  const weapons = weaponsFrame ? section(() => readWeapons(weaponsFrame), broken, "weapons") : null;
  const gameEvents = list(eventsFrame, "events").map((e) => enm(e, "type") ?? "unspecified");

  const inPlanet = ship?.instruments?.altitude_m !== undefined;
  return {
    pilot,
    ship,
    weapons,
    game_events: gameEvents,
    derived: {
      in_planet_frame: inPlanet,
      heading_valid: inPlanet,
      radar_valid: ship?.instruments?.radar_altitude_m !== undefined,
      in_quantum_mode: ship?.warning_lights?.["qdrv"] === "nominal",
    },
    broken,
  };
}
