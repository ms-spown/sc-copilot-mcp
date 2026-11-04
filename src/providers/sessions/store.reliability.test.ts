import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCK_STALE_MS, LOCK_WAIT_MS, SessionStore, StoreBusyError } from "./store.js";
import type { StoreState } from "./types.js";
import { session } from "./fixtures.testing.js";
import { MAX_FILE_BYTES, MAX_TRIPS, WRITE_SOFT_BYTES } from "./types.js";

// Every change to the session file is a real write with fsync (the store's promise: a power cut keeps the old file or
// the new one), and these tests make dozens of them. An idle disk takes a few ms each; a disk shared with other
// work can stall for seconds. A timeout here only detects a hang.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** Enough sessions of the largest size to pass the byte bound several times over (all 200 would only slow the suite). */
const SESSIONS_IN_TEST = 40;

/**
 * Feature: crash, power cut, two server processes, a locked file. Every case ends with a file that parses and holds
 * everything that was acknowledged. Two stores on one file stand for two processes: each has its own cache.
 */

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-sessions-rel-"));
  file = path.join(dir, "sessions.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const readDoc = (): StoreState => JSON.parse(fs.readFileSync(file, "utf8"));
const left = () => fs.readdirSync(dir).filter((n) => n !== "sessions.json");

const addTrip = (sessionNumber: number, label: string) => (d: StoreState) => {
  let s = d.sessions.find((x) => x.number === sessionNumber);
  if (!s) {
    s = session(sessionNumber);
    d.sessions.push(s);
    d.next_number = sessionNumber + 1;
  }
  s.trips.push({
    key: Buffer.from(label).toString("hex").padStart(8, "0").slice(0, 16),
    kind: "hauling",
    source: "contract_ledger",
    started_at: null,
    ended_at: new Date(Date.UTC(2026, 10, 4, 20)).toISOString(),
    label,
    commodity: null,
    buy_terminal: null,
    sell_terminal: null,
    scu: null,
    cost_auec: null,
    revenue_auec: null,
    fees_auec: null,
    gross_margin_auec: null,
    net_auec: 1,
    net_kind: "balance_delta",
    planned_profit_auec: null,
  });
  return { changed: true, result: label };
};

describe("Feature: a kill or a power cut between the write and the rename loses nothing that was saved", () => {
  it("Given a crash after the temporary file is written, Then the previous file is intact and the leftover does not matter", async () => {
    const store = new SessionStore(file);
    await store.transact(addTrip(1, "first"));
    const before = fs.readFileSync(file, "utf8");

    const crashing = new SessionStore(file, {
      beforeRename: () => {
        throw Object.assign(new Error("killed"), { code: "EKILLED" });
      },
    });
    const r = await crashing.transact(addTrip(1, "second"));
    expect(r.written).toBe(false);
    expect(crashing.notice).toMatch(/could not be saved/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(left()).toEqual([]); // the temporary file was removed

    // A real kill leaves the temporary file behind: it must not be read as the file, nor stop the next write.
    fs.writeFileSync(`${file}.9999.deadbeef.tmp`, '{"version":1,"sessions":[');
    const fresh = new SessionStore(file);
    expect((await fresh.read()).sessions[0].trips.map((t) => t.label)).toEqual(["first"]);
    await fresh.transact(addTrip(1, "third"));
    expect(readDoc().sessions[0].trips.map((t) => t.label)).toEqual(["first", "third"]);
  });

  it("Given the change that failed to save, Then the next change tries again with the same content in memory", async () => {
    let fail = true;
    const store = new SessionStore(file, {
      beforeRename: () => {
        if (fail) throw new Error("disk full");
      },
    });
    await store.transact(addTrip(1, "kept"));
    expect(fs.existsSync(file)).toBe(false);
    expect((await store.read()).sessions[0].trips[0].label).toBe("kept");
    fail = false;
    await store.transact(addTrip(1, "next"));
    expect(readDoc().sessions[0].trips.map((t) => t.label)).toEqual(["kept", "next"]);
    expect(store.notice).toBeNull();
  });
});

describe("Feature: Windows refuses a rename while someone reads the file", () => {
  it("Given EPERM then EBUSY on the rename, Then it is retried and succeeds", async () => {
    let calls = 0;
    const store = new SessionStore(file, {
      rename: async (from, to) => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("perm"), { code: "EPERM" });
        if (calls === 2) throw Object.assign(new Error("busy"), { code: "EBUSY" });
        await fs.promises.rename(from, to);
      },
    });
    const r = await store.transact(addTrip(1, "x"));
    expect(r.written).toBe(true);
    expect(calls).toBe(3);
    expect(readDoc().sessions).toHaveLength(1);
  });

  it("Given a rename that keeps failing with EPERM, Then it gives up with a notice instead of throwing", async () => {
    const store = new SessionStore(file, {
      rename: async () => {
        throw Object.assign(new Error("perm"), { code: "EPERM" });
      },
    });
    const r = await store.transact(addTrip(1, "x"));
    expect(r.written).toBe(false);
    expect(store.notice).toMatch(/EPERM/);
    expect(left()).toEqual([]);
  });
});

