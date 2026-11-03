import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeAs, decodeFrame } from "./decode.js";
import { ENUMS, MESSAGES } from "./schema.js";
import { WireError } from "./wire.js";

/** Bytes written by hand from the protobuf encoding rules, not produced by any encoder of ours. */
const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");

describe("Feature: reading the game's protobuf messages", () => {
  describe("Scenario: bytes worked out by hand from the wire format", () => {
    it("Given field 1 as a float 1.0 (0D 00 00 80 3F), Then Gauge.current is 1", () => {
      expect(decodeAs("Gauge", hex("0D 00 00 80 3F")).value).toEqual({ current: 1 });
    });

    it("Given a varint 300 (AC 02) in ActorState.uec_balance, Then it reads 300", () => {
      expect(decodeAs("ActorState", hex("20 AC 02")).value).toEqual({ uec_balance: 300 });
    });

    it("Given -1 as a 10-byte varint in an int32, Then it reads -1", () => {
      const bytes = hex("50 FF FF FF FF FF FF FF FF FF 01");
      expect(decodeAs("ActorVitals", bytes).value).toEqual({ intoxication_level: -1 });
    });

    it("Given a balance beyond 2^53, Then it is kept exact as a bigint", () => {
      // 2^60 = 0x1000000000000000 -> varint: 80 80 80 80 80 80 80 80 80 01 ... computed: 2^60 = 1 << 60
      const bytes = hex("20 80 80 80 80 80 80 80 80 10");
      expect(decodeAs("ActorState", bytes).value).toEqual({ uec_balance: 1n << 60n });
    });

    it("Given nested messages, Then the tree is rebuilt (actor.state.uec_balance)", () => {
      const bytes = hex("32 05 12 03 20 AC 02");
      expect(decodeFrame(bytes).frame).toEqual({ actor: { state: { uec_balance: 300 } } });
    });

    it("Given a string, Then it reads as UTF-8 text", () => {
      expect(decodeAs("ActorState", hex("1A 03 61 62 63")).value).toEqual({ seat_name: "abc" });
    });

    it("Given a repeated message field twice, Then both are kept in order", () => {
      // WeaponsFrame.countermeasures (5): {type=1 decoy, amount=2} and {type=2 noise}
      const bytes = hex("2A 04 08 01 10 02   2A 02 08 02");
      const { value } = decodeAs("WeaponsFrame", bytes);
      expect(value.countermeasures).toEqual([{ type: "decoy", amount: 2 }, { type: "noise" }]);
    });
  });

  describe("Scenario: the game says more or less than we know", () => {
    it("Given an enum number the schema does not know, Then it is kept as unknown_<n>", () => {
      expect(decodeAs("ActorState", hex("08 09")).value).toEqual({ locomotion: "unknown_9" });
    });

    it("Given an explicit enum 0, Then it reads as 'unspecified', not as missing", () => {
      expect(decodeAs("ActorState", hex("08 00")).value).toEqual({ locomotion: "unspecified" });
    });

    it("Given a field number the schema does not know, Then it is skipped, listed by number, and the rest still reads", () => {
      const { value, report } = decodeAs("Gauge", hex("48 05   0D 00 00 80 3F"));
      expect(value).toEqual({ current: 1 });
      expect(report.unknown).toEqual(["Gauge.9"]);
    });

    it("Given a known field in the wrong wire type, Then it is reported as an anomaly and skipped", () => {
      const { value, report } = decodeAs("Gauge", hex("08 01"));
      expect(value).toEqual({});
      expect(report.anomalies).toEqual(["Gauge.current: wire type 0"]);
    });

    it("Given a message cut short, Then decoding fails without echoing any byte", () => {
      expect(() => decodeAs("Gauge", hex("0D 00 00"))).toThrow(WireError);
      expect(() => decodeAs("Gauge", hex("0D 00 00"))).toThrow(/fixed32 cut short/);
    });

    it("Given a length beyond the message, Then it fails", () => {
      expect(() => decodeAs("ActorState", hex("1A 09 61"))).toThrow(/beyond the message/);
    });

    it("Given a legacy group (wire type 3), Then it fails as an unsupported wire type", () => {
      expect(() => decodeAs("Gauge", hex("0B"))).toThrow(/unsupported wire type 3/);
    });

    it("Given a varint longer than 10 bytes, Then it fails", () => {
      expect(() => decodeAs("ActorState", hex("20 80 80 80 80 80 80 80 80 80 80 01"))).toThrow(
        /10 bytes/,
      );
    });
  });
});

