/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { hashText, tailorPoll, type PollResult } from "./poll.js";
import { Scenario } from "./testing/scenario.js";
import { startPage } from "./testing/pageHarness.js";
import * as L from "./viewLogic.js";

const SECOND = 1000;

const fullPoll = (): PollResult => {
  const s = new Scenario();
  s.advanceTo(75_000);
  return s.poll(false);
};

describe("Feature: the answer is cut to what one View still needs", () => {
  it("Given no request details, Then everything comes back, as before", () => {
    const full = fullPoll();
    const out = tailorPoll(full, { includeBalance: false, includeStatic: true });
    expect(out).toEqual(full);
  });

  it("Given a View that does not ask for the static list, Then it is left out", () => {
    const out = tailorPoll(fullPoll(), { includeBalance: false });
    expect(out).not.toHaveProperty("not_in_stream");
  });

  it("Given the cursor of the events, Then only newer ones come back, and last_seq is always there", () => {
    const full = fullPoll();
    expect(full.events.length).toBeGreaterThan(3);
    const mid = full.events[2]!.seq;
    const out = tailorPoll(full, { includeBalance: false, sinceSeq: mid });
    expect(out.events.every((e) => e.seq > mid)).toBe(true);
    expect(out.events.length).toBe(full.events.filter((e) => e.seq > mid).length);
    expect(out.last_seq).toBe(full.last_seq);
    expect(tailorPoll(full, { includeBalance: false, sinceSeq: full.last_seq }).events).toEqual([]);
    expect(
      tailorPoll(full, { includeBalance: false, sinceSeq: full.last_seq + 50 }).events,
    ).toEqual(full.events);
  });

  it("Given the hashes it holds, Then only the sections that did not change are left out", () => {
    const full = fullPoll();
    const hash = full.hash!;
    const out = tailorPoll(full, {
      includeBalance: false,
      have: { ship: hash.ship, pilot: "0000000000000f", weapons: hash.weapons },
    });
    expect(out.unchanged).toEqual(["ship", "weapons"]);
    expect(out).not.toHaveProperty("ship");
    expect(out).not.toHaveProperty("weapons");
    expect(out.pilot).toEqual(full.pilot);
    expect(out.hash).toEqual(hash);
  });

  it("Given a section that is absent (null), Then it is sent as null, never reported as unchanged", () => {
    const s = new Scenario();
    s.advanceTo(8_000); // on foot: no ship, no weapons
    const full = s.poll(false);
    expect(full.ship).toBeNull();
    const out = tailorPoll(full, { includeBalance: false, have: { ship: full.hash!.ship } });
    expect(out.ship).toBeNull();
    expect(out).not.toHaveProperty("unchanged");
  });

  it("Given two different sections, Then their hashes differ, and the same text always gives the same hash", () => {
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).not.toBe(hashText("abd"));
    expect(hashText("")).toMatch(/^[0-9a-f]{14}$/);
  });
});

describe("Feature: the View puts the answer back together", () => {
  const T = 1_800_000_000_000;

  it("Given an answer that leaves out a section, Then the View keeps the one it holds and remembers the hashes", () => {
    const s = new Scenario();
    s.advanceTo(40_000);
    const first = s.poll(false);
    let view = L.reducePoll(L.initialViewState(), first, T);
    expect(view.hash.ship).toBe(first.hash!.ship);
    expect(view.notInStream).toContain("shield_level");
    const args = L.pollArguments(view, false);
    expect(args).not.toHaveProperty("include_static");
    expect(args.have.ship).toBe(first.hash!.ship);
    expect(args.since_seq).toBe(view.lastSeq);
    const cut = tailorPoll(first, {
      includeBalance: false,
      have: args.have,
      sinceSeq: args.since_seq,
    });
    expect(cut.unchanged).toBeDefined();
    view = L.reducePoll(view, JSON.parse(JSON.stringify(cut)), T + 1000);
    expect(view.poll.ship).toEqual(first.ship);
    expect(view.poll).not.toHaveProperty("unchanged");
    expect(view.poll.not_in_stream).toContain("shield_level");
  });

  it("Given an answer that leaves out a section the View does not have, Then it is an error and the next poll asks for everything", () => {
    const view = L.reducePoll(
      L.initialViewState(),
      { v: 1, state: "live", unchanged: ["ship"], hash: { ship: "abc" }, events: [], last_seq: 0 },
      T,
    );
    expect(view.link).toBe("error");
    expect(L.pollArguments(view, false)).not.toHaveProperty("have");
  });

  it("Given hostile hashes in an answer, Then only well-formed ones are kept", () => {
    const view = L.reducePoll(
      L.initialViewState(),
      { v: 1, state: "off", hash: { ship: "<script>", pilot: "abc123", weapons: 5 } },
      T,
    );
    expect(view.hash).toEqual({ pilot: "abc123" });
  });
});

