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
const MAX_STRING_BYTES = 512;

/**
 * Hard limits against a local program that pretends to be the game. The message size limit (1 MiB, reader.ts) alone
 * still allows 500 000 two-byte weapons in one frame.
 *
 * A real frame has a few hundred fields and a handful of weapons: these ceilings are far above any real use.
 */
/** Fields read in ONE frame, nested messages included, known or not. Beyond it the frame is refused (WireError). */
export const MAX_FIELDS_PER_FRAME = 5000;
/** Entries kept per repeated field and per message. The surplus is not decoded; an anomaly says so. */
export const MAX_REPEATED: Readonly<Record<string, number>> = {
  "WeaponsFrame.weapons": 64,
  "WeaponsFrame.countermeasures": 16,
  "EventsFrame.events": 32,
};
/** Any repeated field the table above does not name (a newer schema). */
const DEFAULT_MAX_REPEATED = 64;

/** Shared by every message of one frame. */
interface Budget {
  fields: number;
}
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

function decodeValue(
  type: FieldSpec["type"],
  raw: RawField,
  report: DecodeReport,
  budget: Budget,
): unknown {
  if (type.startsWith("msg:")) return decodeMessage(type.slice(4), raw.bytes!, report, budget);
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
      // Names are short identifiers; a huge string is never worth keeping whole.
      return decoder.decode(raw.bytes!.subarray(0, MAX_STRING_BYTES));
  }
}

function note(list: string[], text: string): void {
  if (list.length < MAX_NOTES && !list.includes(text)) list.push(text);
}

function decodeMessage(
  name: string,
  buf: Uint8Array,
  report: DecodeReport,
  budget: Budget,
): Decoded {
  const spec = MESSAGES[name];
  if (!spec) throw new WireError(`no schema for message ${name}`);
  const out: Decoded = {};
  for (const raw of readFields(buf)) {
    if (++budget.fields > MAX_FIELDS_PER_FRAME) {
      throw new WireError(`more than ${MAX_FIELDS_PER_FRAME} fields in one frame`);
    }
    const field = spec[raw.num];
    if (!field) {
      note(report.unknown, `${name}.${raw.num}`);
      continue;
    }
    if (raw.wire !== expectedWire(field.type)) {
      note(report.anomalies, `${name}.${field.name}: wire type ${raw.wire}`);
      continue;
    }
    if (field.repeated) {
      const list = (out[field.name] as unknown[] | undefined) ?? [];
      const cap = MAX_REPEATED[`${name}.${field.name}`] ?? DEFAULT_MAX_REPEATED;
      if (list.length >= cap) {
        // Not decoded at all: the cost of the surplus is one counted field.
        note(report.anomalies, `${name}.${field.name}: more than ${cap} entries, the rest ignored`);
        continue;
      }
      list.push(decodeValue(field.type, raw, report, budget));
      out[field.name] = list;
    } else {
      out[field.name] = decodeValue(field.type, raw, report, budget);
    }
  }
  return out;
}

/** One message of a known type by name, for tests and tools. Throws WireError on malformed bytes. */
export function decodeAs(name: string, buf: Uint8Array): { value: Decoded; report: DecodeReport } {
  const report: DecodeReport = { anomalies: [], unknown: [] };
  return { value: decodeMessage(name, buf, report, { fields: 0 }), report };
}

/** One TelemetryStreamResponse. Throws WireError when the bytes are not a well-formed message. */
export function decodeFrame(buf: Uint8Array): { frame: Decoded; report: DecodeReport } {
  const report: DecodeReport = { anomalies: [], unknown: [] };
  const frame = decodeMessage(ROOT_MESSAGE, buf, report, { fields: 0 });
  return { frame, report };
}