// --- the table against the proto file ----------------------------------------------------------------------------

interface ProtoField {
  name: string;
  type: string;
  repeated: boolean;
  optional: boolean;
}

function parseProto(text: string) {
  const messages: Record<string, Record<number, ProtoField>> = {};
  const enums: Record<string, Record<number, string>> = {};
  const stack: { kind: "message" | "enum" | "service"; name: string }[] = [];
  const clean = text.replace(/\/\/.*$/gm, "");
  for (const rawLine of clean.split("\n")) {
    const line = rawLine.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(message|enum|service)\s+(\w+)\s*\{/))) {
      const kind = m[1] as "message" | "enum" | "service";
      stack.push({ kind, name: m[2]! });
      if (kind === "message") messages[m[2]!] = {};
      if (kind === "enum") enums[m[2]!] = {};
      if (line.endsWith("}")) stack.pop();
      continue;
    }
    if (line === "}") {
      stack.pop();
      continue;
    }
    const top = stack[stack.length - 1];
    if (!top) continue;
    if (top.kind === "enum" && (m = line.match(/^(\w+)\s*=\s*(\d+);/))) {
      enums[top.name]![Number(m[2])] = m[1]!;
    } else if (
      top.kind === "message" &&
      (m = line.match(/^(optional\s+|repeated\s+)?([\w.]+)\s+(\w+)\s*=\s*(\d+);/))
    ) {
      messages[top.name]![Number(m[4])] = {
        name: m[3]!,
        type: m[2]!,
        repeated: m[1]?.trim() === "repeated",
        optional: m[1]?.trim() === "optional",
      };
    }
  }
  return { messages, enums };
}

describe("Feature: the decoder's schema table matches the reference .proto", () => {
  const proto = parseProto(
    fs.readFileSync(new URL("./sc_telemetry.proto", import.meta.url), "utf8"),
  );

  it("Given the proto, Then every message and enum is in the table and nothing extra is", () => {
    const protoMessages = Object.keys(proto.messages).filter((n) => n !== "TelemetryStreamRequest");
    expect(Object.keys(MESSAGES).sort()).toEqual(protoMessages.sort());
    expect(Object.keys(ENUMS).sort()).toEqual(Object.keys(proto.enums).sort());
  });

  it("Given each enum, Then its numbers and names are identical", () => {
    for (const [name, values] of Object.entries(proto.enums)) {
      expect(ENUMS[name], name).toEqual(values);
    }
  });

  it("Given each message, Then every field number, name, type, repeated and optional flag is identical", () => {
    const toType = (t: string): string =>
      ["bool", "float", "int32", "uint32", "int64", "string"].includes(t)
        ? t
        : t in proto.enums
          ? `enum:${t}`
          : `msg:${t}`;
    for (const [name, fields] of Object.entries(proto.messages)) {
      if (name === "TelemetryStreamRequest") continue;
      const expected = Object.fromEntries(
        Object.entries(fields).map(([num, f]) => [
          num,
          { name: f.name, type: toType(f.type), repeated: f.repeated, optional: f.optional },
        ]),
      );
      const actual = Object.fromEntries(
        Object.entries(MESSAGES[name]!).map(([num, f]) => [
          num,
          { name: f.name, type: f.type, repeated: !!f.repeated, optional: !!f.optional },
        ]),
      );
      expect(actual, name).toEqual(expected);
    }
  });
});