describe("Feature: the dashboard asks for less and less", () => {
  async function bytesOver(seconds: number, legacy: boolean) {
    const w = await startPage({ scenario: new Scenario(), legacyFullPolls: legacy });
    await w.advance(seconds * SECOND);
    const polls = w.host.log.polls;
    const bytes = polls.reduce((n, p) => n + p.bytes, 0);
    return { polls: polls.length, bytes, perSecond: bytes / seconds };
  }

  it("Given the same two minutes of flight, Then the delta answers weigh clearly less than full ones", async () => {
    const before = await bytesOver(120, true);
    const after = await bytesOver(120, false);
    // A reproducible measurement on the fake game: printed so that the pull request can quote it.
    console.info(
      `poll weight over 120 s of the made-up flight: full ${before.polls} polls ${before.bytes} B (${before.perSecond.toFixed(0)} B/s); delta ${after.polls} polls ${after.bytes} B (${after.perSecond.toFixed(0)} B/s); ratio ${(after.bytes / before.bytes).toFixed(2)}`,
    );
    expect(after.bytes).toBeLessThan(before.bytes * 0.8);
    expect(Math.abs(after.polls - before.polls)).toBeLessThan(15);
  });

  it("Given a View, Then it asks for the static list once and not again", async () => {
    const w = await startPage({ scenario: new Scenario() });
    await w.advance(20 * SECOND);
    const asks = w.host.log.received
      .filter((r) => r.method === "tools/call")
      .map((r) => r.params.arguments);
    expect(asks.filter((a: any) => a.include_static).length).toBeLessThanOrEqual(8); // waiting states have none yet
    const late = asks.slice(-5);
    for (const a of late) expect(a.include_static).toBeUndefined();
    expect(late.some((a: any) => a.since_seq > 0)).toBe(true);
  });
});

describe("Feature: memory stays bounded and nothing is left running", () => {
  it("Given an hour of live answers, Then every curve and the event list stay under their ceilings", () => {
    const cfg = L.viewConfig();
    let view = L.initialViewState();
    const base = {
      v: 1,
      state: "live",
      frame_age_ms: 100,
      last_seq: 0,
      events: [] as any[],
      pilot: {
        health: { current: 80, max: 100, percent: 0.8 },
        hunger: { current: 50, max: 100, percent: 0.5 },
        thirst: { current: 50, max: 100, percent: 0.5 },
        heart_rate_bpm: 70,
      },
    };
    for (let i = 0; i < 3600; i++) {
      const poll = {
        ...base,
        last_seq: i,
        events: [
          { seq: i, type: "landed", group: "ship", confidence: "confirmed", at: "x", data: {} },
        ],
        ship: {
          name: "DRAK_Cutter_1",
          instruments: {
            speed_ms: i % 300,
            vertical_speed_ms: 1,
            hydrogen_fuel: 0.5,
            altitude_m: 100,
            g: { current: 1, max: 9 },
            boost: { reserves: 1 },
          },
        },
      };
      view = L.reducePoll(view, poll, T0 + i * 500);
    }
    for (const [key, list] of Object.entries<any[]>(view.series)) {
      expect(list.length, key).toBeLessThanOrEqual(cfg.maxSamples);
    }
    // The curves drawn use 60 s; only the estimates keep longer, and only for three series.
    expect(view.series.speed.length).toBeLessThanOrEqual(Math.ceil(cfg.sparkKeepMs / 500) + 1);
    expect(view.events.length).toBeLessThanOrEqual(cfg.eventCap);
  });

  it("Given a View torn down by the host, Then no listener, observer, channel or timer remains", async () => {
    const w = await startPage();
    await w.advance(10 * SECOND);
    expect(w.listenerCount()).toBeGreaterThan(0);
    await w.host.request("ui/resource-teardown");
    await w.advance(100);
    expect(w.listenerCount()).toBe(0);
    expect(w.pendingTimers()).toBe(0);
    expect(w.bus!.open).toBe(0);
    // And a late message from the host changes nothing.
    const posted = w.posted.length;
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: {} },
    });
    await w.advance(5 * SECOND);
    expect(w.posted.length).toBe(posted);
  });

  it("Given a hidden View, Then it keeps no timer (its listeners stay: they are how it wakes up)", async () => {
    const w = await startPage();
    await w.advance(10 * SECOND);
    w.setHidden(true);
    await w.advance(100);
    expect(w.pendingTimers()).toBe(0);
    expect(w.listenerCount()).toBeGreaterThan(0);
  });

  it("Given the page is hidden for good (pagehide), Then everything is released too", async () => {
    const w = await startPage();
    await w.advance(5 * SECOND);
    w.firePageHide();
    await w.advance(100);
    expect(w.listenerCount()).toBe(0);
    expect(w.bus!.open).toBe(0);
    expect(w.pendingTimers()).toBe(0);
  });
});

const T0 = 1_800_000_000_000;
