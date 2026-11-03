/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { Scenario } from "./testing/scenario.js";
import { fullAnswers } from "./testing/fullPoll.js";
import {
  FakeBus,
  VirtualClock,
  findButton,
  isShown,
  startPage,
  visibleText,
  type PageWorld,
} from "./testing/pageHarness.js";
import * as L from "./viewLogic.js";

/**
 * Several dashboards in one conversation. The host never unmounts the old ones: every View that is on screen used
 * to ask the server once a second. Now the most recent visible View polls and shares what it gets; the others
 * show a banner and follow. Time is virtual and shared by all the pages of a test.
 */

const SECOND = 1000;
const T0 = 1_800_000_000_000;
const CHANNEL = L.viewConfig().channelName;
const BALANCE_DIGITS = /\b250\s?000\b|\b434\s?500\b/;
const BANNER = "Remplacé par un tableau de bord plus récent";

async function views(count: number, options: { bus?: FakeBus | null } = {}) {
  const scenario = new Scenario();
  const clock = new VirtualClock(scenario.epoch);
  const bus = options.bus === undefined ? new FakeBus() : options.bus;
  const pages: PageWorld[] = [];
  for (let i = 0; i < count; i++) {
    pages.push(await startPage({ scenario, clock, bus }));
    await clock.advance(50); // the next dashboard is opened a moment later
  }
  return { scenario, clock, bus, pages };
}

const calls = (pages: PageWorld[]) => pages.reduce((n, p) => n + p.host.log.polls.length, 0);
const polled = (p: PageWorld) => p.host.log.polls.length;

describe("Feature: the choice of the View that polls", () => {
  const peer = (id: string, rank: number, visible = true, seenAt = T0) => ({
    id,
    rank,
    visible,
    seenAt,
  });
  const table = (...ps: ReturnType<typeof peer>[]) => Object.fromEntries(ps.map((p) => [p.id, p]));

  it("Given two visible Views, Then the most recent one leads", () => {
    const self = { id: "viewaaaaaaaa", rank: 100, visible: true };
    const peers = table(peer("viewbbbbbbbb", 200));
    expect(L.electLeader(self, peers, T0)).toEqual({ leaderId: "viewbbbbbbbb", isLeader: false });
    const newer = { id: "viewbbbbbbbb", rank: 200, visible: true };
    expect(L.electLeader(newer, table(peer("viewaaaaaaaa", 100)), T0)).toEqual({
      leaderId: "viewbbbbbbbb",
      isLeader: true,
    });
  });

  it("Given equal ranks, Then the higher identifier wins on every View (all agree)", () => {
    const a = { id: "viewaaaaaaaa", rank: 5, visible: true };
    const b = { id: "viewbbbbbbbb", rank: 5, visible: true };
    expect(L.electLeader(a, table(peer(b.id, 5)), T0).leaderId).toBe(b.id);
    expect(L.electLeader(b, table(peer(a.id, 5)), T0).leaderId).toBe(b.id);
  });

  it("Given a View alone, Then it leads", () => {
    expect(L.electLeader({ id: "viewaaaaaaaa", rank: 1, visible: true }, {}, T0).isLeader).toBe(
      true,
    );
  });

  it("Given a hidden or off-screen View, Then it is never a candidate: the older visible one leads", () => {
    const self = { id: "viewaaaaaaaa", rank: 100, visible: true };
    const peers = table(peer("viewbbbbbbbb", 200, false));
    expect(L.electLeader(self, peers, T0).isLeader).toBe(true);
    // And a hidden self never leads, but still names the visible leader.
    const hidden = { id: "viewaaaaaaaa", rank: 100, visible: false };
    expect(L.electLeader(hidden, table(peer("viewbbbbbbbb", 50)), T0)).toEqual({
      leaderId: "viewbbbbbbbb",
      isLeader: false,
    });
    expect(L.electLeader(hidden, {}, T0)).toEqual({ leaderId: null, isLeader: false });
  });

  it("Given a leader that goes silent, Then it drops out after the time-to-live and the next one leads", () => {
    const cfg = L.viewConfig();
    const self = { id: "viewaaaaaaaa", rank: 100, visible: true };
    const peers = table(peer("viewbbbbbbbb", 200, true, T0));
    expect(L.electLeader(self, peers, T0 + cfg.peerTtlMs).isLeader).toBe(false);
    expect(L.electLeader(self, peers, T0 + cfg.peerTtlMs + 1).isLeader).toBe(true);
  });

  it("Given a click on 'take over here', Then the new rank beats every peer, however recent", () => {
    const peers = table(peer("viewbbbbbbbb", T0 + 5000));
    const rank = L.claimRank(peers, T0);
    expect(rank).toBeGreaterThan(T0 + 5000);
    expect(L.electLeader({ id: "viewaaaaaaaa", rank, visible: true }, peers, T0).isLeader).toBe(
      true,
    );
    expect(L.claimRank({}, T0)).toBe(T0);
  });

  it("Given messages, Then the peer table is updated, bounded, and a bye removes the peer", () => {
    let peers: any = {};
    peers = L.notePeer(peers, { t: "hello", id: "viewaaaaaaaa", rank: 1, visible: true }, T0);
    expect(Object.keys(peers)).toEqual(["viewaaaaaaaa"]);
    peers = L.notePeer(peers, { t: "bye", id: "viewaaaaaaaa", rank: 1, visible: true }, T0);
    expect(peers).toEqual({});
    for (let i = 0; i < 100; i++) {
      peers = L.notePeer(
        peers,
        { t: "hello", id: "view" + String(i).padStart(8, "0"), rank: i, visible: true },
        T0 + i,
      );
    }
    expect(Object.keys(peers).length).toBeLessThanOrEqual(L.viewConfig().maxPeers);
  });

  it("Given identifiers, Then they look like the channel expects and differ between Views", () => {
    const a = L.makeViewId(T0, 0.123456);
    const b = L.makeViewId(T0, 0.654321);
    expect(a).toMatch(/^[a-z0-9]{8,32}$/);
    expect(a).not.toBe(b);
  });
});

