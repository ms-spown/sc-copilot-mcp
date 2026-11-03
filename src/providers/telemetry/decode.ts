import { ENUMS, MESSAGES, ROOT_MESSAGE, type FieldSpec } from "./schema.js";
import {
  WIRE_FIXED32,
  WIRE_LEN,
  WIRE_VARINT,
  WireError,
  float32,
  readFields,
  type RawField,
} from "./wire.js";

/**
 * A decoded message: ONLY the fields that were on the wire. A missing key means "not sent", which the
 * normaliser must read with the proto3 rule (a scalar missing inside a message that IS present is the default
 * value) and never as a measurement the game did not make.
 */
export type Decoded = { [field: string]: unknown };

export interface DecodeReport {
  /** "Message.field: wire type N" where a known field arrived in a shape the schema does not allow. */
  anomalies: string[];
  /** "Message.<number>" for fields the schema does not know (a newer game). Numbers only, never values. */
  unknown: string[];
}

const MAX_NOTES = 32;
const decoder = new TextDecoder("utf-8");

/** "ANNUNCIATOR_STATE_MINOR_ON" for enum AnnunciatorState -> "minor_on". */
function enumShortName(enumName: string, full: string): string {
  const prefix = enumName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase() + "_";
  return (full.startsWith(prefix) ? full.slice(prefix.length) : full).toLowerCase();
}

function expectedWire(type: FieldSpec["type"]): number {
  if (type === "float") return WIRE_FIXED32;
  if (type === "string" || type.startsWith("msg:")) return WIRE_LEN;
  return WIRE_VARINT; // bool, int32, uint32, int64, enum
}

function decodeValue(type: FieldSpec["type"], raw: RawField, report: DecodeReport): unknown {
  if (type.startsWith("msg:")) return decodeMessage(type.slice(4), raw.bytes!, report);
  if (type.startsWith("enum:")) {
    const name = type.slice(5);
    const n = Number(BigInt.asIntN(32, raw.varint!));
    const full = ENUMS[name]?.[n];
    return full ? enumShortName(name, full) : `unknown_${n}`;
  }
  switch (type) {
    case "bool":
      return raw.varint !== 0n;
    case "int32":
      return Number(BigInt.asIntN(32, raw.varint!));
    case "uint32":
      return Number(BigInt.asUintN(32, raw.varint!));
    case "int64": {
      const v = BigInt.asIntN(64, raw.varint!);
      return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(v)
        : v;
    }
    case "float":
      return float32(raw.bytes!);
    default:
      return decoder.decode(raw.bytes!);
  }
}

function note(list: string[], text: string): void {
  if (list.length < MAX_NOTES && !list.includes(text)) list.push(text);
}

function decodeMessage(name: string, buf: Uint8Array, report: DecodeReport): Decoded {
  const spec = MESSAGES[name];
  if (!spec) throw new WireError(`no schema for message ${name}`);
  const out: Decoded = {};
  for (const raw of readFields(buf)) {
    const field = spec[raw.num];
    if (!field) {
      note(report.unknown, `${name}.${raw.num}`);
      continue;
    }
    if (raw.wire !== expectedWire(field.type)) {
      note(report.anomalies, `${name}.${field.name}: wire type ${raw.wire}`);
      continue;
    }
    const value = decodeValue(field.type, raw, report);
    if (field.repeated) {
      const list = (out[field.name] as unknown[] | undefined) ?? [];
      list.push(value);
      out[field.name] = list;
    } else {
      out[field.name] = value;
    }
  }
  return out;
}

/** One message of a known type by name, for tests and tools. Throws WireError on malformed bytes. */
export function decodeAs(name: string, buf: Uint8Array): { value: Decoded; report: DecodeReport } {
  const report: DecodeReport = { anomalies: [], unknown: [] };
  return { value: decodeMessage(name, buf, report), report };
}

/** One TelemetryStreamResponse. Throws WireError when the bytes are not a well-formed message. */
export function decodeFrame(buf: Uint8Array): { frame: Decoded; report: DecodeReport } {
  const report: DecodeReport = { anomalies: [], unknown: [] };
  const frame = decodeMessage(ROOT_MESSAGE, buf, report);
  return { frame, report };
}
