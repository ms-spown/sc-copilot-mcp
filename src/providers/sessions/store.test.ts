import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, parseState, SessionStore } from "./store.js";
import { session, stamp, NOW } from "./fixtures.testing.js";
import {
  MAX_FILE_BYTES,
  MAX_SESSIONS,
  SESSIONS_VERSION,
  type Session,
  type StoreState,
} from "./types.js";

/** Feature: the session file survives crashes, other processes, bad content and newer versions. */

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-sessions-"));
  file = path.join(dir, "data", "sessions.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const add = (s: Session) => (d: StoreState) => {
  d.sessions.push(s);
  d.next_number = s.number + 1;
  return { changed: true, result: s.id };
};

const files = () => (fs.existsSync(path.dirname(file)) ? fs.readdirSync(path.dirname(file)) : []);

describe("Feature: reading never creates anything", () => {
  it("Given no file, When reading, Then the state is empty and neither the file nor its folder exist", async () => {
    const store = new SessionStore(file);
    expect((await store.read()).sessions).toEqual([]);
    expect(fs.existsSync(path.dirname(file))).toBe(false);
  });

  it("Given a change that changes nothing, Then no file is written", async () => {
    const store = new SessionStore(file);
    const r = await store.transact(() => ({ changed: false, result: 1 }));
    expect(r.written).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("Feature: a change is saved atomically and read back", () => {
  it("Given a change, Then the file is valid JSON of the current version and no temporary file stays", async () => {
    const store = new SessionStore(file, { now: () => NOW });
    await store.transact(add(session(1)));
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(doc.version).toBe(SESSIONS_VERSION);
    expect(doc.revision).toBe(1);
    expect(doc.saved_at).toBe(stamp());
    expect(doc.sessions).toHaveLength(1);
    expect(files().filter((n) => n.endsWith(".tmp") || n.endsWith(".lock"))).toEqual([]);
    const other = new SessionStore(file);
    expect((await other.read()).sessions[0].start_balance).toBe(1000);
  });

  it("Given the file changed under a cached reader (another process), Then the reader sees it", async () => {
    const a = new SessionStore(file);
    const b = new SessionStore(file);
    await a.transact(add(session(1)));
    expect((await b.read()).sessions).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    await a.transact(add(session(2)));
    expect((await b.read()).sessions).toHaveLength(2);
  });

  it("Given a UTF-8 byte order mark (edited by hand), Then the file still reads", async () => {
    const store = new SessionStore(file);
    await store.transact(add(session(1)));
    fs.writeFileSync(file, "\ufeff" + fs.readFileSync(file, "utf8"));
    expect((await new SessionStore(file).read()).sessions).toHaveLength(1);
  });
});

describe("Feature: a bad file is set aside, never crashes the server, never deletes the player's data", () => {
  it.each([
    ["empty", ""],
    ["not JSON", "this is not json {"],
    ["foreign shape: an array", "[1,2,3]"],
    ["foreign shape: other document", JSON.stringify({ hello: "world" })],
    ["no sessions list", JSON.stringify({ version: 1, sessions: "x" })],
    ["truncated write", '{"version":1,"revision":4,"sessions":[{"id":"s_a'],
  ])(
    "Given a %s file, When a change is made, Then it is renamed aside and the store starts clean",
    async (_n, content) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      const store = new SessionStore(file, { now: () => NOW });
      expect((await store.read()).sessions).toEqual([]); // reading does not touch it
      expect(fs.readFileSync(file, "utf8")).toBe(content);
      await store.transact(add(session(1)));
      const aside = files().filter((n) => n.includes(".corrupt-"));
      expect(aside).toHaveLength(1);
      expect(fs.readFileSync(path.join(path.dirname(file), aside[0]), "utf8")).toBe(content);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).sessions).toHaveLength(1);
      expect(store.notice).toMatch(/set aside/);
    },
  );

  it("Given a file larger than the bound, Then it is not parsed and is set aside", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, " ".repeat(MAX_FILE_BYTES + 10));
    const store = new SessionStore(file);
    expect((await store.read()).sessions).toEqual([]);
    await store.transact(add(session(1)));
    expect(files().some((n) => n.includes(".corrupt-"))).toBe(true);
  });

  it("Given many bad files over time, Then only the three newest set-aside copies are kept", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(file, `garbage ${i}`);
      const store = new SessionStore(file, { now: () => NOW + i * 1000 });
      await store.transact(add(session(1)));
      fs.rmSync(file);
    }
    expect(files().filter((n) => n.includes(".corrupt-"))).toHaveLength(3);
  });

  it("Given one invalid session among good ones, Then the good ones are kept, the file is copied before the next write", async () => {
    const good = session(1);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const doc = {
      version: 1,
      revision: 3,
      saved_at: null,
      next_number: 3,
      sessions: [good, { id: "nope", number: "x" }, session(2, { id: good.id })],
    };
    fs.writeFileSync(file, JSON.stringify(doc));
    const store = new SessionStore(file);
    expect((await store.read()).sessions.map((s) => s.number)).toEqual([1]);
    await store.transact(add(session(2, { id: "s_test_other" })));
    expect(files().some((n) => n.includes(".bak-"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).sessions).toHaveLength(2);
  });

  it("Given a file with a duplicate session number, Then the later duplicate is dropped", () => {
    const r = parseState(
      JSON.stringify({ version: 1, sessions: [session(1), session(1, { id: "s_test_dup" })] }),
    );
    expect(r.kind === "ok" && r.state.sessions.length).toBe(1);
    expect(r.kind === "ok" && r.dropped).toBe(1);
  });
});

