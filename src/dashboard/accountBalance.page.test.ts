/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import {
  FakeBus,
  VirtualClock,
  findAll,
  findButton,
  isShown,
  startPage,
  visibleText,
  type FakeNode,
  type PageWorld,
} from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";

/**
 * The permanent "Solde" reminder in the header of the assembled page, against the fake host. The account balance is an
 * invented 8 675 309 aUEC (the scenario's own balance is 250 000 / 434 500, never matched here). Every check on an amount
 * looks for the WHOLE figure.
 */

const SECOND = 1000;
const HOUR = 3_600_000;
const BAL = 8675309;
const WHOLE = /(?<![\d])8 675 309(?![\d])/;
const NB = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

type Account = Record<string, unknown> | null;

/** A page whose server answers `account` (only to a poll that asked for the balance, as the real one does). */
async function page(
  account: (now: number) => Account,
  options: Parameters<typeof startPage>[0] = {},
  always = false,
) {
  const scenario = options.scenario ?? new Scenario();
  const w = await startPage({ balanceHidden: false, ...options, scenario });
  w.host.overrides.poll = (base: any, include: boolean) => {
    const a = include || always ? account(scenario.now) : null;
    return a ? { ...base, account: a } : base;
  };
  await w.advance(10 * SECOND);
  return w;
}

const fullscreen = async (w: PageWorld) => {
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { displayMode: "fullscreen" },
  });
  await w.advance(100);
};

const zone = (w: PageWorld): FakeNode =>
  findAll(w.root, (n) => n.className.split(" ").includes("acct"))[0]!;
const zoneText = (w: PageWorld) => NB(visibleText(zone(w)));
/** Every string the page holds, attributes included, hidden nodes included. */
function everything(root: FakeNode): string {
  const parts: string[] = [];
  for (const n of findAll(root, () => true)) {
    if (n.children.length === 0) parts.push(n.textContent);
    parts.push(...Object.values(n.attrs));
  }
  return NB(parts.join("\n"));
}
/** What every status region of the page holds (the page has a few: the stream state, the order, the session notices). */
const region = (w: PageWorld) => ({
  textContent: findAll(w.root, (n) => n.attrs["role"] === "status" && n.className === "sr-only")
    .map((n) => n.textContent)
    .join(" | "),
});
describe("Feature: the account balance is a permanent reminder in the header", () => {
  it.each([
    ["compact view", false],
    ["full screen", true],
  ])("Given a live reading, Then the header says 'Solde' and the amount (%s)", async (_l, full) => {
    const w = await page(() => ({ source: "live", uec: BAL }));
    if (full) await fullscreen(w);
    const header = w.root.children[0]!;
    expect(header.className).toBe("top");
    expect(findAll(header, (n) => n === zone(w))).toHaveLength(1);
    expect(isShown(zone(w))).toBe(true);
    expect(zoneText(w)).toMatch(/Solde/);
    expect(zoneText(w)).toMatch(WHOLE);
    expect(zoneText(w)).toContain("Masquer le solde");
    expect(zone(w).attrs["data-kind"]).toBe("live");
    // The header holds the control once, next to the amount: the old compact row is gone, not duplicated.
    expect(
      findAll(header, (n) => n.tag === "button" && n.textContent === "Masquer le solde"),
    ).toHaveLength(1);
    expect(findAll(w.root, (n) => n.className.split(" ").includes("balance-row"))).toHaveLength(0);
  });

  it("Given the game closed and a balance saved 15 hours ago, Then it is the last known balance, labelled with its age", async () => {
    const scenario = new Scenario();
    const w = await page(
      (now) => ({
        source: "last_known",
        uec: BAL,
        at: new Date(now - 15 * HOUR).toISOString(),
        from: "session",
      }),
      { scenario },
    );
    await fullscreen(w);
    expect(zoneText(w)).toMatch(WHOLE);
    expect(zoneText(w)).toContain("dernier solde connu · il y a 15 h");
    expect(zone(w).attrs["data-kind"]).toBe("last_known");
  });

  it("Given no reading with the game closed, Then 'Solde inconnu' with the reason and no figure", async () => {
    const w = await page(() => ({ source: "unknown", reason: "game_closed" }));
    expect(zoneText(w)).toContain("Solde inconnu");
    expect(zoneText(w)).toContain("jeu fermé");
    expect(zoneText(w)).not.toMatch(/\d/);
  });

  it("Given telemetry switched off on the server, Then it says so instead of a balance", async () => {
    const scenario = new Scenario();
    scenario.forced = "off";
    const w = await startPage({ scenario, balanceHidden: false });
    await w.advance(10 * SECOND);
    expect(zoneText(w)).toContain("Solde inconnu");
    expect(zoneText(w)).toContain("télémétrie non activée");
  });

  it("Given the reading is independent of any session, Then it does not change with a new session", async () => {
    const w = await page(() => ({ source: "live", uec: BAL }));
    w.host.overrides.poll = (base: any, include: boolean) => ({
      ...base,
      ...(include ? { account: { source: "live", uec: BAL } } : {}),
      sessions: { v: 1, status: "ok", notice: null, gap_hours: 3, current: null, stale: false },
    });
    await w.advance(5 * SECOND);
    expect(zoneText(w)).toMatch(WHOLE);
  });
});