describe("Feature: what comes from the channel is checked", () => {
  const ok = { t: "hello", id: "viewaaaaaaaa", rank: T0, visible: true };

  it("Given a well-formed message, Then it is accepted as is", () => {
    expect(L.parseChannelMessage(ok, T0)).toEqual(ok);
    expect(L.parseChannelMessage({ t: "bye", id: "viewaaaaaaaa", rank: 5 }, T0)).toMatchObject({
      t: "bye",
    });
  });

  it.each([
    ["not an object", 42],
    ["null", null],
    ["an array", [ok]],
    ["an unknown type", { ...ok, t: "exec" }],
    ["an identifier with other characters", { ...ok, id: "view aaaa;<b>" }],
    ["a too short identifier", { ...ok, id: "abc" }],
    ["a rank that is not a number", { ...ok, rank: "9" }],
    ["a rank that is not finite", { ...ok, rank: Infinity }],
    ["a negative rank", { ...ok, rank: -1 }],
    ["a rank far in the future", { ...ok, rank: T0 + 10 * 60_000 }],
    ["a hello without visibility", { t: "hello", id: "viewaaaaaaaa", rank: T0 }],
    ["a snapshot without an answer", { t: "snapshot", id: "viewaaaaaaaa", rank: T0 }],
    [
      "a snapshot of another version",
      { t: "snapshot", id: "viewaaaaaaaa", rank: T0, poll: { v: 2 } },
    ],
  ])("Given %s, Then it is refused", (_name, data) => {
    expect(L.parseChannelMessage(data, T0)).toBeNull();
  });

  it("Given an answer that carries a balance or wallet events, Then they never leave the View", () => {
    const poll = {
      v: 1,
      state: "live",
      balance: { uec: 250000, delta: 1, since: "x" },
      events: [
        {
          seq: 1,
          type: "landed",
          group: "ship",
          confidence: "confirmed",
          at: "x",
          text: "t",
          data: {},
        },
        {
          seq: 2,
          type: "uec_changed",
          group: "wallet",
          confidence: "confirmed",
          at: "x",
          text: "The balance changed by +184500 aUEC, now 434500 aUEC.",
          data: { delta: "+184500", balance: 434500 },
        },
      ],
    };
    const shared = L.sharablePoll(poll);
    expect(JSON.stringify(shared)).not.toMatch(BALANCE_DIGITS);
    expect(shared.events.map((e: any) => e.type)).toEqual(["landed"]);
    // A snapshot that arrives with them anyway is cleaned again on reception.
    const received = L.parseChannelMessage(
      { t: "snapshot", id: "viewaaaaaaaa", rank: T0, poll },
      T0,
    );
    expect(JSON.stringify(received)).not.toMatch(BALANCE_DIGITS);
    expect(received.poll.balance).toBeUndefined();
  });
});