describe("Feature: a file from a newer version is never touched", () => {
  it("Given version 99, Then sessions live in memory only, the file is byte for byte unchanged and the notice says so", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const content = JSON.stringify({ version: 99, sessions: [{ whatever: true }] });
    fs.writeFileSync(file, content);
    const store = new SessionStore(file);
    await store.read();
    expect(store.readOnly).toBe(true);
    const r = await store.transact(add(session(1)));
    expect(r.written).toBe(false);
    expect((await store.read()).sessions).toHaveLength(1);
    expect(fs.readFileSync(file, "utf8")).toBe(content);
    expect(files()).toEqual(["sessions.json"]);
    expect(store.notice).toMatch(/newer version \(99\)/);
  });
});

describe("Feature: the format can change without losing sessions (migration stub)", () => {
  it("Given a version 0 document, Then it is migrated to the current version and the counters are filled in", () => {
    const r = parseState(JSON.stringify({ version: 0, sessions: [session(4)] }));
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.state.version).toBe(SESSIONS_VERSION);
      expect(r.state.next_number).toBe(5);
      expect(r.state.sessions).toHaveLength(1);
    }
    expect(Object.keys(MIGRATIONS)).toContain("0");
  });

  it("Given an old version with no migration step, Then it is invalid (set aside), not guessed", () => {
    const saved = MIGRATIONS[0];
    delete MIGRATIONS[0];
    try {
      expect(parseState(JSON.stringify({ version: 0, sessions: [] })).kind).toBe("invalid");
    } finally {
      MIGRATIONS[0] = saved;
    }
  });
});

describe("Feature: the file stays bounded", () => {
  it("Given more sessions than the bound, Then the oldest go first and the newest is kept", async () => {
    const store = new SessionStore(file);
    await store.transact((d) => {
      for (let i = 1; i <= MAX_SESSIONS + 5; i++) d.sessions.push(session(i));
      d.next_number = MAX_SESSIONS + 6;
      return { changed: true, result: null };
    });
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(doc.sessions).toHaveLength(MAX_SESSIONS);
    expect(doc.sessions[0].number).toBe(6);
    expect(doc.sessions[MAX_SESSIONS - 1].number).toBe(MAX_SESSIONS + 5);
  });

  it("Given a session of the file with out-of-range values, Then it is rejected rather than trusted", () => {
    const hostile = session(1, { active_ms: -5 });
    const r = parseState(JSON.stringify({ version: 1, sessions: [hostile] }));
    expect(r.kind === "ok" && r.state.sessions).toEqual([]);
  });
});

describe("Feature: the file holds only the summary numbers", () => {
  it("Given a saved session, Then no field is a frame, a handle, an address or a game identifier", async () => {
    const store = new SessionStore(file);
    await store.transact(add(session(1)));
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
    };
    walk(JSON.parse(fs.readFileSync(file, "utf8")));
    const words = new Set([
      "handle",
      "account",
      "ip",
      "address",
      "guid",
      "frame",
      "raw",
      "line",
      "mission",
      "player",
    ]);
    expect([...keys].filter((k) => k.split("_").some((w) => words.has(w)))).toEqual([]);
  });
});