describe("Feature: the reminder obeys the balance choice, in every way of hiding", () => {
  it("Given SC_BALANCE=hidden at the start, Then no amount is anywhere in the page, even if a server sent one", async () => {
    const w = await page(() => ({ source: "live", uec: BAL }), { balanceHidden: true }, true);
    expect(zoneText(w)).toContain("••••••");
    expect(zoneText(w)).toContain("masqué");
    expect(zoneText(w)).toContain("Afficher le solde");
    expect(everything(w.root)).not.toMatch(WHOLE);
    await fullscreen(w);
    expect(everything(w.root)).not.toMatch(WHOLE);
    expect(w.host.log.polls.every((p) => !p.includeBalance)).toBe(true);
  });

  it("Given the player clicks 'Masquer le solde', Then the amount is gone from the whole page, and 'Afficher' brings it back", async () => {
    const w = await page(() => ({ source: "live", uec: BAL }));
    expect(zoneText(w)).toMatch(WHOLE);
    findButton(zone(w), "Masquer le solde").click();
    await w.advance(3 * SECOND);
    expect(zone(w).attrs["data-kind"]).toBe("hidden");
    expect(everything(w.root)).not.toMatch(WHOLE);
    findButton(zone(w), "Afficher le solde").click();
    await w.advance(3 * SECOND);
    expect(zoneText(w)).toMatch(WHOLE);
  });

  it("Given the balance is hidden again while a poll with the balance is in flight, Then it does not come back", async () => {
    const w = await page(() => ({ source: "live", uec: BAL }), {}, true);
    w.host.hold.on = true;
    await w.advance(2 * SECOND);
    findButton(zone(w), "Masquer le solde").click();
    await w.advance(1 * SECOND);
    w.host.releasePolls();
    await w.advance(3 * SECOND);
    expect(everything(w.root)).not.toMatch(WHOLE);
  });

  it("Given the balance is shown, Then no automatic message to the model and no context holds it", async () => {
    const w = await page(() => ({ source: "live", uec: BAL }));
    await w.advance(100 * SECOND);
    expect(w.host.log.messages).toEqual([]);
    for (const c of w.host.log.contexts) expect(NB(c)).not.toMatch(WHOLE);
  });
});

describe("Feature: the screen reader is told only when the kind of reading changes", () => {
  it("Given an amount that changes at each poll, Then the status region is never written", async () => {
    let n = 0;
    const w = await page(() => ({ source: "live", uec: BAL + n++ }));
    const before = region(w).textContent;
    await w.advance(30 * SECOND);
    expect(zoneText(w)).toMatch(/\d/);
    expect(region(w).textContent).toBe(before);
    expect(region(w).textContent).not.toMatch(/8\s?675/);
  });

  it("Given a live reading that becomes a last known one, Then the region says it once, without the amount", async () => {
    let live = true;
    const w = await page((now) =>
      live
        ? { source: "live", uec: BAL }
        : {
            source: "last_known",
            uec: BAL,
            at: new Date(now - HOUR).toISOString(),
            from: "stream",
          },
    );
    live = false;
    await w.advance(5 * SECOND);
    expect(region(w).textContent).toContain("Solde : dernier solde connu");
    expect(NB(region(w).textContent)).not.toMatch(WHOLE);
    const said = region(w).textContent;
    await w.advance(20 * SECOND);
    expect(region(w).textContent).toBe(said);
  });

  it("Given the page, Then it still has no more than three live regions", async () => {
    const w = await page(() => ({ source: "live", uec: BAL }));
    expect(findAll(w.root, (n) => n.attrs["aria-live"] !== undefined).length).toBeLessThanOrEqual(
      3,
    );
    // The value of a hidden balance is dots: not read out.
    findButton(zone(w), "Masquer le solde").click();
    await w.advance(3 * SECOND);
    const value = findAll(zone(w), (n) => n.className === "acct-value")[0]!;
    expect(value.attrs["aria-hidden"]).toBe("true");
  });
});

describe("Feature: the channel between dashboards never carries the reminder", () => {
  it("Given a leader that shows the balance and a follower, Then no message on the channel holds the amount", async () => {
    const scenario = new Scenario();
    const clock = new VirtualClock(scenario.epoch);
    const bus = new FakeBus();
    const pages: PageWorld[] = [];
    for (let i = 0; i < 2; i++) {
      const w = await startPage({ scenario, clock, bus, balanceHidden: false });
      w.host.overrides.poll = (base: any, include: boolean) =>
        include ? { ...base, account: { source: "live", uec: BAL } } : base;
      pages.push(w);
      await clock.advance(50);
    }
    await clock.advance(20 * SECOND);
    const [follower, leader] = pages as [PageWorld, PageWorld];
    expect(NB(visibleText(leader.root))).toMatch(WHOLE);
    expect(bus.log.length).toBeGreaterThan(10);
    const wire = JSON.stringify(bus.log);
    expect(wire).not.toMatch(/(?<![\d])8675309(?![\d])/);
    expect(wire).not.toContain('"account"');
    // The follower never shows it.
    expect(everything(follower.root)).not.toMatch(WHOLE);
  });
});