describe("Feature: the sanitiser rebuilds an answer without losing a field", () => {
  const strip = (poll: any) => {
    const copy = JSON.parse(JSON.stringify(poll));
    delete copy.balance;
    delete copy.hash;
    copy.events = copy.events.filter((e: any) => e.group !== "wallet");
    return copy;
  };

  it("Given answers of the story at many moments, Then cleaning them changes nothing (a new field must be added to cleanPoll)", () => {
    const s = new Scenario();
    for (const t of [3, 8, 14, 20, 40, 53, 63, 70, 85, 95, 105]) {
      s.advanceTo(t * 1000);
      const poll = strip(s.poll(true));
      expect(L.cleanPoll(poll), `at ${t} s`).toEqual(poll);
    }
  });

  it("Given an answer in which every field of the schema is filled, Then cleaning it changes nothing", () => {
    const poll = strip(fullAnswers().poll);
    expect(poll.ship.instruments.heading_deg).toBe(90);
    expect(poll.unverified.pilot).toBeDefined();
    expect(L.cleanPoll(poll)).toEqual(poll);
  });

  it("Given garbage, Then it never throws and gives null or a bounded answer", () => {
    const junk: unknown[] = [
      undefined,
      null,
      0,
      "x",
      [],
      {},
      { v: 1 },
      { v: 1, state: "nope" },
      { v: 1, state: "live", ship: "no", pilot: 4, weapons: [], events: "e", conditions: {} },
      { v: 1, state: "live", events: [null, 3, { seq: "a" }, { seq: 1, type: { x: 1 } }] },
    ];
    for (const j of junk) expect(() => L.cleanPoll(j)).not.toThrow();
    expect(L.cleanPoll({ v: 1, state: "live", ship: "no" })!.ship).toBeNull();
  });

  it("Given hostile sizes, Then lists, maps and strings are capped", () => {
    const big = "A".repeat(100_000);
    const poll: any = {
      v: 1,
      state: "live",
      cause: big,
      frame_age_ms: 5,
      weapons: {
        weapons: Array.from({ length: 5000 }, (_, i) => ({
          name: "G_" + i,
          powered: true,
          ready: true,
        })),
        countermeasures: Object.fromEntries(Array.from({ length: 500 }, (_, i) => ["k" + i, i])),
      },
      events: Array.from({ length: 5000 }, (_, i) => ({
        seq: i,
        type: "landed",
        group: "ship",
        confidence: "confirmed",
        at: big,
        text: big,
        data: { a: big, b: 1, c: 2, d: 3, e: 4, f: 5 },
      })),
      conditions: Array.from({ length: 500 }, () => ({ id: "under_fire", level: "warning" })),
      not_in_stream: Array.from({ length: 500 }, () => big),
    };
    const cleaned = L.cleanPoll(poll)!;
    expect(cleaned.cause.length).toBe(400);
    expect(cleaned.weapons.weapons).toHaveLength(64);
    expect(Object.keys(cleaned.weapons.countermeasures).length).toBeLessThanOrEqual(8);
    expect(cleaned.events).toHaveLength(60);
    expect(cleaned.events[0].text.length).toBe(200);
    expect(Object.keys(cleaned.events[0].data).length).toBeLessThanOrEqual(4);
    expect(cleaned.conditions).toHaveLength(24);
    expect(cleaned.not_in_stream).toHaveLength(40);
    expect(JSON.stringify(cleaned).length).toBeLessThan(40_000);
  });

  it("Given a name with markup or invisible characters, Then it is dropped, never passed on", () => {
    const zero = String.fromCodePoint(0x200b);
    const bidi = String.fromCodePoint(0x202e);
    const poll: any = {
      v: 1,
      state: "live",
      ship: {
        name: "<img src=x>",
        class_name: "DRAK" + zero + "_Cutter",
        manufacturer_derived: "Drake" + bidi,
      },
      pilot: { seat: "seat pilot" },
    };
    const cleaned = L.cleanPoll(poll)!;
    expect(cleaned.ship.name).toBeUndefined();
    expect(cleaned.ship.class_name).toBeUndefined();
    expect(cleaned.pilot.seat).toBeUndefined();
  });
});

