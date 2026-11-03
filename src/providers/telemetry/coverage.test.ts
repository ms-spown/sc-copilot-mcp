import { describe, expect, it } from "vitest";
import { fullAnswers } from "../../dashboard/testing/fullPoll.js";
import { COVERAGE, REASONS, WIDGETS } from "./coverage.js";
import { NO_PLANET_ALTITUDE } from "./normalize.js";
import { MESSAGES } from "./schema.js";

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

function answers() {
  const { poll, state } = fullAnswers();
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
