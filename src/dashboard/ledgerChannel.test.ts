/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { transportLedger } from "./testing/ledgerScenario.js";
import {
  FakeBus,
  VirtualClock,
  findButton,
  startPage,
  visibleText,
  type PageWorld,
} from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";
import { ledgerChannelClean, ledgerStripBalance } from "./ledgerPanel.js";
import * as L from "./viewLogic.js";

/**
 * The channel between the Views of one conversation never carries the balance, nor any figure derived from it
 * (gain, total, pace, planned against measured). The ledger travels on it, stripped of all of them, and whatever
 * arrives is rebuilt and stripped again on reception.
 */

const SECOND = 1000;
const CHANNEL = L.viewConfig().channelName;
const NBSP_FREE = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const DERIVED =
  /\b184500\b|\b434500\b|\b250000\b|mesure_brute|mixed_flows|plan_compare|"gain"|"balance"/;

async function views(count: number) {
  const scenario = new Scenario();
  scenario.ledger = (include, nowMs) =>
    transportLedger(nowMs, scenario.epoch, include, "story", { expected_profit_auec: 150_000 });
  const clock = new VirtualClock(scenario.epoch);
  const bus = new FakeBus();
  const pages: PageWorld[] = [];
  for (let i = 0; i < count; i++) {
    pages.push(await startPage({ scenario, clock, bus }));
    await clock.advance(50);
  }
  return { scenario, clock, bus, pages };
}
const fullscreen = (w: PageWorld) =>
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { displayMode: "fullscreen" },
  });

describe("Feature: the ledger on the channel", () => {
  it("Given the leader shows the balance and a contract is paid, Then nothing derived from the balance is on the wire, and the follower still shows the contracts", async () => {
    const { pages, clock, bus } = await views(2);
    const [follower, leader] = pages as [PageWorld, PageWorld];
    await clock.advance(30 * SECOND);
    findButton(leader.root, "Afficher le solde").click();
    await clock.advance(75 * SECOND); // the contract is paid at 90 s, settled at 100 s
    fullscreen(leader);
    await clock.advance(2 * SECOND);
    // The leader draws the gain...
    expect(NBSP_FREE(visibleText(leader.root))).toContain("Gain mesuré");
    // ... and none of it travelled.
    expect(bus.log.length).toBeGreaterThan(20);
    const wire = JSON.stringify(bus.log);
    expect(wire).not.toMatch(DERIVED);
    // The ledger itself did travel (without amounts): the follower shows the running contract.
    expect(wire).toContain("Ore Delivery | Hard");
    expect(visibleText(follower.root)).toContain("Contrat en cours : Ore Delivery | Hard");
    fullscreen(follower);
    await clock.advance(2 * SECOND);
    const text = NBSP_FREE(visibleText(follower.root));
    expect(text).toContain("Carnet de transport");
    expect(text).not.toContain("Gain mesuré");
    expect(text).not.toMatch(/184 500|434 500|250 000/);
  });

  it("Given a 'leader' that sends a ledger with gains, a plan and a balance, Then they are dropped on reception", async () => {
    const { pages, clock, bus, scenario } = await views(1);
    const [a] = pages as [PageWorld];
    await clock.advance(10 * SECOND);
    bus.inject(CHANNEL, {
      t: "hello",
      id: "viewimpostor1",
      rank: clock.now + 1000,
      visible: true,
    });
    await clock.advance(10);
    const s = new Scenario();
    s.advanceTo(30_000);
    const poll: any = s.poll(false);
    poll.ledger = transportLedger(scenario.epoch + 118_000, scenario.epoch, true, "story", {
      expected_profit_auec: 150_000,
    });
    expect(JSON.stringify(poll.ledger)).toMatch(/184500/); // the hostile snapshot does carry amounts
    bus.inject(CHANNEL, { t: "snapshot", id: "viewimpostor1", rank: clock.now + 1000, poll });
    await clock.advance(2 * SECOND);
    fullscreen(a);
    await clock.advance(2 * SECOND);
    // The contracts of the snapshot are shown; the amounts are not, even if the follower is asked to show them.
    const text = NBSP_FREE(visibleText(a.root));
    expect(text).toContain("Waste Disposal | Easy");
    expect(text).not.toMatch(/184 500|Gain mesuré|prévu \+150/);
  });
});

describe("Feature: cleaning a ledger from the channel", () => {
  const rich = transportLedger(
    Date.UTC(2026, 10, 3, 18, 1, 58),
    Date.UTC(2026, 10, 3, 18, 0, 0),
    true,
    "story",
    {
      expected_profit_auec: 150_000,
    },
  );

  it("Given a ledger with amounts, Then the sender's strip and the receiver's clean both remove every derived field", () => {
    expect(JSON.stringify(rich)).toMatch(/gain|balance|plan_compare/);
    const sent = ledgerStripBalance(rich);
    expect(JSON.stringify(sent)).not.toMatch(DERIVED);
    const received = ledgerChannelClean(rich);
    expect(JSON.stringify(received)).not.toMatch(DERIVED);
    expect(received.contracts.length).toBe(rich.contracts.length);
    expect(received.contracts.every((c: any) => !("gain" in c))).toBe(true);
    expect(received).not.toHaveProperty("balance");
    expect(received).not.toHaveProperty("plan_compare");
  });

  it("Given anything that is not a ledger, Then nothing is kept; given a cleaned ledger, Then cleaning it again changes nothing", () => {
    for (const bad of [null, undefined, 4, "x", [], { v: 3 }])
      expect(ledgerChannelClean(bad)).toBeNull();
    const once = ledgerChannelClean(rich);
    expect(ledgerChannelClean(once)).toEqual(once);
  });
});