describe("Feature: several dashboards call the server as one", () => {
  it("Given three dashboards in view, Then the server is called about once a second in all, not three times", async () => {
    const { pages, clock } = await views(3);
    await clock.advance(30 * SECOND);
    const before = calls(pages);
    await clock.advance(20 * SECOND);
    const perSecond = (calls(pages) - before) / 20;
    expect(perSecond).toBeGreaterThanOrEqual(0.85);
    expect(perSecond).toBeLessThanOrEqual(1.15);
  });

  it("Given the same three dashboards in a browser without BroadcastChannel, Then every one polls (the old behaviour)", async () => {
    const { pages, clock } = await views(3, { bus: null });
    await clock.advance(30 * SECOND);
    const before = calls(pages);
    await clock.advance(20 * SECOND);
    const perSecond = (calls(pages) - before) / 20;
    expect(perSecond).toBeGreaterThanOrEqual(2.5);
    for (const p of pages) expect(visibleText(p.root)).not.toContain(BANNER);
  });

  it("Given three dashboards, Then the newest polls and the older ones say they were replaced", async () => {
    const { pages, clock } = await views(3);
    await clock.advance(30 * SECOND);
    const [a, b, c] = pages as [PageWorld, PageWorld, PageWorld];
    const olderPolls = polled(a) + polled(b);
    await clock.advance(10 * SECOND);
    expect(polled(a) + polled(b)).toBe(olderPolls);
    expect(polled(c)).toBeGreaterThan(20);
    expect(visibleText(a.root)).toContain(BANNER);
    expect(visibleText(b.root)).toContain(BANNER);
    expect(visibleText(c.root)).not.toContain(BANNER);
    expect(isShown(findButton(a.root, "Reprendre ici"))).toBe(true);
  });

  it("Given a replaced dashboard, Then it still shows live data, shared by the leader, without calling the server", async () => {
    const { pages, clock } = await views(2);
    await clock.advance(30 * SECOND);
    const [a] = pages as [PageWorld, PageWorld];
    const text = visibleText(a.root);
    expect(text).toContain("En direct");
    expect(text).toContain("Cutter");
    expect(text).toMatch(/Données de \d/);
    const seen = a.root.textContent;
    await clock.advance(5 * SECOND);
    expect(a.root.textContent).not.toBe(seen); // it keeps moving
    expect(polled(a)).toBeLessThan(10);
  });

  it("Given a click on 'Reprendre ici', Then that dashboard polls again and the other one gets the banner", async () => {
    const { pages, clock } = await views(2);
    await clock.advance(20 * SECOND);
    const [a, b] = pages as [PageWorld, PageWorld];
    const before = polled(a);
    findButton(a.root, "Reprendre ici").click();
    await clock.advance(10 * SECOND);
    expect(polled(a)).toBeGreaterThan(before + 6);
    expect(visibleText(a.root)).not.toContain(BANNER);
    expect(visibleText(b.root)).toContain(BANNER);
    const b0 = polled(b);
    await clock.advance(10 * SECOND);
    expect(polled(b)).toBe(b0);
  });

  it("Given the newest dashboard is closed, Then the next one takes over at once", async () => {
    const { pages, clock } = await views(2);
    await clock.advance(20 * SECOND);
    const [a, b] = pages as [PageWorld, PageWorld];
    expect(await b.host.request("ui/resource-teardown")).toEqual({});
    const before = polled(a);
    await clock.advance(5 * SECOND);
    expect(polled(a)).toBeGreaterThanOrEqual(before + 3);
    expect(visibleText(a.root)).not.toContain(BANNER);
  });

  it("Given the newest dashboard goes silent without saying goodbye, Then the next one takes over after the time-to-live", async () => {
    const { pages, clock, bus } = await views(2);
    await clock.advance(20 * SECOND);
    const [a] = pages as [PageWorld, PageWorld];
    const lastChannel = [...bus!.channels].at(-1)!;
    lastChannel.closed = true; // deaf and mute from now on, no bye
    const before = polled(a);
    await clock.advance(4 * SECOND);
    expect(polled(a)).toBe(before); // still within the time-to-live
    await clock.advance(8 * SECOND);
    expect(polled(a)).toBeGreaterThanOrEqual(before + 4);
    expect(visibleText(a.root)).not.toContain(BANNER);
  });

  it("Given the newest dashboard is hidden or scrolled away, Then the older visible one polls; back in view, the newest leads again", async () => {
    const { pages, clock } = await views(2);
    await clock.advance(20 * SECOND);
    const [a, b] = pages as [PageWorld, PageWorld];
    b.setIntersecting(false);
    const before = polled(a);
    await clock.advance(6 * SECOND);
    expect(polled(a)).toBeGreaterThanOrEqual(before + 4);
    const bBefore = polled(b);
    b.setIntersecting(true);
    await clock.advance(10 * SECOND);
    expect(polled(b)).toBeGreaterThan(bBefore + 6);
    expect(visibleText(a.root)).toContain(BANNER);
  });

  it("Given two dashboards, Then only the leader sends the summary to the model", async () => {
    const { pages, clock } = await views(2);
    await clock.advance(120 * SECOND);
    const [a] = pages as [PageWorld, PageWorld];
    expect(a.host.log.contexts).toEqual([]);
  });
});