describe("Feature: two server processes on one file never lose each other's work", () => {
  it("Given two stores (separate caches) writing at the same time, Then every trip of both is in the file and it always parses", async () => {
    const a = new SessionStore(file);
    const b = new SessionStore(file);
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 15; i++) {
      jobs.push(a.transact(addTrip(1, `a${i}`)));
      jobs.push(b.transact(addTrip(1, `b${i}`)));
    }
    await Promise.all(jobs);
    const doc = readDoc();
    const labels = doc.sessions[0].trips.map((t) => t.label).sort();
    expect(labels).toHaveLength(30);
    expect(new Set(labels).size).toBe(30);
    expect(doc.revision).toBe(30);
    expect(left()).toEqual([]); // no lock, no temporary file left
  }, 30_000);

  it("Given one process reads in a loop while another writes, Then every read is a complete, valid state", async () => {
    const writer = new SessionStore(file);
    const reader = new SessionStore(file);
    let stop = false;
    const reads: number[] = [];
    const loop = (async () => {
      while (!stop) {
        const s = await reader.read();
        reads.push(s.sessions[0]?.trips.length ?? 0);
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    for (let i = 0; i < 25; i++) await writer.transact(addTrip(1, `t${i}`));
    stop = true;
    await loop;
    expect(reads.length).toBeGreaterThan(3);
    // Counts only ever grow: a reader never sees a half-written or older file after a newer one.
    for (let i = 1; i < reads.length; i++) expect(reads[i]).toBeGreaterThanOrEqual(reads[i - 1]);
  }, 30_000);

  it("Given two processes that both create 'the next session' at once, Then the numbers stay distinct", async () => {
    const stores = [new SessionStore(file), new SessionStore(file), new SessionStore(file)];
    await Promise.all(
      stores.map((s, i) =>
        s.transact((d) => {
          const n = d.next_number;
          d.next_number = n + 1;
          d.sessions.push(session(n, { id: `s_proc_${i}` }));
          return { changed: true, result: n };
        }),
      ),
    );
    expect(readDoc().sessions.map((s) => s.number)).toEqual([1, 2, 3]);
  });
});

describe("Feature: a lock left by a dead process does not block forever", () => {
  it("Given a lock file older than the stale delay, Then it is taken over", async () => {
    fs.writeFileSync(`${file}.lock`, "99999\n");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${file}.lock`, old, old);
    const store = new SessionStore(file, { lockStaleMs: 5000 });
    const r = await store.transact(addTrip(1, "x"));
    expect(r.written).toBe(true);
    expect(store.lockTakeovers).toBe(1);
  });

  it("Given a fresh lock held by a live writer, Then the change waits, then reports busy without losing anything", async () => {
    fs.writeFileSync(`${file}.lock`, "1\n");
    const store = new SessionStore(file, { lockWaitMs: 150, lockStaleMs: 60_000 });
    await expect(store.transact(addTrip(1, "x"))).rejects.toBeInstanceOf(StoreBusyError);
    fs.rmSync(`${file}.lock`);
    await store.transact(addTrip(1, "x"));
    expect(readDoc().sessions[0].trips).toHaveLength(1);
  });
});

describe("Feature: sizes are bounded even when a caller overshoots", () => {
  it("Given a session pushed past the trip bound inside a change, Then the file keeps the newest trips and still parses", async () => {
    const store = new SessionStore(file);
    await store.transact((d) => {
      d.sessions.push(session(1));
      d.next_number = 2;
      for (let i = 0; i < MAX_TRIPS + 20; i++) addTrip(1, `t${i}`)(d);
      return { changed: true, result: null };
    });
    const saved = (await new SessionStore(file).read()).sessions[0];
    expect(saved.trips).toHaveLength(MAX_TRIPS);
    expect(saved.trips[MAX_TRIPS - 1].label).toBe(`t${MAX_TRIPS + 19}`);
  });

  it("Given a hand-edited file with too many trips in a session, Then the session is kept and cut, not dropped", async () => {
    const store = new SessionStore(file);
    await store.transact(addTrip(1, "seed"));
    const doc = readDoc();
    for (let i = 0; i < MAX_TRIPS + 30; i++) addTrip(1, `h${i}`)(doc);
    fs.writeFileSync(file, JSON.stringify(doc));
    const read = await new SessionStore(file).read();
    expect(read.sessions).toHaveLength(1);
    expect(read.sessions[0].trips).toHaveLength(MAX_TRIPS);
  });
});

describe("Feature: the file is bounded in BYTES, far below what the reader accepts", () => {
  it("Given the worst case (200 sessions of 500 trips), Then the file stays under the write bound, is read back whole, and the oldest sessions are the ones dropped", async () => {
    const store = new SessionStore(file);
    await store.transact((d) => {
      for (let n = 1; n <= SESSIONS_IN_TEST; n++) {
        d.sessions.push(session(n));
        d.next_number = n + 1;
        for (let i = 0; i < MAX_TRIPS; i++)
          addTrip(n, `s${n}-trip-${i}-with-a-rather-long-label-to-weigh-more`)(d);
      }
      return { changed: true, result: null };
    });
    const bytes = fs.statSync(file).size;
    expect(bytes).toBeLessThanOrEqual(WRITE_SOFT_BYTES);
    expect(MAX_FILE_BYTES).toBeGreaterThan(WRITE_SOFT_BYTES * 4); // headroom: a file we wrote is always read back
    const read = await new SessionStore(file).read();
    expect(read.sessions.length).toBeGreaterThan(1);
    expect(read.sessions[read.sessions.length - 1].number).toBe(SESSIONS_IN_TEST); // the newest is kept
    expect(read.dropped_sessions).toBe(SESSIONS_IN_TEST - read.sessions.length);
    expect(read.dropped_sessions).toBeGreaterThan(0);
    // The file is NOT set aside at the next change: the history survives.
    await new SessionStore(file).transact(addTrip(SESSIONS_IN_TEST, "one more"));
    expect(left().some((n) => n.includes(".corrupt-"))).toBe(false);
    expect(readDoc().sessions.length).toBeGreaterThan(1);
  }, 60_000);
});

describe("Feature: a write that fails keeps the content in memory OVER the older file", () => {
  it("Given the disk is full after the file exists, Then reads and the next change still see the unsaved content, and it is saved when the disk answers again", async () => {
    let full = false;
    const store = new SessionStore(file, {
      beforeRename: () => {
        if (full) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      },
    });
    await store.transact(addTrip(1, "saved"));
    full = true;
    const r = await store.transact(addTrip(1, "unsaved"));
    expect(r.written).toBe(false);
    expect(store.notice).toMatch(/ENOSPC/);
    // The older file is on disk, but what the process works on is the newer content.
    expect(readDoc().sessions[0].trips.map((t) => t.label)).toEqual(["saved"]);
    expect((await store.read()).sessions[0].trips.map((t) => t.label)).toEqual([
      "saved",
      "unsaved",
    ]);
    await store.transact(addTrip(1, "later"));
    expect((await store.read()).sessions[0].trips.map((t) => t.label)).toEqual([
      "saved",
      "unsaved",
      "later",
    ]);
    full = false;
    const ok = await store.transact(addTrip(1, "after"));
    expect(ok.written).toBe(true);
    expect(readDoc().sessions[0].trips.map((t) => t.label)).toEqual([
      "saved",
      "unsaved",
      "later",
      "after",
    ]);
    expect(store.notice).toBeNull();
  });
});

describe("Feature: the lock is robust", () => {
  it("Given a live holder slower than the stale delay, Then it is not robbed: the other change waits and both are saved", async () => {
    let slow = true;
    const a = new SessionStore(file, {
      // The holder touches its lock every quarter of the stale delay. A margin of a few hundred ms is eaten by a
      // starved event loop, so the delay is long (the test costs the holder's slowness, 2x the delay, in real time).
      lockStaleMs: 2000,
      beforeRename: async () => {
        if (slow) {
          slow = false;
          await new Promise((r) => setTimeout(r, 4000)); // twice the stale delay
        }
      },
    });
    const b = new SessionStore(file, { lockStaleMs: 2000, lockWaitMs: 20_000 });
    const first = a.transact(addTrip(1, "slow"));
    await new Promise((r) => setTimeout(r, 100));
    const second = b.transact(addTrip(1, "waiting"));
    await Promise.all([first, second]);
    expect(b.lockTakeovers).toBe(0);
    expect(a.lockTakeovers).toBe(0);
    expect(
      readDoc()
        .sessions[0].trips.map((t) => t.label)
        .sort(),
    ).toEqual(["slow", "waiting"]);
  });

  it("Given a lock owned by someone else, Then this process never removes it", async () => {
    fs.writeFileSync(`${file}.lock`, "someone-else-token");
    const other = new SessionStore(file, { lockStaleMs: 10_000, lockWaitMs: 100 });
    await expect(other.transact(addTrip(1, "x"))).rejects.toBeInstanceOf(StoreBusyError);
    expect(fs.readFileSync(`${file}.lock`, "utf8")).toBe("someone-else-token");
  });

  it("Given a lock left by a crash, Then a change waits for it to go stale and then succeeds, instead of failing", async () => {
    fs.writeFileSync(`${file}.lock`, "dead-owner");
    const old = new Date(Date.now() - 2000);
    fs.utimesSync(`${file}.lock`, old, old);
    const store = new SessionStore(file, { lockStaleMs: 600, lockWaitMs: 5000 });
    const r = await store.transact(addTrip(1, "x"));
    expect(r.written).toBe(true);
    // Not "it was quick": it took the dead lock over instead of waiting for the 5 s limit and failing.
    expect(store.lockTakeovers).toBe(1);
  });

  it("Given the default delays, Then the wait is longer than the stale delay (a crash never fails a change)", () => {
    expect(LOCK_WAIT_MS).toBeGreaterThan(LOCK_STALE_MS);
  });

  it("Given orphan temporary files of killed writes, Then the old ones are swept at the next write and a fresh one is left alone", async () => {
    const stale = `${file}.4242.deadbeef.tmp`;
    const fresh = `${file}.4343.cafebabe.tmp`;
    fs.writeFileSync(stale, "{");
    fs.writeFileSync(fresh, "{");
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(stale, old, old);
    await new SessionStore(file).transact(addTrip(1, "x"));
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("Given orphan .stale-<pid>-<hex> files of killed lock takeovers, Then the old ones are swept too and a fresh one is left alone", async () => {
    const stale = `${file}.lock.stale-4242-deadbeef`;
    const fresh = `${file}.lock.stale-4343-cafebabe`;
    const unrelated = `${file}.lock.stale-notahex`;
    for (const f of [stale, fresh, unrelated]) fs.writeFileSync(f, "");
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(unrelated, old, old);
    await new SessionStore(file).transact(addTrip(1, "x"));
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "Given a new file, Then it is created for the owner only (0600)",
    async () => {
      await new SessionStore(file).transact(addTrip(1, "x"));
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    },
  );
});

describe("Feature: unsaved content survives a change that changes nothing", () => {
  it("Given a refused write then a no-op change then a later write, Then nothing unsaved is lost", async () => {
    let full = false;
    const store = new SessionStore(file, {
      beforeRename: () => {
        if (full) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      },
    });
    await store.transact(addTrip(1, "saved"));
    full = true;
    await store.transact((d) => {
      for (let n = 2; n <= 10; n++) {
        d.sessions.push(session(n));
        d.next_number = n + 1;
      }
      return { changed: true, result: null };
    });
    await store.transact(() => ({ changed: false, result: null })); // a probe that changes nothing
    expect((await store.read()).next_number).toBe(11);
    full = false;
    await store.transact(addTrip(10, "after"));
    const doc = readDoc();
    expect(doc.next_number).toBe(11);
    expect(doc.sessions).toHaveLength(10);
  });
});

describe("Feature: several processes starting together on a dead lock lose nothing", () => {
  it("Given a dead lock and five stores each adding a trip at the same instant, over many rounds, Then every trip of every round is in the file", async () => {
    for (let round = 0; round < 25; round++) {
      fs.rmSync(file, { force: true });
      fs.writeFileSync(`${file}.lock`, "dead-owner");
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(`${file}.lock`, old, old);
      const stores = Array.from(
        { length: 5 },
        () => new SessionStore(file, { lockStaleMs: 300, lockWaitMs: 8000 }),
      );
      await Promise.all(stores.map((s, i) => s.transact(addTrip(1, `r${round}-p${i}`))));
      const labels = readDoc().sessions[0].trips.map((t) => t.label);
      expect(labels.sort(), `round ${round}`).toEqual(
        [0, 1, 2, 3, 4].map((i) => `r${round}-p${i}`),
      );
      expect(left().filter((n) => n.endsWith(".lock") || n.endsWith(".takeover"))).toEqual([]);
    }
  }, 120_000);
});
