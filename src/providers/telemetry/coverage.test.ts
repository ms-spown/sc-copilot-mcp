import { describe, expect, it } from "vitest";
import { buildPoll } from "../../dashboard/poll.js";
import { COVERAGE, REASONS, WIDGETS } from "./coverage.js";
import type { Decoded } from "./decode.js";
import { TelemetryHandler } from "./handler.js";
import { normalizeFrame, NO_PLANET_ALTITUDE } from "./normalize.js";
import { ENUMS, MESSAGES, ROOT_MESSAGE, type FieldSpec } from "./schema.js";

/**
 * The coverage table (coverage.ts) must name every field of the schema, nothing else, and every `exposed:` path must
 * lead to a real value in the answers built from a frame in which EVERY field of the schema is filled. A schema
 * change (a new field in a patch) fails here until someone decides what to do with it.
 */

const schemaFields = (): string[] =>
  Object.entries(MESSAGES).flatMap(([message, fields]) =>
    Object.values(fields).map((f) => `${message}.${f.name}`),
  );

describe("Feature: every field of the stream has a decision", () => {
  it("Given the schema, Then every field has an entry in the coverage table, and the table names no other field", () => {
    const fields = new Set(schemaFields());
    const missing = [...fields].filter((f) => !(f in COVERAGE));
    const stale = Object.keys(COVERAGE).filter((k) => !fields.has(k));
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  it("Given each entry, Then it is `exposed:<path>` or `ignored:<known reason>` on both sides", () => {
    for (const [key, entry] of Object.entries(COVERAGE)) {
      expect(entry.server, key).toMatch(/^(exposed:(poll|state)\.[a-z_.[\]0-9]+|ignored:[a-z_]+)$/);
      expect(entry.view, key).toMatch(/^(view:[a-z_]+|ignored:[a-z_]+)$/);
      for (const side of [entry.server, entry.view]) {
        if (side.startsWith("ignored:")) {
          expect(Object.keys(REASONS), `${key}: reason`).toContain(side.slice("ignored:".length));
        }
      }
      if (entry.view.startsWith("view:")) {
        expect(Object.keys(WIDGETS), `${key}: widget`).toContain(entry.view.slice("view:".length));
        expect(entry.server.startsWith("exposed:"), `${key}: shown but not exposed`).toBe(true);
      }
    }
  });
});

// --- a frame in which every field is filled ---------------------------------------------------------------------

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

function answers() {
  const frame = fill(ROOT_MESSAGE);
  const handler = new TelemetryHandler();
  handler.update(normalizeFrame(frame), 1000);
  const state = handler.latest!;
  const poll = buildPoll({
    status: {
      state: "live",
      cause: "x",
      frames_received: 1,
      frames_rejected: 0,
      reconnects: 0,
      unknown_fields: [],
      anomalies: [],
      not_in_stream: [],
      idle_stop_ms: 1,
    },
    snapshot: {
      state,
      frame_age_ms: 10,
      received_at: new Date(1000).toISOString(),
      uec_session: { start: 1, current: 2, delta: 1, since: new Date(0).toISOString() },
    },
    events: [],
    lastSeq: 0,
    sessionEvents: [],
    session: { startedAt: null, endedAt: null, startSeq: 0, endSeq: null, markers: [] },
    includeBalance: true,
    nowMs: 1010,
  });
  return {
    poll: JSON.parse(JSON.stringify(poll)) as unknown,
    state: JSON.parse(JSON.stringify(state)) as unknown,
  };
}

function resolve(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    const isList = part.endsWith("[]");
    const key = isList ? part.slice(0, -2) : part;
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
    if (isList) {
      if (!Array.isArray(cur) || cur.length === 0) return undefined;
      cur = cur[0];
    }
  }
  return cur;
}

describe("Feature: what the table calls exposed really is", () => {
  const { poll, state } = answers();

  it("Given a frame with every field filled, Then the poll shows the ship, pilot and weapons of it", () => {
    expect(resolve(poll, "ship.instruments.altitude_m")).toBe(1500);
    expect(NO_PLANET_ALTITUDE).toBeGreaterThan(1500);
    expect(resolve(poll, "weapons.weapons")).toHaveLength(1);
  });

  it.each(Object.entries(COVERAGE).filter(([, e]) => e.server.startsWith("exposed:")))(
    "Given %s, Then its path leads to a value",
    (key, entry) => {
      const path = entry.server.slice("exposed:".length);
      const root = path.startsWith("poll.") ? poll : state;
      const value = resolve(root, path.slice(path.indexOf(".") + 1));
      expect(value, `${key} -> ${path}`).not.toBeUndefined();
      expect(value, `${key} -> ${path}`).not.toBeNull();
    },
  );
});