describe("Feature: the channel never carries the balance", () => {
  it("Given the leader shows the balance and a sale happens, Then no message on the channel contains an amount", async () => {
    const { pages, clock, bus } = await views(2);
    const [, leader] = pages as [PageWorld, PageWorld];
    await clock.advance(20 * SECOND);
    findButton(leader.root, "Afficher le solde").click();
    await clock.advance(100 * SECOND); // the sale is at 90 s
    expect(visibleText(leader.root).replace(/\s/g, " ")).toMatch(/250 000|434 500/);
    expect(bus!.log.length).toBeGreaterThan(20);
    const wire = JSON.stringify(bus!.log);
    expect(wire).not.toMatch(BALANCE_DIGITS);
    expect(wire).not.toContain("uec_changed");
    expect(wire).not.toContain('"balance"');
    // Nor does the follower ever show it.
    const [follower] = pages as [PageWorld, PageWorld];
    expect(visibleText(follower.root).replace(/\s/g, " ")).not.toMatch(BALANCE_DIGITS);
  });

  it("Given a follower, When its balance button is pressed, Then it takes over first (the balance is not shared)", async () => {
    const { pages, clock } = await views(2);
    await clock.advance(20 * SECOND);
    const [a, b] = pages as [PageWorld, PageWorld];
    findButton(a.root, "Afficher le solde").click();
    await clock.advance(5 * SECOND);
    expect(a.host.log.polls.some((p) => p.includeBalance)).toBe(true);
    expect(visibleText(b.root)).toContain(BANNER);
  });
});

describe("Feature: input from the channel cannot hurt the page", () => {
  it("Given garbage on the channel, Then nothing changes and nothing is posted to the host", async () => {
    const { pages, clock, bus } = await views(1);
    const [a] = pages as [PageWorld];
    await clock.advance(10 * SECOND);
    const posted = a.posted.length;
    const text = visibleText(a.root);
    for (const junk of [
      42,
      "x",
      null,
      { t: "hello" },
      { t: "hello", id: "x".repeat(10_000), rank: 1, visible: true },
      { t: "hello", id: "viewzzzzzzzz", rank: Number.MAX_VALUE, visible: true },
      { jsonrpc: "2.0", id: 1, method: "ping" },
      {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { displayMode: "fullscreen" },
      },
    ]) {
      bus!.inject(CHANNEL, junk);
    }
    await clock.advance(10);
    expect(a.root.attrs["data-mode"]).toBe("inline");
    expect(a.posted.length).toBe(posted);
    expect(visibleText(a.root)).toBe(text);
    expect(a.host.log.received.filter((r) => r.method === "ping")).toEqual([]);
  });

  it("Given a snapshot from a View that is not the leader, Then it is ignored", async () => {
    const { pages, clock, bus } = await views(1);
    const [a] = pages as [PageWorld];
    await clock.advance(10 * SECOND);
    const poll = new Scenario();
    poll.advanceTo(30_000);
    const evil = { ...poll.poll(false), cause: "FROM AN IMPOSTOR" };
    bus!.inject(CHANNEL, { t: "snapshot", id: "viewimpostor1", rank: 1, poll: evil });
    await clock.advance(2 * SECOND);
    expect(visibleText(a.root)).not.toContain("IMPOSTOR");
  });

  it("Given a newer 'leader' whose snapshot carries markup and invisible characters, Then it is shown as plain text or not at all", async () => {
    const { pages, clock, bus } = await views(1);
    const [a] = pages as [PageWorld];
    await clock.advance(10 * SECOND);
    bus!.inject(CHANNEL, {
      t: "hello",
      id: "viewimpostor1",
      rank: clock.now + 1000,
      visible: true,
    });
    await clock.advance(10);
    expect(visibleText(a.root)).toContain(BANNER);
    const evil = "<img src=x onerror=alert(1)>" + String.fromCodePoint(0x202e);
    const s = new Scenario();
    s.advanceTo(30_000);
    const poll: any = s.poll(false);
    poll.ship.name = evil;
    poll.ship.class_name = evil;
    poll.events = [
      {
        seq: 99999,
        type: "vehicle_changed",
        group: "ship",
        confidence: "confirmed",
        at: new Date(clock.now).toISOString(),
        text: evil,
        data: { vehicle: evil },
      },
    ];
    bus!.inject(CHANNEL, { t: "snapshot", id: "viewimpostor1", rank: clock.now + 1000, poll });
    await clock.advance(2 * SECOND);
    // The fake DOM refuses innerHTML: reaching here means none was used. The identifier was dropped, not displayed.
    expect(visibleText(a.root)).not.toContain("<img");
  });
});

