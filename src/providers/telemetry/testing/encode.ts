/**
 * TEST SUPPORT: a tiny protobuf encoder and hand-made frame builders. Field numbers are written out here on
 * purpose, from the proto file and not from schema.ts, so a wrong number in the decoder's table cannot be
 * matched by the same mistake in the test data. No real frame is ever stored in this repository.
 */

export const cat = (...parts: Buffer[]): Buffer => Buffer.concat(parts);

export function varint(value: number | bigint): Buffer {
  let v = BigInt.asUintN(64, BigInt(value));
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
  } while (v !== 0n);
  return Buffer.from(out);
}

const tag = (num: number, wire: number) => varint((num << 3) | wire);
export const vf = (num: number, value: number | bigint | boolean): Buffer =>
  cat(tag(num, 0), varint(typeof value === "boolean" ? (value ? 1 : 0) : value));
export const ff = (num: number, value: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(value);
  return cat(tag(num, 5), b);
};
export const lf = (num: number, ...children: Buffer[]): Buffer => {
  const body = cat(...children);
  return cat(tag(num, 2), varint(body.length), body);
};
export const sf = (num: number, text: string): Buffer => {
  const body = Buffer.from(text, "utf8");
  return cat(tag(num, 2), varint(body.length), body);
};

/** One gRPC message: flag 0, 4-byte big-endian length, the bytes. */
export function grpcMessage(body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(body.length, 1);
  return cat(header, body);
}

// --- frame builders (numbers from sc_telemetry.proto) -----------------------------------------------------------

export const LIGHT = {
  nominal: 1,
  off: 2,
  minor_flashing: 3,
  minor_on: 4,
  major_flashing: 5,
  major_on: 6,
};
type LightName =
  "pwr" | "wpn" | "thr" | "shld" | "cool" | "qdrv" | "radr" | "prox" | "hit" | "misl";
const LIGHT_NUM: Record<LightName, number> = {
  pwr: 1,
  wpn: 2,
  thr: 3,
  shld: 4,
  cool: 5,
  qdrv: 6,
  radr: 7,
  prox: 8,
  hit: 9,
  misl: 10,
};
const POWER_NUM: Record<string, number> = {
  powerplants: 1,
  engines: 2,
  weapons: 3,
  coolers: 4,
  life_support: 5,
  gravity_generators: 6,
  sensors: 7,
  shield_generators: 8,
  shield_emitters: 9,
};

export interface ShipSpec {
  name?: string;
  speed?: number;
  hydrogen?: number;
  altitude?: number;
  radar?: number;
  heading?: number;
  g?: number;
  boostCritical?: boolean;
  landed?: boolean;
  gear?: number;
  lights?: Partial<Record<LightName, keyof typeof LIGHT>>;
  power?: Partial<Record<string, boolean>>;
  /** false = leave the whole section out */
  withFlight?: boolean;
  quantumFuel?: number;
}

/** A TelemetryStreamResponse.vehicle (field 3) -> VehicleFrame.state (2) -> VehicleState. */
export function vehicleField(spec: ShipSpec = {}): Buffer {
  const lights = Object.entries(spec.lights ?? {}).map(([k, v]) =>
    vf(LIGHT_NUM[k as LightName], LIGHT[v]),
  );
  const power = Object.entries(spec.power ?? {}).map(([k, v]) => vf(POWER_NUM[k]!, v as boolean));
  const instruments = [
    spec.speed ? ff(1, spec.speed) : Buffer.alloc(0),
    spec.hydrogen ? ff(2, spec.hydrogen) : Buffer.alloc(0),
    spec.quantumFuel ? ff(3, spec.quantumFuel) : Buffer.alloc(0),
    spec.g !== undefined ? lf(4, ff(1, spec.g), ff(2, 10)) : Buffer.alloc(0),
    spec.boostCritical ? lf(5, vf(4, true)) : Buffer.alloc(0),
    spec.altitude !== undefined ? ff(6, spec.altitude) : Buffer.alloc(0),
    spec.radar !== undefined ? ff(7, spec.radar) : Buffer.alloc(0),
    spec.heading ? ff(10, spec.heading) : Buffer.alloc(0),
  ];
  const flight =
    spec.withFlight === false
      ? Buffer.alloc(0)
      : lf(
          8,
          lf(
            1,
            spec.landed ? vf(1, true) : Buffer.alloc(0),
            spec.gear !== undefined ? vf(2, spec.gear) : Buffer.alloc(0),
          ),
          lf(3, ...instruments),
        );
  const state = lf(
    2,
    sf(1, spec.name ?? "DRAK_Cutter_907038284543"),
    vf(4, 1),
    lights.length ? lf(7, ...lights) : Buffer.alloc(0),
    flight,
    power.length ? lf(9, ...power) : Buffer.alloc(0),
  );
  return lf(3, state);
}

export interface PilotSpec {
  health?: number;
  hunger?: number;
  thirst?: number;
  heartRate?: number;
  locomotion?: number;
  seat?: string;
  uec?: number | bigint;
  breathable?: boolean;
  intoxication?: number;
}

/** TelemetryStreamResponse.actor (field 6). Health/hunger/thirst are percentages of a gauge of 100. */
export function actorField(spec: PilotSpec = {}): Buffer {
  const gauge = (num: number, value?: number) =>
    value === undefined ? Buffer.alloc(0) : lf(num, ff(1, value), ff(2, 100));
  const vitals = lf(
    1,
    gauge(1, spec.health),
    gauge(3, spec.hunger),
    gauge(4, spec.thirst),
    spec.heartRate ? ff(7, spec.heartRate) : Buffer.alloc(0),
    spec.intoxication !== undefined ? vf(10, spec.intoxication) : Buffer.alloc(0),
  );
  const state = lf(
    2,
    spec.locomotion !== undefined ? vf(1, spec.locomotion) : Buffer.alloc(0),
    spec.seat ? sf(3, spec.seat) : Buffer.alloc(0),
    spec.uec !== undefined ? vf(4, spec.uec) : Buffer.alloc(0),
  );
  const env =
    spec.breathable === undefined ? Buffer.alloc(0) : lf(3, ff(1, 21), vf(3, spec.breathable));
  return lf(6, vitals, state, env);
}

/** TelemetryStreamResponse.weapons (field 4). Countermeasure types: 1 decoy, 2 noise. */
export function weaponsField(
  spec: { decoy?: number; noise?: number; guns?: string[] } = {},
): Buffer {
  const parts: Buffer[] = [];
  for (const gun of spec.guns ?? []) parts.push(lf(4, sf(1, gun), vf(2, true), vf(3, true)));
  if (spec.decoy !== undefined)
    parts.push(lf(5, vf(1, 1), spec.decoy ? vf(2, spec.decoy) : Buffer.alloc(0)));
  if (spec.noise !== undefined)
    parts.push(lf(5, vf(1, 2), spec.noise ? vf(2, spec.noise) : Buffer.alloc(0)));
  return lf(4, ...parts);
}

/** A whole TelemetryStreamResponse from already encoded top-level fields. */
export const frame = (...fields: Buffer[]): Buffer => cat(...fields);
