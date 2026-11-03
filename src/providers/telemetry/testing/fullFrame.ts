/**
 * TEST SUPPORT: a decoded frame in which EVERY field of the schema is filled with a plausible, non-default value,
 * built by walking schema.ts. Used by the coverage test and by the sanitiser round trip. Nothing real in it.
 */
import type { Decoded } from "../decode.js";
import { ENUMS, MESSAGES, ROOT_MESSAGE, type FieldSpec } from "../schema.js";

const shortEnum = (enumName: string, full: string): string => {
  const prefix = enumName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase() + "_";
  return (full.startsWith(prefix) ? full.slice(prefix.length) : full).toLowerCase();
};

function sample(message: string, field: FieldSpec): unknown {
  const t = field.type;
  if (t.startsWith("msg:")) return fill(t.slice(4));
  if (t.startsWith("enum:")) {
    const name = t.slice(5);
    const values = ENUMS[name]!;
    const first = Number(Object.keys(values).find((n) => Number(n) !== 0));
    return shortEnum(name, values[first]!);
  }
  switch (t) {
    case "bool":
      return true;
    case "float":
      if (field.name === "altitude") return 1500;
      if (field.name === "radar_altitude") return 1200;
      if (field.name === "heading") return 90;
      if (field.name === "max") return 1;
      return 0.5;
    case "string":
      return message === "VehicleState" && field.name === "manufacturer" ? "AEGS" : "AEGS_Test_123";
    case "int64":
      return 123_456;
    default:
      return 3;
  }
}

function fill(message: string): Decoded {
  const out: Decoded = {};
  for (const field of Object.values(MESSAGES[message]!)) {
    const value = sample(message, field);
    out[field.name] = field.repeated ? [value] : value;
  }
  return out;
}

export const fullFrame = (): Decoded => fill(ROOT_MESSAGE);