describe("Feature: the fallback without BroadcastChannel", () => {
  it("Given a View away for 30 seconds, Then it retires and waits for the click; before that it resumes by itself", async () => {
    const { pages, clock } = await views(1, { bus: null });
    const [a] = pages as [PageWorld];
    await clock.advance(20 * SECOND);
    a.setHidden(true);
    await clock.advance(20 * SECOND);
    a.setHidden(false);
    const resumed = polled(a);
    await clock.advance(3 * SECOND);
    expect(polled(a)).toBeGreaterThan(resumed);
    a.setHidden(true);
    await clock.advance(31 * SECOND);
    a.setHidden(false);
    await clock.advance(5 * SECOND);
    const stopped = polled(a);
    await clock.advance(10 * SECOND);
    expect(polled(a)).toBe(stopped);
    expect(visibleText(a.root)).toContain("Vue en pause depuis longtemps");
    findButton(a.root, "Reprendre").click();
    await clock.advance(3 * SECOND);
    expect(polled(a)).toBeGreaterThan(stopped);
  });

  it("Given a browser without BroadcastChannel, Then a single View still works alone", async () => {
    const world = await startPage({ bus: null });
    expect(visibleText(world.root)).not.toContain(BANNER);
    await world.advance(10 * SECOND);
    expect(world.host.log.polls.length).toBeGreaterThan(5);
  });
});

describe("Feature: nothing is left running when a dashboard closes or hides", () => {
  it("Given a dashboard torn down by the host, Then its channel is closed after a goodbye and no timer remains", async () => {
    const { pages, clock, bus } = await views(1);
    const [a] = pages as [PageWorld];
    await clock.advance(10 * SECOND);
    expect(bus!.open).toBe(1);
    await a.host.request("ui/resource-teardown");
    await clock.advance(100);
    expect(bus!.open).toBe(0);
    expect(a.pendingTimers()).toBe(0);
    expect(bus!.log.at(-1)!.data).toMatchObject({ t: "bye" });
    const calls0 = polled(a);
    await clock.advance(30 * SECOND);
    expect(polled(a)).toBe(calls0);
  });

  it("Given a hidden dashboard, Then it keeps no timer at all (the heartbeat stops too)", async () => {
    const { pages, clock } = await views(1);
    const [a] = pages as [PageWorld];
    await clock.advance(10 * SECOND);
    a.setHidden(true);
    await clock.advance(100);
    expect(a.pendingTimers()).toBe(0);
  });

  it("Given a follower that is replaced, Then it keeps only its clock, and none once hidden", async () => {
    const { pages, clock } = await views(2);
    await clock.advance(10 * SECOND);
    const [a, b] = pages as [PageWorld, PageWorld];
    a.setHidden(true);
    b.setHidden(true);
    await clock.advance(100);
    expect(clock.timers.length).toBe(0);
  });
});
